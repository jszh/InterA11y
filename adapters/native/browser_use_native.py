import time
from final_assessment_validation import image_artifact_ids
RUN_BOOT_AT = time.monotonic()
import argparse
import asyncio
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from contextlib import nullcontext
from runtime_slots import acquire_slot, release_slot
from episode_timeout import parse_episode_timeout
from provider_timeout import gemini_call_timeout
from call_timing import TimingLedger, VERSION as TIMING_VERSION, write_run_infrastructure
from native_element_references import POLICY as REFERENCE_POLICY, ReferenceLedger, browser_use_snapshot, tool_paths, TOOL_TARGET_POLICY
for _event in ('BrowserStartEvent', 'BrowserLaunchEvent', 'BrowserConnectedEvent'):
    os.environ.setdefault('TIMEOUT_' + _event, '150')
os.environ.setdefault('TIMEOUT_NavigateToUrlEvent', '90')
from execution_health import async_browser_startup, ensure_provider_available, native_failure
from final_assessment_validation import final_assessment_error, COMPLETION_POLICY
from timed_openrouter import TimedChatOpenRouter
from comparison_prompt import EXPERT_TARGET_POLICY, RUBRIC_SNAPSHOT, task_prompt, prompt_id, prompt_record, check_saved_prompt, parse_condition, normalize_gena11y_assessment, check_output_prompt, default_judgment_prompt, check_output_protocol
from dotenv import load_dotenv
from pydantic import BaseModel, Field, AliasChoices
from typing import Literal
ROOT = Path(__file__).resolve().parents[2]
NATIVE = Path(__file__).resolve().parent
load_dotenv(ROOT / '.env')
from browser_use import Agent, BrowserProfile, BrowserSession
from browser_use.agent.views import ActionResult
from browser_use.tools.service import Tools
from browser_use.browser.watchdogs.security_watchdog import SecurityWatchdog
from browser_use_file_observations import install as install_file_observations, POLICY as FILE_OBSERVATION_POLICY
FILE_OBSERVATION_AUDIT = install_file_observations(Path(os.environ.get('INTERA11Y_ALLOWED_PAGES', ROOT / 'datasets')))
TOOL_RESULT_POLICY = 'native-extracted-content-next-decision-v1'
_normal_url_allowed = SecurityWatchdog._is_url_allowed

def _corpus_url_allowed(self, url):
    if url.startswith('file://'):
        from urllib.parse import unquote, urlparse
        target = Path(unquote(urlparse(url).path)).resolve()
        neutral = Path(os.environ.get('INTERA11Y_ALLOWED_PAGES', ROOT / 'datasets')).resolve()
        return target.is_relative_to(neutral) and target.is_file()
    return _normal_url_allowed(self, url)
SecurityWatchdog._is_url_allowed = _corpus_url_allowed

class Finding(BaseModel):
    element_ref: str = Field(min_length=1, validation_alias=AliasChoices('element_ref', 'xpath'), description='Unique observed identity: prefer index:123 from the current browser state; css:<selector> must be confirmed by native find_elements to match exactly ONE element; xpath:<selector> must resolve to exactly one observed element. The harness verifies and translates the reference. Missing or ambiguous references are rejected.')
    observation_step: int | None = Field(default=None, description='Earlier browser observation step if needed; null means current observation')
    evidence: str
    reason: str

class Assessment(BaseModel):
    verdict: Literal['PASS', 'FAIL', 'UNDETERMINED'] = Field(description='PASS, FAIL, or UNDETERMINED')
    evidence: str
    justification: str
    findings: list[Finding] = Field(default_factory=list)

class GenViolation(BaseModel):
    xpath: str | None
    outerHTML: str
    reason: str
    recommendation: str

class GenAssessment(BaseModel):
    verdict: Literal['REPRODUCED', 'NOT REPRODUCED', 'PARTIAL'] = Field(description='REPRODUCED, NOT REPRODUCED, or PARTIAL')
    confidence: str
    violations: list[GenViolation]
    summary: str

def prompt(sc, rubric, condition, targets):
    return task_prompt(sc, rubric, targets, condition)

def externalize_images(value, directory, root):
    if isinstance(value, dict):
        return {k: externalize_images(v, directory, root) for k, v in value.items()}
    if isinstance(value, list):
        return [externalize_images(v, directory, root) for v in value]
    if isinstance(value, str):
        match = re.match('^data:image/\\w+;base64,(.*)$', value, re.S)
        raw = match.group(1) if match else value
        if len(raw) > 1000 and (raw.startswith('iVBORw0KGgo') or raw.startswith('/9j/')):
            ext = 'png' if raw.startswith('iVBORw0KGgo') else 'jpg'
            data = base64.b64decode(raw)
            image_path = directory / (hashlib.sha1(data).hexdigest()[:20] + '.' + ext)
            directory.mkdir(parents=True, exist_ok=True)
            if not image_path.exists():
                image_path.write_bytes(data)
            return {'imageFile': str(image_path.relative_to(root)), 'bytes': len(data)}
    return value

class ToolBridge:

    def __init__(self, url, image_directory, output_root):
        self.url = url
        self.image_directory = image_directory
        self.output_root = output_root
        self.proc = None
        self.lock = asyncio.Lock()
        self.calls = []
        self.stderr_file = None
        self.stderr_path = self.output_root / 'bridge-logs' / (self.image_directory.name + '.log')

    async def start(self):
        self.stderr_path.parent.mkdir(parents=True, exist_ok=True)
        self.stderr_file = self.stderr_path.open('ab')
        async with async_browser_startup(getattr(self, 'ledger', None)):
            self.proc = await asyncio.create_subprocess_exec('node', str(NATIVE / 'browser-use-tool-bridge.js'), self.url, '--timing-v2', cwd=ROOT, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=self.stderr_file, env={**os.environ, 'A11Y_BROWSER_STARTUP_SLOTS': '0'}, limit=64 * 1024 * 1024)
            ready = await asyncio.wait_for(self.proc.stdout.readline(), timeout=210)
            if not ready or not json.loads(ready).get('ready'):
                raise RuntimeError('InterA11y tool bridge failed to start: ' + self.stderr_path.read_text(errors='replace')[-4000:])

    async def call(self, name, args):
        preparation_started = time.monotonic()
        try:
            args, native_targets = self.references.prepare_tool_targets(args, retained_state=bool(args.get('stateId') and args['stateId'] != 'new'))
        except ValueError as exc:
            result = {'error': str(exc), 'targetPolicy': TOOL_TARGET_POLICY, 'stage': 'native-observation'}
            self.calls.append({'name': name, 'args': args, 'result': result, 'nativeTargets': [], 'ms': 0, 'elapsedMs': round((time.monotonic() - preparation_started) * 1000), 'queueWaitMs': 0, 'timing': None})
            return result
        ledger = getattr(self, 'ledger', None)
        with ledger.span('wait', 'specialist-lock') if ledger else nullcontext():
            await self.lock.acquire()
        try:
            with ledger.span('remote-service', name) if ledger else nullcontext({}) as call:
                begin = time.monotonic()
                dispatched_at = time.time() * 1000
                native_context = None
                if getattr(self, 'browser', None):
                    native = await self.browser.get_or_create_cdp_session()
                    native_context = {'endpoint': self.browser.cdp_url, 'targetId': native.target_id}
                self.proc.stdin.write((json.dumps({'name': name, 'args': args, 'nativeTargets': native_targets, 'nativeContext': native_context}) + '\n').encode())
                await self.proc.stdin.drain()
                line = await asyncio.wait_for(self.proc.stdout.readline(), timeout=190)
                if not line:
                    raise RuntimeError('InterA11y tool bridge exited: ' + self.stderr_path.read_text(errors='replace')[-4000:])
                payload = json.loads(line)
                result = payload['result'] if payload.get('bridgeProtocol') == 2 else payload
                timing = payload.get('timing') if payload.get('bridgeProtocol') == 2 else None
                queue_ms = max(0, payload.get('startedAtUnixMs', dispatched_at) - dispatched_at)
                if ledger and timing:
                    ledger.import_remote(call, timing, queue_ms)
                if ledger and isinstance(result, dict) and result.get('error'):
                    ledger.exclude(call, 'specialist-error')
                self.calls.append({'name': name, 'args': args, 'nativeTargets': native_targets, 'result': externalize_images(result, self.image_directory, self.output_root), 'ms': timing.get('accountedMs', 0) if timing else None, 'elapsedMs': round((time.monotonic() - begin) * 1000), 'queueWaitMs': queue_ms, 'timing': timing})
                return result
        finally:
            self.lock.release()

    async def close(self):
        if self.proc and self.proc.returncode is None:
            self.proc.stdin.close()
            try:
                await asyncio.wait_for(self.proc.wait(), timeout=15)
            except asyncio.TimeoutError:
                self.proc.kill()
                await self.proc.wait()
        if self.stderr_file:
            self.stderr_file.close()

def extract_images(value, images):
    if isinstance(value, dict):
        return {k: extract_images(v, images) for k, v in value.items()}
    if isinstance(value, list):
        return [extract_images(v, images) for v in value]
    if isinstance(value, str):
        match = re.match('^data:image/\\w+;base64,(.*)$', value, re.S)
        raw = match.group(1) if match else value
        if len(raw) > 1000 and (raw.startswith('iVBORw0KGgo') or raw.startswith('/9j/')):
            images.append({'name': f'evidence-{len(images) + 1}.png', 'data': raw})
            return f'[image {len(images)} attached]'
    return value

class TimedTools(Tools):

    def __init__(self, ledger=None, **kwargs):
        super().__init__(**kwargs)
        self.timing_ledger = ledger
        self.final_validator = None
        self.reference_corrections = 0
        self.consecutive_invalid_finals = 0
        self.verified_selectors = {}

    async def act(self, action, *args, **kwargs):
        details = action.model_dump(exclude_none=True, exclude_unset=True)
        if any((name != 'done' for name in details)):
            self.consecutive_invalid_finals = 0
        if self.timing_ledger is None:
            result = await super().act(action, *args, **kwargs)
            self._record_unique_selector(details, result)
            return self._validate_final(self._deliver_native_content(result))
        name = next(iter(action.model_dump(exclude_none=True, exclude_unset=True)), 'unknown')
        with self.timing_ledger.span('tool', name) as call:
            result = await super().act(action, *args, **kwargs)
            self._record_unique_selector(details, result)
            result = self._deliver_native_content(result)
            result = self._validate_final(result)
            if getattr(result, 'error', None):
                self.timing_ledger.exclude(call, 'tool-error')
            elif any((r.get('parentId') == call['id'] and r['kind'] == 'remote-service' and (not r.get('accepted')) for r in self.timing_ledger.records)):
                self.timing_ledger.exclude(call, 'specialist-error')
            return result

    def _record_unique_selector(self, action, result):
        query = action.get('find_elements')
        if query and (not result.error):
            count = re.match('Found (\\d+) elements? matching ', result.long_term_memory or '')
            if count:
                self.verified_selectors[query['selector']] = int(count.group(1))

    def _validate_final(self, result):
        if result.is_done and self.final_validator:
            message = self.final_validator(result.extracted_content)
            if message:
                self.reference_corrections += 1
                self.consecutive_invalid_finals += 1
                if self.timing_ledger:
                    llm = next((r for r in reversed(self.timing_ledger.records) if r['kind'] == 'llm' and r.get('accepted')), None)
                    if llm:
                        self.timing_ledger.exclude(llm, 'invalid-final-reference')
                if self.consecutive_invalid_finals >= 3:
                    raise ValueError('Native reference correction budget exhausted: ' + message)
                return ActionResult(error=message, extracted_content=message, long_term_memory=message, is_done=False, include_extracted_content_only_once=True)
        return result

    @staticmethod
    def _deliver_native_content(result):
        if result.extracted_content and result.long_term_memory and (not result.is_done) and (not result.include_extracted_content_only_once):
            result.include_extracted_content_only_once = True
        return result
from tool_argument_schema import argument_model

def add_tools(bridge, declarations, disable_javascript=True, ledger=None):
    tools = TimedTools(ledger, exclude_actions=['evaluate'] if disable_javascript else [])
    for declaration in declarations:
        name = declaration['name']
        description = declaration.get('description', '') + '\nElement arguments named XPath may also use a current native index:123 or a unique observed css:<selector>. The bridge verifies uniqueness and translates before measurement. Use global browser indices, never the local positions in find_elements results.\nArguments JSON schema: ' + json.dumps(declaration.get('parameters', {}))
        param_model = argument_model(name, declaration['parameters'])

        def make_action(tool_name):

            async def action(params) -> ActionResult:
                try:
                    args = params.model_dump(exclude_none=True)
                    result = await bridge.call(tool_name, args)
                    images = []
                    compact = extract_images(result, images)
                    return ActionResult(extracted_content=json.dumps(compact), error=result.get('error') if isinstance(result, dict) else None, images=images or None, metadata={'intera11y_tool': tool_name})
                except Exception as exc:
                    return ActionResult(error=str(exc))
            action.__name__ = tool_name
            action.__doc__ = description
            return action
        tools.action(description, param_model=param_model, terminates_sequence=True)(make_action(name))
    return tools

def result_file(directory, case_id, sc):
    digest = hashlib.sha1(f'{case_id}|{sc}'.encode()).hexdigest()[:12]
    safe = re.sub('[^a-zA-Z0-9_.-]+', '_', case_id)[:100]
    return directory / 'cases' / f'{safe}-{sc}-{digest}.json'

async def run_unit(case, sc, spec, options, out):
    file = result_file(out, case['id'], sc)
    task_text = prompt(sc, spec['rubrics'][sc], options.condition, (case.get('targets') or {}).get(sc))
    if options.disable_javascript:
        task_text += '\nThe evaluate/JavaScript execution action is disabled. Use the available browser actions.'
    if options.condition == 2:
        task_text += '\nState-preserving evidence tools measure the current native page; native and tool actions share state. Destructive instruments require an explicit isolated stateId:new. Reuse its returned ID to continue that isolated workflow; it does not inherit native actions.'
    if options.condition != '0b':
        task_text += '\nFor finding element_ref, use index:123 for the global element index [123] shown in the browser state, or css:<selector> for an observed selector. Prefer the global browser index: it identifies one element in that observation. If the failing element has no displayed global index, use the native find_elements action with your selector and max_results=2 to verify that it matches exactly ONE element, then report css:<that exact selector>. If it matches multiple elements, refine the selector and check again. Never submit a broad selector for several failures: identify each element separately. The [0], [1], etc. positions in find_elements results are local result positions, not global browser indices. Do not use them as index references. You may also report xpath:<selector> identifying exactly one observed element; the harness verifies it in the recorded DOM. The harness translates these identities after your assessment. Do not spend actions reconstructing XPath. observation_step may identify an earlier browser step; null means the current observation.'
    judgment_prompt = prompt_record(task_text, prompt_id(spec, options.condition))
    if file.exists():
        previous = json.loads(file.read_text())
        check_saved_prompt(previous, judgment_prompt)
        if previous.get('executionProtocol') != options.execution_protocol:
            raise ValueError('Cached case has a different execution protocol; use a fresh --out directory.')
        if previous.get('assessment') and previous.get('verdict') in ('PASS', 'FAIL', 'UNDETERMINED') and str(previous.get('error') or '').startswith(('history save failed:', 'browser stop failed:', 'tool bridge stop failed:')):
            previous['cleanupErrors'] = [previous['error']]
            previous['error'] = None
            file.write_text(json.dumps(previous, ensure_ascii=False))
        if not (options.retry_errors and native_failure(previous, 'bu')):
            return previous
        archive = out / 'retry-archive'
        archive.mkdir(exist_ok=True)
        stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
        (archive / f'{file.stem}-{stamp}.json').write_text(json.dumps(previous, ensure_ascii=False))
    task_path = out / 'tasks' / (file.stem + '.json')
    task_path.parent.mkdir(parents=True, exist_ok=True)
    task_path.write_text(json.dumps({'id': case['id'], 'sc': sc, 'url': case['url'], 'prompt': task_text, 'judgmentPrompt': judgment_prompt, 'executionProtocol': options.execution_protocol}, ensure_ascii=False))
    case_start = time.monotonic()
    ledger = TimingLedger(out / 'timings' / (file.stem + '.jsonl'))
    case_scope = ledger.span('case', 'browser-use-episode')
    case_span = case_scope.__enter__()
    bridge = None
    browser = None
    history = None
    error = None
    cleanup_errors = []
    response = None
    agent = None
    llm = None
    observation_preflight = None
    references = ReferenceLedger(out / 'native-references' / (file.stem + '.jsonl'))

    def record_references(state, model_output, step):
        with ledger.span('infra', 'native-reference-snapshot', passive=True):
            references.add(browser_use_snapshot(state, step))

    def validate_references(text):
        try:
            value = json.loads(text)
        except (ValueError, TypeError):
            return 'Final answer must be a structured assessment.'
        error = final_assessment_error(value, artifact_ids=image_artifact_ids(bridge.calls if bridge else []))
        if error:
            return error
        observed_paths = tool_paths([c.get('result') for c in bridge.calls]) if bridge else set()
        error = references.final_error(value, 'bu', observed_paths)
        if error:
            return error
        if value.get('verdict') == 'FAIL':
            for finding in value.get('findings') or []:
                reference = finding.get('element_ref') or ''
                if reference.startswith('css:') and tools.verified_selectors.get(reference[4:]) != 1:
                    return 'Before submitting css:' + reference[4:] + ', use native find_elements with that exact selector and max_results=2. It must report exactly ONE match. Otherwise refine the selector or use the observed global browser index.'
        return None
    phase = 'admission'
    tools = add_tools(None, [], options.disable_javascript, ledger)
    try:
        if '/' in options.model:
            ensure_provider_available()
        if options.condition == 2:
            phase = 'specialist-browser-setup'
            bridge = ToolBridge(case['url'], out / 'tool-images' / file.stem, out)
            bridge.ledger = ledger
            bridge.references = references
            with ledger.span('infra', 'specialist-browser-setup'):
                await bridge.start()
            tools = add_tools(bridge, spec['tools'], options.disable_javascript, ledger)
        if options.disable_javascript:
            assert 'evaluate' not in tools.registry.registry.actions
        if options.condition != '0b':
            tools.final_validator = validate_references
        profile = BrowserProfile(executable_path=options.chrome, headless=True, viewport={'width': 1280, 'height': 900}, device_scale_factor=1, enable_default_extensions=False, args=['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--font-render-hinting=none', '--hide-scrollbars', '--mute-audio'])
        browser = BrowserSession(browser_profile=profile)
        phase = 'native-browser-setup'
        async with async_browser_startup(ledger):
            with ledger.span('infra', 'browser-setup'):
                await asyncio.wait_for(browser.start(), timeout=180)
        phase = 'initial-navigation'
        with ledger.span('tool', 'initial-navigation'):
            await asyncio.wait_for(browser.navigate_to(case['url']), timeout=120)
            await asyncio.sleep(2)
        if bridge:
            bridge.browser = browser
        phase = 'native-observation-validation'
        with ledger.span('tool', 'initial-observation-validation'):
            state = await asyncio.wait_for(browser.get_browser_state_summary(include_screenshot=True), timeout=120)
            observation_preflight = dict(policy=FILE_OBSERVATION_POLICY, url=state.url, domRootPresent=state.dom_state._root is not None, nativeScreenshotPresent=bool(state.screenshot), interactiveElements=len(state.dom_state.selector_map), title=state.title)
            if not state.screenshot or (state.dom_state._root is None and state.title in ('Empty Tab', 'Error')):
                raise RuntimeError('Native browser observations unavailable; refusing to bill a model on an empty placeholder state')
        llm = TimedChatOpenRouter(ledger=ledger, model=options.model, api_key=os.environ['OPENROUTER_API_KEY'], temperature=0, effort=options.effort, trace_path=out / 'model-responses' / (file.stem + '.jsonl'))
        agent = Agent(task=task_text, max_failures=2, extend_system_message='A final answer reports completed observations. Pending inspection or measurement belongs in an action/tool call; UNDETERMINED must explain an actual obstacle.', llm=llm, browser=browser, tools=tools, register_new_step_callback=record_references, output_model_schema=GenAssessment if options.condition == '0b' else Assessment, use_vision=True, save_conversation_path=str(out / 'conversations' / file.stem), calculate_cost='/' not in options.model, directly_open_url=False, llm_timeout=900 if '/' in options.model else gemini_call_timeout(75), step_timeout=1800 if '/' in options.model else max(180, gemini_call_timeout(75) + 120))
        phase = 'agent-interaction'
        history = await asyncio.wait_for(agent.run(max_steps=options.max_steps), timeout=options.timeout)
        final = history.final_result()
        if final:
            raw_response = (GenAssessment if options.condition == '0b' else Assessment).model_validate_json(final).model_dump()
            response = normalize_gena11y_assessment(raw_response) if options.condition == '0b' else raw_response
            validation_error = final_assessment_error(raw_response, options.condition == '0b')
            if not validation_error and options.condition != '0b':
                validation_error = references.final_error(raw_response, 'bu')
            if validation_error:
                raise ValueError(validation_error)
            with ledger.span('infra', 'post-output-reference-translation', passive=True):
                observed_paths = tool_paths([c.get('result') for c in bridge.calls]) if bridge else set()
                response = references.translate(response, 'bu', observed_paths)
            if response['verdict'] not in ('PASS', 'FAIL', 'UNDETERMINED'):
                raise ValueError('Invalid verdict: ' + response['verdict'])
        else:
            error = getattr(llm, 'provider_error', None) or 'Browser Use returned no final structured assessment'
    except (Exception, asyncio.CancelledError) as exc:
        error = f'{phase}: {type(exc).__name__}: {exc}'
    finally:
        if history is None and agent is not None:
            history = getattr(agent, 'history', None)
        if history:
            try:
                history.save_to_file(out / 'histories' / (file.stem + '.json'))
                write_interactions(history, out / 'interactions' / (file.stem + '.jsonl'), case, sc)
            except (Exception, asyncio.CancelledError) as exc:
                cleanup_errors.append(f'history save failed: {exc}')
        if browser:
            try:
                with ledger.span('infra', 'browser-teardown'):
                    await asyncio.wait_for(browser.stop(), timeout=45)
            except (Exception, asyncio.CancelledError) as exc:
                cleanup_errors.append(f'browser stop failed: {exc}')
        if bridge:
            try:
                with ledger.span('infra', 'specialist-browser-teardown'):
                    await asyncio.wait_for(bridge.close(), timeout=30)
            except (Exception, asyncio.CancelledError) as exc:
                cleanup_errors.append(f'tool bridge stop failed: {exc}')
    if error:
        ledger.exclude(case_span, 'execution-error')
    case_scope.__exit__(None, None, None)
    usage = history.usage.model_dump() if history and history.usage else None
    row = {'id': case['id'], 'sc': sc, 'url': case['url'], 'expected': case['expected'], 'meta': case['meta'], 'targets': (case.get('targets') or {}).get(sc), 'condition': options.condition, 'model': options.model, 'judgmentPrompt': judgment_prompt, 'executionProtocol': options.execution_protocol, 'responseCapacity': {'policy': os.environ.get('A11Y_OUTPUT_TOKEN_POLICY', 'original'), 'nativeGeminiOutputLimit': os.environ.get('A11Y_GEMINI_NATIVE_OUTPUT_LIMIT')}, 'observationPreflight': observation_preflight, 'fileObservationRepair': FILE_OBSERVATION_AUDIT, 'availableActions': sorted(tools.registry.registry.actions), 'verdict': response['verdict'] if response else None, 'assessment': response, 'rawAssessment': raw_response if response else None, 'error': error, 'nativeReferencePolicy': REFERENCE_POLICY, 'nativeReferenceTrace': str(references.path.relative_to(out)), 'nativeSelectorVerification': tools.verified_selectors, 'failedPhase': phase if error else None, 'cleanupErrors': cleanup_errors, 'steps': history.number_of_steps() if history else 0, 'usage': usage, 'toolCalls': bridge.calls if bridge else [], 'usageAllAttempts': llm.api_summary() if llm is not None else None, 'apiCostUsd': llm.api_summary()['apiCostUsd'] if isinstance(llm, TimedChatOpenRouter) else None, 'ms': round((time.monotonic() - case_start) * 1000), 'timing': ledger.summary(), 'timingTrace': str(ledger.path.relative_to(out))}
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(json.dumps(row, ensure_ascii=False))
    return row

def write_interactions(history, path, case, sc):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('w') as log:
        for step_index, entry in enumerate(history.history, 1):
            data = entry.model_dump(mode='json')
            for action_index, action in enumerate((data.get('model_output') or {}).get('action') or []):
                results = data.get('result') or []
                result = results[action_index] if action_index < len(results) else None
                log.write(json.dumps({'id': case['id'], 'sc': sc, 'step': step_index, 'actionIndex': action_index + 1, 'action': action, 'status': 'requested-no-result' if result is None else 'error' if result.get('error') else 'returned', 'result': externalize_images(result, path.parent / 'images' / path.stem, path.parent.parent), 'timing': data.get('metadata')}, ensure_ascii=False) + '\n')
