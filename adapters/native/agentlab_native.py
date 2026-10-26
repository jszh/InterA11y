from __future__ import annotations
from final_assessment_validation import image_artifact_ids
import time
RUN_BOOT_AT = time.monotonic()
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
import hashlib
import fcntl
import io
import json
import logging
import os
from pathlib import Path
import re
import select
import signal
import subprocess
import sys
from runtime_slots import acquire_slot, release_slot
from episode_timeout import parse_episode_timeout, episode_deadline
from provider_timeout import gemini_http_timeout_ms
from native_element_references import POLICY as REFERENCE_POLICY, ReferenceLedger, browsergym_snapshot, tool_paths, TOOL_TARGET_POLICY
from call_timing import TimingLedger, VERSION as TIMING_VERSION, write_run_infrastructure
from contextlib import nullcontext
from comparison_prompt import EXPERT_TARGET_POLICY, RUBRIC_SNAPSHOT, task_prompt, prompt_id, prompt_record, check_saved_prompt, parse_condition, normalize_gena11y_assessment, GENA11Y_PROMPT, check_output_prompt, default_judgment_prompt, check_output_protocol
from dotenv import load_dotenv
ROOT = Path(__file__).resolve().parents[2]
NATIVE = Path(__file__).resolve().parent
load_dotenv(ROOT / '.env')
import bgym
import browsergym.core
from browsergym.utils.obs import flatten_axtree_to_str, flatten_dom_to_str, prune_html
from agentlab.agents.agent_args import AgentArgs
import compat_types as types
import gymnasium as gym
from PIL import Image
from agentlab_runtime import install as install_runtime, REVISION
from agentlab_memory import EpisodeMemory, MemoryDecisionPrompt, POLICY as MEMORY_POLICY
from openrouter_google_compat import OpenRouterGoogleCompat
from execution_health import terminal_code, ensure_provider_available, browser_startup, native_failure
from final_assessment_validation import final_assessment_error, parse_decision_object, COMPLETION_POLICY
ACTION_SUBSETS = ['bid', 'coord', 'nav', 'tab', 'chat']
MODEL = None
TIMING_LEDGER = None

class InvalidFinalBudgetExceeded(RuntimeError):
    pass

def timing_span(kind, name, **metadata):
    return TIMING_LEDGER.span(kind, name, **metadata) if TIMING_LEDGER else nullcontext({})

def split_tool_images(value, images, image_dir):
    if isinstance(value, dict):
        return {k: split_tool_images(v, images, image_dir) for k, v in value.items()}
    if isinstance(value, list):
        return [split_tool_images(v, images, image_dir) for v in value]
    if isinstance(value, str):
        match = re.match('^data:image/(png|jpeg|jpg);base64,(.*)$', value, re.S)
        raw = match.group(2) if match else value
        if len(raw) > 1000 and (raw.startswith('iVBORw0KGgo') or raw.startswith('/9j/')):
            data = base64.b64decode(raw)
            mime = 'image/png' if raw.startswith('iVBORw0KGgo') else 'image/jpeg'
            ext = 'png' if mime == 'image/png' else 'jpg'
            image_dir.mkdir(parents=True, exist_ok=True)
            file = image_dir / f'{hashlib.sha1(data).hexdigest()[:20]}.{ext}'
            if not file.exists():
                file.write_bytes(data)
            images.append((data, mime))
            return {'imageFile': str(file), 'bytes': len(data), 'note': f'image {len(images)} attached to next model call'}
    return value

class ToolBridge:

    def __init__(self, url, log_path):
        self.log_path = Path(log_path)
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        self.stderr_file = self.log_path.open('ab')
        with browser_startup(TIMING_LEDGER):
            self.proc = subprocess.Popen(['node', str(NATIVE / 'browser-use-tool-bridge.js'), url, '--timing-v2'], cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.stderr_file, env={**os.environ, 'A11Y_BROWSER_STARTUP_SLOTS': '0'}, text=True, bufsize=1)
            try:
                ready = self._readline(210)
                if not json.loads(ready).get('ready'):
                    raise RuntimeError('InterA11y tool bridge failed to start')
            except BaseException:
                self.close()
                raise

    def _readline(self, timeout):
        if not select.select([self.proc.stdout], [], [], timeout)[0]:
            raise TimeoutError('InterA11y tool bridge timed out')
        line = self.proc.stdout.readline()
        if not line:
            detail = self.log_path.read_text(errors='replace')[-4000:]
            raise RuntimeError('InterA11y tool bridge exited: ' + detail)
        return line

    def call(self, name, args):
        self.last_timing = None
        self.last_dispatch_wait_ms = 0
        try:
            args, native_targets = self.references.prepare_tool_targets(args, retained_state=bool(args.get('stateId') and args['stateId'] != 'new'))
        except ValueError as exc:
            return {'error': str(exc), 'targetPolicy': TOOL_TARGET_POLICY, 'stage': 'native-observation'}
        dispatched_at = time.time() * 1000
        context_file = self.log_path.parent / 'native-tool-context.json'
        native_context = json.loads(context_file.read_text()) if context_file.exists() else None
        self.proc.stdin.write(json.dumps({'name': name, 'args': args, 'nativeTargets': native_targets, 'nativeContext': native_context}) + '\n')
        self.proc.stdin.flush()
        payload = json.loads(self._readline(190))
        self.last_timing = payload.get('timing') if payload.get('bridgeProtocol') == 2 else None
        self.last_dispatch_wait_ms = max(0, payload.get('startedAtUnixMs', dispatched_at) - dispatched_at)
        return payload['result'] if payload.get('bridgeProtocol') == 2 else payload

    def close(self):
        if self.proc.poll() is None:
            self.proc.stdin.close()
            try:
                self.proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        self.stderr_file.close()

def stem_of(case_id, sc):
    digest = hashlib.sha1(f'{case_id}|{sc}'.encode()).hexdigest()[:12]
    safe = re.sub('[^a-zA-Z0-9_.-]+', '_', case_id)[:100]
    return f'{safe}-{sc}-{digest}'

def decision_schema(tools, force_final=False, gena11y=False):
    text = {'type': 'string'}
    final = {'type': 'object', 'properties': {'kind': {'type': 'string', 'enum': ['final']}, 'verdict': {'type': 'string', 'enum': ['PASS', 'FAIL', 'UNDETERMINED']}, 'evidence': text, 'justification': text, 'findings': {'type': 'array', 'items': {'type': 'object', 'properties': {'element_ref': {'type': 'string', 'minLength': 1}, 'observation_step': {'type': ['integer', 'null']}, 'evidence': text, 'reason': text}, 'required': ['element_ref', 'evidence', 'reason']}}}, 'required': ['kind', 'verdict', 'evidence', 'justification', 'findings']}
    if gena11y:
        final = {**GENA11Y_PROMPT['schema'], 'properties': {'kind': {'type': 'string', 'enum': ['final']}, **GENA11Y_PROMPT['schema']['properties']}, 'required': ['kind', *GENA11Y_PROMPT['schema']['required']]}
    final['properties']['memory'] = text
    if force_final:
        return final
    branches = [{'type': 'object', 'properties': {'kind': {'type': 'string', 'enum': ['action']}, 'action': text, 'reason': text, 'memory': text}, 'required': ['kind', 'action', 'reason', 'memory']}, final]
    branches += [{'type': 'object', 'properties': {'kind': {'type': 'string', 'enum': ['tool']}, 'name': {'type': 'string', 'enum': [tool['name']]}, 'arguments': tool['parameters'], 'reason': text, 'memory': text}, 'required': ['kind', 'name', 'arguments', 'reason', 'memory']} for tool in tools]
    return {'anyOf': branches}

@dataclass
class A11yEnvArgs(bgym.EnvArgs):
    chrome_path: str = '/usr/bin/google-chrome'

    def make_env(self, action_mapping, exp_dir, exp_task_kwargs=None, use_raw_page_output=False):
        kwargs = dict(self.task_kwargs or {})
        kwargs.update(exp_task_kwargs or {})
        os.environ['A11Y_NATIVE_CHROME_PATH'] = self.chrome_path
        with timing_span('infra', 'browsergym-env-construction'):
            env = gym.make('browsergym/openended', disable_env_checker=True, max_episode_steps=self.max_steps, headless=self.headless, wait_for_user_message=False, viewport=self.viewport, task_kwargs=kwargs, action_mapping=action_mapping, use_raw_page_output=use_raw_page_output, pw_chromium_kwargs={'executable_path': str(NATIVE / 'browsergym-native-chrome.py')})
        wrapped = InteractionLogEnv(env, Path(exp_dir) / 'browser-interactions.jsonl')
        return wrapped

class InteractionLogEnv(gym.Wrapper):

    def __init__(self, env, path):
        super().__init__(env)
        self.trace_path = path
        self.trace_path.parent.mkdir(parents=True, exist_ok=True)
        self.trace_step = 0

    def _publish_native_context(self):
        native = self.env.unwrapped
        cdp = native.context.new_cdp_session(native.page)
        try:
            command = cdp.send('Browser.getBrowserCommandLine')['arguments']
            profile = next((x.split('=', 1)[1] for x in command if x.startswith('--user-data-dir=')))
            port, route = (Path(profile) / 'DevToolsActivePort').read_text().splitlines()[:2]
            target = cdp.send('Target.getTargetInfo')['targetInfo']['targetId']
            context = {'endpoint': 'ws://127.0.0.1:' + port + route, 'targetId': target}
            (self.trace_path.parent / 'native-tool-context.json').write_text(json.dumps(context))
        finally:
            cdp.detach()

    def step(self, action):
        with timing_span('tool', 'browsergym-action', action=action) as call:
            value = self._step(action)
            if value[0].get('last_action_error') and TIMING_LEDGER:
                TIMING_LEDGER.exclude(call, 'native-action-error')
            return value

    def reset(self, **kwargs):
        with timing_span('infra', 'browsergym-reset'):
            value = self.env.reset(**kwargs)
            self._publish_native_context()
            return value

    def close(self):
        with timing_span('infra', 'browsergym-teardown'):
            return self.env.close()

    def _step(self, action):
        self.trace_step += 1
        started = time.monotonic()
        record = {'step': self.trace_step, 'action': action, 'timestamp': time.time()}
        try:
            value = self.env.step(action)
            obs = value[0]
            self._publish_native_context()
            record.update(status='error' if obs.get('last_action_error') else 'returned', error=obs.get('last_action_error'), url=obs.get('url'), focusedElementBid=obs.get('focused_element_bid'), terminated=value[2], truncated=value[3])
            return value
        except Exception as exc:
            record.update(status='exception', error=f'{type(exc).__name__}: {exc}')
            raise
        finally:
            record['durationMs'] = round((time.monotonic() - started) * 1000)
            with self.trace_path.open('a') as log:
                log.write(json.dumps(record, ensure_ascii=False) + '\n')

@dataclass
class A11yAgentArgs(AgentArgs):
    agent_name: str = 'AgentLab-1'
    task_text: str = ''
    result_path: str = ''
    model: str = MODEL
    effort: str = 'high'
    max_steps: int = 100
    condition: int | str = 1
    page_url: str = ''
    tool_declarations: list | None = None

    def make_agent(self):
        return A11yAgent(self.task_text, Path(self.result_path), self.model, self.effort, self.max_steps, self.condition, self.page_url, self.tool_declarations or [])

class A11yAgent(bgym.Agent):

    def __init__(self, task_text, result_path, model, effort, max_steps, condition, page_url, tool_declarations):
        self.task_text = task_text
        self.result_path = result_path
        self.model = model
        self.effort = effort
        self.max_steps = max_steps
        self.condition = condition
        self.tool_declarations = tool_declarations
        self.tool_names = {tool['name'] for tool in tool_declarations}
        self.deadline = float(os.environ.get('AGENTLAB_EPISODE_DEADLINE', 'inf'))
        with timing_span('infra', 'specialist-browser-setup'):
            self.bridge = ToolBridge(page_url, self.result_path.parent / 'tool-bridge.stderr.log') if condition == 2 else None
        self.action_set = bgym.HighLevelActionSet(ACTION_SUBSETS, multiaction=False, strict=True)
        self.client = OpenRouterGoogleCompat(os.environ['OPENROUTER_API_KEY'], self.effort, TIMING_LEDGER)
        self.reset()

    def reset(self, seed=None):
        self.step_count = 0
        self.actions = []
        self.model_calls = 0
        self.model_requests = 0
        self.prompt_tokens = 0
        self.output_tokens = 0
        self.thinking_tokens = 0
        self.cached_tokens = 0
        self.invalid_decisions = []
        self.tool_calls = []
        self.tool_observations = []
        self.episode_memory = EpisodeMemory()
        self.pending_images = []
        self.last_model_span = None
        self.raw_assessment = None
        self.references = ReferenceLedger(self.result_path.parent / 'native-references.jsonl')
        if self.bridge:
            self.bridge.references = self.references
        self.invalid_finals = 0
        self.reference_corrections = 0
        self.pending_validation_error = ''
        self.started_at = time.monotonic()
        self._checkpoint()

    def obs_preprocessor(self, obs):
        obs = dict(obs)
        props = obs['extra_element_properties']
        obs['axtree_txt'] = flatten_axtree_to_str(obs['axtree_object'], extra_properties=props)
        obs['pruned_html'] = prune_html(flatten_dom_to_str(obs['dom_object'], extra_properties=props))
        return obs

    def _usage(self, response):
        if '/' in self.model:
            usage = self._api_summary()
            self.prompt_tokens = usage['inputTokens'] or 0
            self.output_tokens = usage['outputTokens'] or 0
            self.thinking_tokens = usage['thinkingTokens'] or 0
            self.cached_tokens = usage['cachedTokens'] or 0
            return
        usage = response.usage_metadata
        if usage:
            self.prompt_tokens += usage.prompt_token_count or 0
            self.output_tokens += usage.candidates_token_count or 0
            self.thinking_tokens += usage.thoughts_token_count or 0
            self.cached_tokens += usage.cached_content_token_count or 0

    def _api_summary(self):
        current = self.client.api_summary()
        return current

    def _decision(self, obs, force_final=False, validation_error=''):
        mode = 'You have reached the episode resource limit. Return a final assessment now.' if force_final else 'Choose one available action or return a final assessment.'
        if self.condition == 2:
            capability = 'You are using AgentLab with BrowserGym browser actions and the listed InterA11y evidence tools. Choose what evidence to collect yourself. State-preserving tools measure the current native page, so native actions and tool actions share state. Destructive instruments require an explicit isolated stateId:new; reuse its returned ID to continue that isolated workflow.\n\nFor evidence-tool element arguments named XPath, you may use a current native bid:a12 or unique observed css:<selector>. The bridge verifies uniqueness and translates before measurement.\n\nInterA11y evidence tools (arguments must match the JSON schema):\n' + json.dumps(self.tool_declarations, ensure_ascii=False) + '\n\n'
            tool_format = 'For an evidence tool: {"kind":"tool","name":"query_ax_node","arguments":{"targetXpath":"/html/body/..."},"reason":"why","memory":"observations to retain"}. '
        else:
            capability = 'You are using AgentLab with BrowserGym. You may use only the browser actions listed below. You have no JavaScript evaluation, Playwright, DOM query, accessibility measurement, or InterA11y custom action. Decide what to inspect and interact with yourself.\n\n'
            tool_format = ''
        before = f"{self.task_text}\n\n{capability}{self.action_set.describe(with_long_description=False)}\n\nCurrent URL: {obs.get('url', '')}\nFocused element bid: {obs.get('focused_element_bid')}\nLast action error: {obs.get('last_action_error')}\n"
        if self.condition != '0b':
            before += f'Current observation step: {self.step_count}\nFor each finding, prefer the observed BrowserGym BID as element_ref, e.g. bid:a12. You may also report css:<selector> or xpath:<selector> when it identifies exactly one observed element. The harness verifies uniqueness in the recorded DOM and translates references after judgment. Do not guess a selector or report an ambiguous reference. observation_step may select an earlier observation; null means current.\n'
        after = self.episode_memory.instructions() + f"""\nA final answer reports completed observations. Pending inspection or measurement belongs in an action/tool decision; UNDETERMINED must explain an actual obstacle.\n{mode}\nReply as a single JSON object. For an action: {{"kind":"action","action":"click('a12')","reason":"why","memory":"observations to retain"}}. {tool_format}For a final answer: {{"kind":"final","verdict":"PASS|FAIL|UNDETERMINED","evidence":"observations","justification":"criterion reasoning","findings":[{{"xpath":"full XPath or null","evidence":"observation","reason":"why it fails"}}]}}. Do not invent an XPath. Report an XPath only when it identifies the element you observed to fail.\n""" + (f'Your previous output was invalid: {validation_error}\n' if validation_error else '')
        recent = self.episode_memory.records[-2:]
        if len(recent) == 2 and all((isinstance(r['action'], str) and r['action'].strip().startswith('noop(') and (r.get('before') == r.get('after')) for r in recent)):
            after += 'The last two noop waits returned the same recorded browser state. A noop only waits; describing a tool in reason or memory does not execute it. If you intend an evidence call, emit kind=tool with its name and arguments; if you intend browser interaction, emit the corresponding native action. If another wait is necessary, explain what pending page change you expect.\n'
        if self.condition == '0b':
            old = 'For a final answer: {"kind":"final","verdict":"PASS|FAIL|UNDETERMINED","evidence":"observations","justification":"criterion reasoning","findings":[{"xpath":"full XPath or null","evidence":"observation","reason":"why it fails"}]}. Do not invent an XPath. Report an XPath only when it identifies the element you observed to fail.'
            new = 'For a final answer: {"kind":"final","verdict":"REPRODUCED|NOT REPRODUCED|PARTIAL","confidence":"high|medium|low","violations":[{"xpath":"full XPath or null","outerHTML":"opening tag","reason":"why it violates the criterion","recommendation":"how to fix"}],"summary":"findings"}. The kind field is the browser-agent protocol wrapper for the original GenA11y final answer. Copy observed XPaths; do not invent them.'
            assert old in after
            after = after.replace(old, new)
        else:
            after = after.replace('"xpath":"full XPath or null"', '"element_ref":"bid:a12","observation_step":null')
            after = after.replace('Do not invent an XPath. Report an XPath only when it identifies the element you observed to fail.', 'Identify each observed failing element uniquely. Prefer native BIDs; the harness verifies and translates CSS/XPath selectors.')
        prompt = MemoryDecisionPrompt(before, after, obs, self.episode_memory).fit()
        buffer = io.BytesIO()
        Image.fromarray(obs['screenshot']).save(buffer, format='PNG')
        contents = [types.Part.from_text(text=prompt), types.Part.from_bytes(data=buffer.getvalue(), mime_type='image/png')]
        contents += [types.Part.from_bytes(data=data, mime_type=mime) for data, mime in self.pending_images]
        max_attempts = max(1, int(os.environ.get('A11Y_HTTP_MAX_ATTEMPTS', '1' if '/' in self.model else '2')))
        for attempt in range(max_attempts):
            remaining = self.deadline - time.monotonic()
            if remaining <= 10:
                raise TimeoutError('Episode time budget exhausted before model request')
            self.model_requests += 1
            prompt_dir = self.result_path.parent / 'decision-prompts'
            prompt_dir.mkdir(parents=True, exist_ok=True)
            prompt_file = prompt_dir / f'request-{self.model_requests:04d}.txt'
            prompt_file.write_text(prompt)
            self._checkpoint()
            try:
                with timing_span('llm-group' if '/' in self.model else 'llm', 'openrouter-model-call' if '/' in self.model else 'gemini-generate-content', modelRequest=self.model_requests) as model_span:
                    self.last_model_span = model_span
                    response = self.client.models.generate_content(model=self.model, contents=contents, config=types.GenerateContentConfig(temperature=0, response_mime_type='application/json', **{'max_output_tokens': int(os.environ['A11Y_GEMINI_NATIVE_OUTPUT_LIMIT'])} if '/' not in self.model and os.environ.get('A11Y_OUTPUT_TOKEN_POLICY') == 'provider-maximum' else {}, http_options=types.HttpOptions(timeout=gemini_http_timeout_ms(remaining)), response_json_schema=decision_schema(self.tool_declarations, force_final, self.condition == '0b'), tool_config=types.ToolConfig(function_calling_config=types.FunctionCallingConfig(mode='NONE')), automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True), thinking_config=types.ThinkingConfig(thinking_level=self.effort.upper())))
                    if not response.text or not response.text.strip():
                        if TIMING_LEDGER:
                            TIMING_LEDGER.exclude(model_span, 'empty-model-response')
            except Exception as exc:
                if terminal_code(exc) or attempt + 1 >= max_attempts:
                    raise
                with timing_span('wait', 'provider-backoff'):
                    time.sleep(min(8, 2 ** attempt))
                continue
            self.model_calls += 1
            self._usage(response)
            raw = response.text
            self.result_path.parent.mkdir(parents=True, exist_ok=True)
            with (self.result_path.parent / 'model-responses.jsonl').open('a') as log:
                log.write(json.dumps({'modelCall': self.model_calls, 'modelRequest': self.model_requests, 'promptFile': str(prompt_file.relative_to(self.result_path.parent)), 'memoryPrompt': self.episode_memory.last_prompt_stats, 'timing': {k: v for k, v in model_span.items() if not k.startswith('_')}, 'response': response.model_dump(mode='json', exclude_none=True)}, ensure_ascii=False) + '\n')
            self._checkpoint()
            if raw and raw.strip():
                break
            if attempt + 1 < max_attempts:
                with timing_span('wait', 'empty-response-backoff'):
                    time.sleep(2 ** attempt)
        else:
            reasons = [str(c.finish_reason) for c in response.candidates or []]
            raise RuntimeError(f'Gemini returned no decision text; finishReasons={reasons}; promptFeedback={response.prompt_feedback}')
        decision = parse_decision_object(raw)
        self.pending_images = []
        return decision

    def _checkpoint(self, assessment=None, reason='', final=False):
        model_cost = None
        record = {'assessment': assessment, 'actions': self.actions, 'toolCalls': self.tool_calls, 'agentError': reason or None, 'invalidDecisions': self.invalid_decisions, 'steps': self.step_count, 'decisionSteps': self.step_count + len(self.tool_calls), 'modelCalls': self.model_calls, 'modelRequests': self.model_requests, 'usage': {'total_prompt_tokens': self.prompt_tokens, 'total_completion_tokens': self.output_tokens, 'thinking_tokens': self.thinking_tokens, 'cached_content_tokens': self.cached_tokens, 'output_includes_thinking': '/' in self.model, 'cache_usage_captured': True}, 'estimatedModelCostUsd': model_cost, 'usageAllAttempts': self._api_summary() if '/' in self.model else None, 'apiCostUsd': self._api_summary()['apiCostUsd'] if '/' in self.model else None, 'agentMs': round((time.monotonic() - self.started_at) * 1000), 'runtimeRevision': REVISION, 'complete': final}
        record['memoryPolicy'] = MEMORY_POLICY
        record['memoryState'] = self.episode_memory.state()
        record['pendingImages'] = [{'imageFile': str(self.result_path.parent / 'tool-images' / (hashlib.sha1(data).hexdigest()[:20] + ('.png' if mime == 'image/png' else '.jpg'))), 'mimeType': mime} for data, mime in self.pending_images]
        record['rawAssessment'] = self.raw_assessment
        record['nativeReferencePolicy'] = REFERENCE_POLICY
        record['nativeReferenceTrace'] = str(self.references.path)
        target = self.result_path if final else self.result_path.parent / 'progress.json'
        target.parent.mkdir(parents=True, exist_ok=True)
        temp = target.with_suffix('.json.tmp')
        temp.write_text(json.dumps(record, ensure_ascii=False))
        temp.replace(target)

    def _finish(self, decision, reason=''):
        self.raw_assessment = json.loads(json.dumps(decision))
        if self.condition == '0b' and decision.get('verdict') in ('REPRODUCED', 'NOT REPRODUCED', 'PARTIAL'):
            self.raw_assessment = {k: v for k, v in decision.items() if k != 'kind'}
            decision = normalize_gena11y_assessment(decision)
        elif self.condition == '0b' and decision.get('kind') == 'final':
            raise ValueError("Condition 0b requires GenA11y's original verdict schema")
        verdict = decision.get('verdict')
        if verdict not in ('PASS', 'FAIL', 'UNDETERMINED'):
            verdict = 'UNDETERMINED'
        findings = decision.get('findings')
        if not isinstance(findings, list):
            findings = []
        findings = [{'xpath': f.get('xpath') if isinstance(f.get('xpath'), str) else None, 'element_ref': f.get('element_ref'), 'observation_step': f.get('observation_step'), 'evidence': str(f.get('evidence') or ''), 'reason': str(f.get('reason') or '')} for f in findings if isinstance(f, dict)]
        assessment = {'verdict': verdict, 'evidence': str(decision.get('evidence') or reason), 'justification': str(decision.get('justification') or reason), 'findings': findings}
        with timing_span('infra', 'post-output-reference-translation', passive=True):
            assessment = self.references.translate(assessment, 'al', tool_paths([c.get('result') for c in self.tool_calls]))
        self._checkpoint(assessment, reason, final=True)
        if self.bridge:
            with timing_span('infra', 'specialist-browser-teardown'):
                self.bridge.close()
        return (None, bgym.AgentInfo(think=assessment['justification'][:2000], stats={'modelCalls': self.model_calls, 'promptTokens': self.prompt_tokens, 'outputTokens': self.output_tokens}, extra_info={'assessment': assessment}))

    def _reject_last_model(self):
        if TIMING_LEDGER and self.last_model_span:
            TIMING_LEDGER.exclude(self.last_model_span, 'invalid-decision')

    def get_action(self, obs):
        self.episode_memory.observe(obs)
        self.step_count += 1
        with timing_span('infra', 'native-reference-snapshot', passive=True):
            self.references.add(browsergym_snapshot(obs, self.step_count))
        validation_error = self.pending_validation_error
        self.pending_validation_error = ''
        invalid_at_start = len(self.invalid_decisions)
        for _ in range(self.max_steps + 4 if self.condition == 2 else 2):
            if len(self.invalid_decisions) - invalid_at_start >= 3:
                raise InvalidFinalBudgetExceeded('Three invalid decisions at the same state; correction budget exhausted.')
            try:
                force_final = self.step_count + len(self.tool_calls) >= self.max_steps or time.monotonic() >= self.deadline - 120
                decision = self._decision(obs, force_final, validation_error)
                kind = decision.get('kind')
                if kind is None and decision.get('verdict') in ('PASS', 'FAIL', 'UNDETERMINED', 'REPRODUCED', 'NOT REPRODUCED', 'PARTIAL'):
                    kind = 'final'
                if kind is None and isinstance(decision.get('action'), str):
                    kind = 'action'
                if kind in ('action', 'tool') and (not isinstance(decision.get('memory'), str)):
                    raise ValueError('Action/tool decisions require a memory string containing notes to retain.')
                if kind == 'final':
                    validation_error = final_assessment_error(decision, self.condition == '0b', evidence_ids=self.episode_memory.results.keys(), artifact_ids=image_artifact_ids(self.tool_calls))
                    if not validation_error and self.condition != '0b':
                        validation_error = self.references.final_error(decision, 'al', tool_paths([c.get('result') for c in self.tool_calls]))
                        if validation_error:
                            self.reference_corrections += 1
                    if validation_error:
                        self.invalid_finals += 1
                        self.invalid_decisions.append({'reason': validation_error, 'decision': decision})
                        self._reject_last_model()
                        self._checkpoint()
                        if len(self.invalid_decisions) - invalid_at_start >= 3:
                            raise InvalidFinalBudgetExceeded('Three invalid final assessments; correction budget exhausted.')
                        continue
                    return self._finish(decision)
                if force_final:
                    validation_error = 'A final assessment is required at the episode resource limit.'
                    self.invalid_decisions.append({'reason': validation_error, 'decision': decision})
                    self._reject_last_model()
                    continue
                if kind == 'tool' and self.condition == 2:
                    name, args = (decision.get('name'), decision.get('arguments'))
                    if name not in self.tool_names or not isinstance(args, dict):
                        validation_error = 'Unknown evidence tool or non-object arguments.'
                        self.invalid_decisions.append({'reason': validation_error, 'decision': decision})
                        self._reject_last_model()
                        continue
                    began = time.monotonic()
                    with timing_span('tool', name) as call:
                        result = self.bridge.call(name, args)
                        if TIMING_LEDGER and self.bridge.last_timing:
                            TIMING_LEDGER.import_remote(call, self.bridge.last_timing, self.bridge.last_dispatch_wait_ms)
                        if TIMING_LEDGER and isinstance(result, dict) and result.get('error'):
                            TIMING_LEDGER.exclude(call, 'specialist-error')
                    images = []
                    compact = split_tool_images(result, images, self.result_path.parent / 'tool-images')
                    self.pending_images = images[:4]
                    self.tool_calls.append({'name': name, 'args': args, 'result': compact, 'ms': (self.bridge.last_timing or {}).get('accountedMs'), 'elapsedMs': round((time.monotonic() - began) * 1000), 'queueWaitMs': self.bridge.last_dispatch_wait_ms, 'timing': self.bridge.last_timing})
                    self.episode_memory.tool_result(name, args, compact, decision, obs)
                    self.tool_observations.append(json.dumps({'tool': name, 'arguments': args, 'result': compact}, ensure_ascii=False)[:16000])
                    self._checkpoint()
                    validation_error = ''
                    invalid_at_start = len(self.invalid_decisions)
                    if result.get('measurementContext') == 'current-native-page' and name in {'interact_and_observe', 'observe_state_after_activation', 'set_state_and_capture', 'probe_screen_reader_after_action', 'request_hi_res_crop', 'capture_full_page'}:
                        return ('noop()', bgym.AgentInfo(think='Refresh native observation after tool interaction.', extra_info={'toolObservationRefresh': True}))
                    continue
                if kind != 'action' or not isinstance(decision.get('action'), str):
                    validation_error = 'Expected an action string or final assessment.'
                    self.invalid_decisions.append({'reason': validation_error, 'decision': decision})
                    self._reject_last_model()
                    continue
                action = decision['action'].strip()
                self.action_set.to_python_code(action)
                self.actions.append(action)
                self.episode_memory.native_action(action, decision, obs)
                self._checkpoint()
                return (action, bgym.AgentInfo(think=str(decision.get('reason') or '')[:2000], stats={'modelCalls': self.model_calls, 'promptTokens': self.prompt_tokens, 'outputTokens': self.output_tokens}))
            except Exception as exc:
                if terminal_code(exc) or isinstance(exc, InvalidFinalBudgetExceeded):
                    raise
                self._reject_last_model()
                validation_error = f'{type(exc).__name__}: {exc}'[:500]
                self.invalid_decisions.append({'reason': validation_error})
                self._checkpoint()
                from pyparsing import ParseBaseException
                unknown_action = isinstance(exc, NameError) and str(exc).startswith('Invalid action type ')
                if not unknown_action and (not isinstance(exc, (ValueError, SyntaxError, ParseBaseException))):
                    raise
        return self._finish({'verdict': 'UNDETERMINED', 'evidence': 'The agent could not produce a valid action or final assessment.', 'justification': validation_error, 'findings': []}, validation_error)

def run_worker(task_file, out, model, effort, max_steps, chrome, condition):
    global TIMING_LEDGER
    install_runtime(lambda: TIMING_LEDGER)
    task = json.loads(Path(task_file).read_text())
    if task.get('executionProtocol', {}).get('memoryPolicy') != MEMORY_POLICY:
        raise ValueError('Task uses a different AgentLab memory protocol; create fresh versioned tasks.')
    stem = stem_of(task['id'], task['sc'])
    case_file = out / 'cases' / f'{stem}.json'
    episode_base = out / 'episodes' / stem
    episode_base.mkdir(parents=True, exist_ok=True)
    attempt = len(list(episode_base.glob('attempt-*'))) + 1
    episode_dir = episode_base / f'attempt-{attempt}'
    episode_dir.mkdir()
    os.environ['AGENTLAB_RUNTIME_TRACE_FILE'] = str(episode_dir / 'runtime-events.jsonl')
    TIMING_LEDGER = TimingLedger(episode_dir / 'call-timings.jsonl')
    case_scope = TIMING_LEDGER.span('case', 'agentlab-episode')
    case_span = case_scope.__enter__()
    boot_at = float(os.environ.get('AGENTLAB_WORKER_STARTED_MONOTONIC', RUN_BOOT_AT))
    case_span['startMs'] = (boot_at - TIMING_LEDGER.origin) * 1000
    with TIMING_LEDGER.span('infra', 'worker-bootstrap') as boot:
        boot['startMs'] = case_span['startMs']
    decision_file = episode_dir / 'decision.json'
    started = time.monotonic()
    error = None
    try:
        if '/' in model:
            ensure_provider_available()
        exp = bgym.ExpArgs(agent_args=A11yAgentArgs(task_text=task['prompt'], result_path=str(decision_file), model=model, effort=effort, max_steps=max_steps, condition=condition, page_url=task['url'], tool_declarations=task.get('tools', []), agent_name=f'AgentLab-{condition}'), env_args=A11yEnvArgs(task_name='openended', task_seed=0, max_steps=max_steps, headless=True, viewport={'width': 1280, 'height': 900}, task_kwargs={'start_url': task['url'], 'goal': task['prompt']}, chrome_path=chrome), exp_dir=episode_dir, exp_name=f'AgentLab-{condition}-{stem}', save_screenshot=True, logging_level=logging.INFO, logging_level_stdout=logging.WARNING, enable_debug=False)
        exp.run()
        summary_file = episode_dir / 'summary_info.json'
        if summary_file.exists():
            summary = json.loads(summary_file.read_text())
            error = summary.get('err_msg')
        elif not decision_file.exists():
            error = 'AgentLab did not write an episode summary'
    except Exception as exc:
        error = f'{type(exc).__name__}: {exc}'
    saved = decision_file if decision_file.exists() else episode_dir / 'progress.json'
    decision = json.loads(saved.read_text()) if saved.exists() else {}
    error = error or decision.get('agentError')
    if not decision.get('assessment') and (not error):
        error = 'Agent did not return a structured assessment'
    if error:
        TIMING_LEDGER.exclude(case_span, 'execution-error')
    case_scope.__exit__(None, None, None)
    row = {'id': task['id'], 'sc': task['sc'], 'url': task['url'], 'meta': task['meta'], 'targets': task.get('targets'), 'condition': f'AgentLab-{condition}', 'model': model, 'judgmentPrompt': task.get('judgmentPrompt'), 'executionProtocol': task.get('executionProtocol'), 'verdict': (decision.get('assessment') or {}).get('verdict'), 'assessment': decision.get('assessment'), 'rawAssessment': decision.get('rawAssessment'), 'error': error, 'nativeReferencePolicy': decision.get('nativeReferencePolicy'), 'nativeReferenceTrace': decision.get('nativeReferenceTrace'), 'steps': decision.get('steps', 0), 'modelCalls': decision.get('modelCalls', 0), 'modelRequests': decision.get('modelRequests'), 'runtimeRevision': REVISION, 'usageMayBePartial': not decision.get('complete', False), 'decisionSteps': decision.get('decisionSteps', decision.get('steps', 0)), 'actions': decision.get('actions', []), 'usage': decision.get('usage'), 'memoryPolicy': decision.get('memoryPolicy'), 'memoryState': decision.get('memoryState'), 'pendingImages': decision.get('pendingImages', []), 'toolCalls': decision.get('toolCalls', []), 'invalidDecisions': decision.get('invalidDecisions', []), 'estimatedModelCostUsd': decision.get('estimatedModelCostUsd'), 'usageAllAttempts': decision.get('usageAllAttempts'), 'apiCostUsd': decision.get('apiCostUsd'), 'ms': round((time.monotonic() - started) * 1000), 'timing': TIMING_LEDGER.summary(), 'timingTrace': str(TIMING_LEDGER.path.relative_to(out)), 'episodeDir': str(episode_dir.relative_to(out))}
    case_file.parent.mkdir(exist_ok=True)
    case_temp = case_file.with_suffix(f'.{os.getpid()}.tmp')
    case_temp.write_text(json.dumps(row, ensure_ascii=False))
    case_temp.replace(case_file)
    return row
