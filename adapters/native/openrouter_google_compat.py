import base64
import os
from types import SimpleNamespace
import time
import requests
from transport_settings import chat_base_url
from execution_health import ensure_provider_available, record_terminal, terminal_code, ProviderBlocked
from openrouter_usage import normalize_response, summarize_ledger
from openrouter_request_policy import provider_policy, ProviderOutputLimitError

class OpenRouterGoogleCompat:

    def __init__(self, api_key, effort, ledger):
        self.api_key, self.effort, self.ledger = (api_key, effort, ledger)
        self.models = self
        self.api_responses = []

    def api_summary(self):
        return summarize_ledger(self.ledger.records)

    def generate_content(self, *, model, contents, config):
        content = []
        for part in contents:
            if part.text is not None:
                content.append({'type': 'text', 'text': part.text})
            elif part.inline_data is not None:
                data = part.inline_data
                content.append({'type': 'image_url', 'image_url': {'url': f'data:{data.mime_type};base64,' + base64.b64encode(data.data).decode()}})
        body = {**{}, 'model': model, 'messages': [{'role': 'user', 'content': content}], 'temperature': 0, 'usage': {'include': True}, 'reasoning': {'effort': self.effort}, 'provider': {'require_parameters': True}, 'response_format': {'type': 'json_schema', 'json_schema': {'name': 'decision', 'strict': True, 'schema': config.response_json_schema}}}
        max_attempts = max(1, int(os.environ.get('A11Y_HTTP_MAX_ATTEMPTS', '2')))
        for attempt in range(max_attempts):
            ensure_provider_available()
            body['provider'] = provider_policy(model, body['provider'])
            with self.ledger.span('llm', 'openrouter-chat-completions', attempt=attempt, providerRouting=body['provider'], clientOutputTokenCap=None) as span:
                response = requests.post(chat_base_url() + '/chat/completions', json=body, headers={'Authorization': 'Bearer ' + self.api_key}, timeout=900)
                if response.status_code == 429 or response.status_code >= 500:
                    self.ledger.exclude(span, 'provider-error')
                    raw = None
                else:
                    if response.status_code in (401, 402, 403):
                        record_terminal({'code': response.status_code})
                    response.raise_for_status()
                    raw = response.json()
                    if raw.get('usage'):
                        usage = normalize_response(raw)
                        self.api_responses.append(usage)
                        span['usage'] = usage
                        self.ledger.write({'event': 'usage', 'id': span['id'], 'usage': usage})
                    if record_terminal(raw):
                        raise ProviderBlocked(f"OpenRouter HTTP {terminal_code(raw)}: {raw.get('error')}", terminal_code(raw))
                    if raw.get('error') or not raw.get('choices'):
                        self.ledger.exclude(span, 'upstream-error')
                        raw = None
                    elif raw['choices'][0].get('finish_reason') == 'error':
                        self.ledger.exclude(span, 'upstream-finish-error')
                        raw = None
                    elif raw['choices'][0].get('finish_reason') == 'length':
                        raise ProviderOutputLimitError('Provider truncated the response at its own limit; no client output-token cap or budget-doubling retry is configured')
            if raw is not None:
                break
            if attempt + 1 == max_attempts:
                raise RuntimeError('OpenRouter retries exhausted')
            with self.ledger.span('wait', 'provider-backoff'):
                time.sleep(min(60, 2 ** attempt))
        choice = raw['choices'][0]
        message = choice.get('message') or {}
        usage = normalize_response(raw)
        metadata = SimpleNamespace(prompt_token_count=usage['input_tokens'], candidates_token_count=usage['visible_output_tokens'] if usage['visible_output_tokens'] is not None else usage['output_tokens'], thoughts_token_count=usage['reasoning_tokens'], cached_content_token_count=usage['cache_read_input_tokens'])
        return SimpleNamespace(text=message.get('content'), usage_metadata=metadata, candidates=[SimpleNamespace(finish_reason=choice.get('finish_reason'))], prompt_feedback=None, model_dump=lambda **kwargs: raw)
