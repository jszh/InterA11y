import asyncio
import json
import os
import re
from contextvars import ContextVar
from pydantic import ValidationError
from pathlib import Path
from types import SimpleNamespace
from transport_settings import chat_base_url
from browser_use import ChatOpenAI
from openrouter_usage import normalize_response, summarize_ledger
from execution_health import ensure_provider_available, record_terminal, terminal_code
from openrouter_request_policy import provider_policy, ProviderOutputLimitError

def unwrap_json_fence(content):
    if not isinstance(content, str):
        return content
    match = re.fullmatch('\\s*```(?:json)?\\s*\\n(.*?)\\n```\\s*', content, re.S | re.I)
    if not match:
        return content
    payload = match.group(1).strip()
    try:
        value = json.loads(payload)
    except ValueError:
        return content
    return payload if isinstance(value, (dict, list)) else content

class TimedChatOpenRouter(ChatOpenAI):

    def __init__(self, *, ledger, trace_path, effort='high', **kwargs):
        super().__init__(base_url=chat_base_url(), max_retries=0, add_schema_to_system_prompt=True, max_completion_tokens=None, timeout=900, **kwargs)
        self._ledger, self._trace_path, self._effort = (ledger, Path(trace_path), effort)
        self._wrapped_client = None
        self.api_responses = []
        self.provider_error = None
        self._schema_context = ContextVar('browser_use_output_schema', default=None)

    def get_client(self):
        if self._wrapped_client is None:
            native = super().get_client()

            async def create(**kwargs):
                kwargs.pop('max_completion_tokens', None)
                kwargs.pop('max_tokens', None)
                kwargs['extra_body'] = {**kwargs.get('extra_body', {}), 'usage': {'include': True}, 'reasoning': {'effort': self._effort}, **{}}
                if kwargs.get('response_format'):
                    kwargs['extra_body']['provider'] = {'require_parameters': True}
                schema = (kwargs.get('response_format') or {}).get('json_schema', {}).get('schema', {})
                action_names = set()

                def visit(value):
                    if isinstance(value, dict):
                        if 'arguments_json' in (value.get('properties') or {}):
                            return
                        for name, prop in (value.get('properties') or {}).items():
                            if isinstance(prop, dict) and 'arguments_json' in (prop.get('properties') or {}):
                                action_names.add(name)
                        for v in value.values():
                            visit(v)
                    elif isinstance(value, list):
                        for v in value:
                            visit(v)
                visit(schema)
                self._ledger.write({'event': 'request-capabilities', 'specialistActionNames': sorted(action_names), 'schemaIncludedInSystemPrompt': self.add_schema_to_system_prompt})
                max_attempts = max(1, int(os.environ.get('A11Y_HTTP_MAX_ATTEMPTS', '2')))
                schema_repairs = 0
                for attempt in range(max_attempts):
                    try:
                        ensure_provider_available()
                        kwargs['extra_body']['provider'] = provider_policy(self.model, kwargs['extra_body'].get('provider'))
                        with self._ledger.span('llm', 'openrouter-chat-completions', attempt=attempt, providerRouting=kwargs['extra_body']['provider'], clientOutputTokenCap=None) as span:
                            response = await native.chat.completions.create(**kwargs)
                            raw = response.model_dump(mode='json', exclude_none=True)
                            usage = normalize_response(raw)
                            self.api_responses.append(usage)
                            span['usage'] = usage
                            self._ledger.write({'event': 'usage', 'id': span['id'], 'usage': usage})
                            self._trace_path.parent.mkdir(parents=True, exist_ok=True)
                            with self._trace_path.open('a') as f:
                                f.write(json.dumps({'attempt': attempt, 'callId': span['id'], 'usage': usage, 'response': raw}) + '\n')
                            if raw.get('error') or not raw.get('choices'):
                                if record_terminal(raw):
                                    from execution_health import ProviderBlocked
                                    raise ProviderBlocked(f"OpenRouter HTTP {terminal_code(raw)}: {raw.get('error')}", terminal_code(raw))
                                raise RuntimeError(f"OpenRouter returned an error or no choices: {raw.get('error')}")
                            if raw['choices'][0].get('finish_reason') == 'error':
                                self._ledger.exclude(span, 'provider-error-completion')
                                raise RuntimeError('OpenRouter returned finish_reason=error')
                            if raw['choices'][0].get('finish_reason') == 'length':
                                raise ProviderOutputLimitError('Provider truncated the response at its own limit; no client output-token cap or budget-doubling retry is configured')
                            output_format = self._schema_context.get()
                            content = (raw['choices'][0].get('message') or {}).get('content')
                            if output_format and content:
                                try:
                                    output_format.model_validate_json(content)
                                except ValidationError as exc:
                                    self._ledger.exclude(span, 'invalid-model-schema')
                                    if schema_repairs < int(os.environ.get('A11Y_ARGUMENT_REPAIRS', '1')) and attempt + 1 < max_attempts:
                                        schema_repairs += 1
                                        feedback = schema_feedback(output_format, content, exc)
                                        self._ledger.write({'event': 'schema-repair', 'callId': span['id'], 'feedback': feedback})
                                        kwargs['messages'] = [*kwargs['messages'], {'role': 'assistant', 'content': content}, {'role': 'user', 'content': feedback}]
                                        continue
                                    raise
                        return response
                    except Exception as exc:
                        if isinstance(exc, ProviderOutputLimitError):
                            raise
                        code = getattr(exc, 'status_code', None)
                        if record_terminal(exc):
                            self.provider_error = f'{type(exc).__name__}: {exc}'
                            raise
                        if code not in (None, 429, 500, 502, 503, 504) or attempt + 1 == max_attempts:
                            raise
                        with self._ledger.span('wait', 'provider-backoff'):
                            await asyncio.sleep(min(60, 2 ** attempt))
            self._wrapped_client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
        return self._wrapped_client

    async def ainvoke(self, *args, **kwargs):
        before = len(self._ledger.records)
        output_format = kwargs.get('output_format', args[1] if len(args) > 1 else None)
        schema_token = self._schema_context.set(output_format)
        try:
            return await super().ainvoke(*args, **kwargs)
        except Exception:
            for record in self._ledger.records[before:]:
                if record['kind'] == 'llm':
                    self._ledger.exclude(record, 'failed-model-invocation')
            raise
        finally:
            self._schema_context.reset(schema_token)

    def api_summary(self):
        return summarize_ledger(self._ledger.records)

def schema_feedback(output_format, content, error):
    chosen = None
    try:
        payload = json.loads(content)
        chosen = next(iter(payload['action'][0]))
    except (ValueError, KeyError, IndexError, TypeError, StopIteration):
        pass
    errors = error.errors(include_input=False, include_url=False)
    relevant = [e for e in errors if chosen and chosen in e.get('loc', ())] or errors
    compact = '; '.join((str(e['loc']) + ': ' + e['msg'] for e in relevant[:4]))[:1000]
    schema = output_format.model_json_schema()
    fields = set()

    def visit(value):
        if isinstance(value, dict):
            prop = (value.get('properties') or {}).get(chosen)
            if isinstance(prop, dict):
                ref = prop.get('$ref', '')
                target = schema.get('$defs', {}).get(ref.split('/')[-1], {}) if ref.startswith('#/$defs/') else prop
                fields.update((target.get('properties') or {}).keys())
            for v in value.values():
                visit(v)
        elif isinstance(value, list):
            for v in value:
                visit(v)
    if chosen:
        visit(schema)
    return 'Your previous response did not match the required JSON schema. ' + compact + (f' Valid argument fields for {chosen}: {sorted(fields)}.' if fields else '') + ' Return a corrected response matching the supplied schema.'
