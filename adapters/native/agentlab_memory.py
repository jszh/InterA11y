import copy
import hashlib
import json
from agentlab.agents import dynamic_prompting as dp
from agentlab.agents.generic_agent.generic_agent_prompt import Memory
from agentlab.llm.llm_utils import count_tokens
REVISION = 'agentlab-native-memory-v2'
MAX_PROMPT_TOKENS = 64000
TOKENIZER_MODEL = 'gpt-4'
POLICY = {'revision': REVISION, 'history': 'agentlab.dynamic_prompting.History', 'use_history': True, 'use_action_history': True, 'use_memory': True, 'decisionMemoryRequired': True, 'maxPromptTokens': MAX_PROMPT_TOKENS, 'tokenizerProxy': TOKENIZER_MODEL, 'toolResultRetention': 'complete; identical serialized results referenced', 'historyTruncation': False, 'crossEpisodeMemory': False}

def serialized(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))

def observation_summary(obs):

    def builtin(value):
        if hasattr(value, 'tolist'):
            return builtin(value.tolist())
        if isinstance(value, dict):
            return {k: builtin(v) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [builtin(v) for v in value]
        return copy.deepcopy(value)
    summary = {k: builtin(obs.get(k)) for k in ('url', 'focused_element_bid', 'last_action_error', 'open_pages_urls', 'open_pages_titles', 'active_page_index')}
    summary['last_action_error'] = str(summary.get('last_action_error') or '')
    for key in ('axtree_txt', 'pruned_html'):
        text = obs.get(key) or ''
        summary[key + 'Id'] = hashlib.sha1(text.encode()).hexdigest()
    return summary

class EpisodeMemory:

    def __init__(self):
        self.flags = dp.ObsFlags(use_history=True, use_action_history=True, use_error_logs=True, use_past_error_logs=True, use_think_history=False, use_screenshot=False)
        self.note_prompt = Memory(visible=True)
        self.records = []
        self.results = {}
        self.pending_native = None
        self.current_observation = None
        self.last_prompt_stats = None

    def observe(self, obs):
        current = observation_summary(obs)
        if self.pending_native is not None:
            record = self.records[self.pending_native]
            record['after'] = current
            record['outcome'] = {'browserObservation': current}
            self.pending_native = None
        self.current_observation = current

    def _record(self, action, decision, obs):
        if self.pending_native is not None:
            raise RuntimeError('Native action outcome has not been observed')
        before = observation_summary(obs)
        record = {'action': action, 'agentMemory': decision.get('memory') or '', 'reason': decision.get('reason') or '', 'before': before, 'after': before, 'outcome': None}
        self.records.append(record)
        return record

    def native_action(self, action, decision, obs):
        record = self._record(action, decision, obs)
        record['outcome'] = {'pendingBrowserObservation': True}
        self.pending_native = len(self.records) - 1

    def tool_result(self, name, args, result, decision, obs):
        record = self._record({'tool': name, 'arguments': copy.deepcopy(args)}, decision, obs)
        payload = serialized(result)
        identity = hashlib.sha1(payload.encode()).hexdigest()
        self.results.setdefault(identity, copy.deepcopy(result))
        record['outcome'] = {'evidenceId': identity, 'session': result.get('measurementContext') or ('retained isolated state ' + str(result['stateId']) if result.get('stateId') else 'isolated specialist page')}

    def history(self):
        actions, memories, thoughts = ([], [], [])
        observations = [self.records[0]['before']] if self.records else [self.current_observation or {'last_action_error': ''}]
        emitted = set()
        emitted_states = {}

        def state_value(value):
            payload = serialized(value)
            if payload in emitted_states:
                return {'stateRef': emitted_states[payload]}
            identity = f's{len(emitted_states) + 1}'
            emitted_states[payload] = identity
            return {'stateId': identity, 'value': value}
        for record in self.records:
            actions.append(record['action'] if isinstance(record['action'], str) else serialized(record['action']))
            outcome = copy.deepcopy(record['outcome'])
            if outcome and 'evidenceId' in outcome:
                identity = outcome['evidenceId']
                if identity not in emitted:
                    outcome['returnedMeasurement'] = self.results[identity]
                    emitted.add(identity)
                else:
                    outcome['returnedMeasurement'] = 'identical to the earlier result with this evidenceId'
            memories.append(serialized({'agentAuthoredMemory': record['agentMemory'], 'agentReason': record['reason'], 'observedOutcome': outcome, 'stateBefore': state_value(record['before']), 'stateAfter': state_value(record['after'])}))
            thoughts.append(None)
            observations.append(record['after'])
        return dp.History(observations, actions, memories, thoughts, self.flags)

    def instructions(self):
        text = self.note_prompt.abstract_ex.replace('<memory>', '').replace('</memory>', '').strip()
        return text + '\nUse a concise string field "memory" in your decision JSON for these notes. Every action or tool decision must include "memory"; summarize observations to retain for later steps. History separates agent-authored notes from returned measurements; notes are not independent proof. Repeated observation states use stateRef to refer to an earlier complete stateId/value; no state information is omitted.\n'

    def state(self):
        return {'revision': REVISION, 'records': copy.deepcopy(self.records), 'results': copy.deepcopy(self.results), 'pendingNative': self.pending_native, 'currentObservation': copy.deepcopy(self.current_observation), 'lastPromptStats': copy.deepcopy(self.last_prompt_stats)}

    def restore(self, state):
        if state.get('revision') != REVISION:
            raise ValueError('Unsupported AgentLab memory checkpoint revision')
        restored = copy.deepcopy(state)
        self.records = restored['records']
        self.results = restored['results']
        self.pending_native = restored.get('pendingNative')
        self.current_observation = restored.get('currentObservation')
        self.last_prompt_stats = restored.get('lastPromptStats')
        for record in self.records:
            identity = (record.get('outcome') or {}).get('evidenceId')
            if identity and identity not in self.results:
                raise ValueError('Memory checkpoint is missing a tool result')
        if self.pending_native is not None and (not 0 <= self.pending_native < len(self.records)):
            raise ValueError('Memory checkpoint has an invalid pending action')

class MemoryDecisionPrompt(dp.Shrinkable):

    def __init__(self, before, after, obs, memory):
        super().__init__()
        self.before, self.after = (before, after)
        self.history = memory.history()
        self.memory = memory
        self.original_ax = obs['axtree_txt'][:18000]
        self.original_html = obs['pruned_html'][:18000]
        self.ax = dp.Trunkater(visible=True, shrink_speed=0.3, start_trunkate_iteration=0)
        self.html = dp.Trunkater(visible=True, shrink_speed=0.3, start_trunkate_iteration=0)
        self.ax._prompt, self.html._prompt = (self.original_ax, self.original_html)
        self.shrink_calls = 0

    @property
    def _prompt(self):
        return self.before + self.history.prompt + '\nCurrent accessibility tree (up to 18,000 characters):\n' + self.ax.prompt + '\n\nCurrent pruned HTML (up to 18,000 characters):\n' + self.html.prompt + '\n\n' + self.after

    def shrink(self):
        self.shrink_calls += 1
        self.ax.shrink()
        self.html.shrink()

    def fit(self, budget=MAX_PROMPT_TOKENS):
        prompt = dp.fit_tokens(self, max_prompt_tokens=budget, model_name=TOKENIZER_MODEL, max_iterations=24)
        count = count_tokens(prompt, model=TOKENIZER_MODEL)
        self.memory.last_prompt_stats = {'textTokensProxy': count, 'maxTextTokens': budget, 'shrinkCalls': self.shrink_calls, 'historySteps': len(self.memory.records), 'uniqueToolResults': len(self.memory.results), 'historyTruncated': False, 'currentObservationShortened': self.shrink_calls > 0, 'axChars': len(self.ax.prompt), 'htmlChars': len(self.html.prompt)}
        if count > budget:
            raise RuntimeError('AgentLab memory exceeds text context budget; history retained on disk')
        return prompt
