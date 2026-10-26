"""OpenRouter chat transport and provider-reported usage accounting."""
from pathlib import Path
import datetime
import json
import os
import ssl
import time
import urllib.error
import urllib.request

BASE_URL = 'https://openrouter.ai/api/v1'
MODEL_DEFAULTS = {
    'gemini': ('OPENROUTER_MODEL_GEMINI', 'google/gemini-3.7-flash'),
    'luna': ('OPENROUTER_MODEL_OPENAI', 'openai/gpt-6-luna'),
    'claude': ('OPENROUTER_MODEL_CLAUDE', 'anthropic/claude-haiku-5.5'),
    'glm': ('OPENROUTER_MODEL_GLM', 'z-ai/glm-5.3-flash'),
}


def load_env(path=None):
    path = Path(path or Path(__file__).resolve().parents[1]/'.env')
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        key, value = key.strip(), value.strip()
        if value:
            os.environ.setdefault(key, value.strip('\"\''))


def model_id(alias):
    if alias in MODEL_DEFAULTS:
        key, default = MODEL_DEFAULTS[alias]
        return os.environ.get(key) or default
    if '/' not in alias or alias.startswith(('http:', 'https:')):
        raise ValueError('Use a configured model alias or an explicit OpenRouter model ID.')
    return alias


def usage_record(usage):
    usage = usage or {}
    prompt = usage.get('prompt_tokens_details') or {}
    output = usage.get('completion_tokens_details') or {}
    return dict(input_tokens=usage.get('prompt_tokens'), output_tokens=usage.get('completion_tokens'),
        total_tokens=usage.get('total_tokens'), reasoning_tokens=output.get('reasoning_tokens'),
        cached_input_tokens=prompt.get('cached_tokens'), cache_write_tokens=prompt.get('cache_write_tokens'),
        cost_usd=usage.get('cost'), cost_details=usage.get('cost_details'), raw=usage)


class OpenRouterError(RuntimeError):
    def __init__(self, message, status=None, retry_after=None):
        super().__init__(message)
        self.status, self.retry_after = status, retry_after


class OpenRouterClient:
    def __init__(self, api_key=None, model=None, timeout=600, max_retries=0, ledger_path=None):
        load_env()
        self.api_key = api_key or os.environ.get('OPENROUTER_API_KEY')
        self.model = model_id(model) if model else None
        self.timeout, self.max_retries = timeout, max_retries
        self.ledger_path = Path(ledger_path) if ledger_path else None
        if not 0 <= max_retries <= 2:
            raise ValueError('max_retries must be between zero and two.')

    def _record(self, record):
        if self.ledger_path:
            self.ledger_path.parent.mkdir(parents=True, exist_ok=True)
            with self.ledger_path.open('a') as stream:
                stream.write(json.dumps(record, ensure_ascii=False)+'\n')

    def chat(self, messages, model=None, tools=None, **kwargs):
        if not self.api_key:
            raise OpenRouterError('Fill OPENROUTER_API_KEY in .env.')
        selected = model_id(model) if model else self.model
        if not selected:
            raise ValueError('A model is required.')
        if any(k in kwargs for k in ['base_url', 'api_base', 'api_key', 'models', 'route']):
            raise ValueError('Only the configured OpenRouter endpoint and one explicit model are supported.')
        if kwargs.get('stream'):
            raise ValueError('Use non-streaming chat for complete usage accounting.')
        body = dict(kwargs, model=selected, messages=messages, stream=False, usage={'include': True})
        body['provider'] = {**body.get('provider', {}), 'allow_fallbacks': False}
        if tools is not None:
            body['tools'] = tools
        request = urllib.request.Request(BASE_URL+'/chat/completions',
            data=json.dumps(body).encode(), method='POST',
            headers={'Authorization':'Bearer '+self.api_key, 'Content-Type':'application/json',
                     'X-Title':'InterA11y'})
        for attempt in range(self.max_retries+1):
            started = time.perf_counter()
            at = datetime.datetime.now(datetime.timezone.utc).isoformat()
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    result = json.load(response)
                elapsed = time.perf_counter()-started
                if result.get('error'):
                    raise OpenRouterError(str(result['error']).replace(self.api_key, '[redacted]'))
                if not result.get('choices'):
                    raise OpenRouterError('OpenRouter returned no choices.')
                telemetry = dict(at=at, requested_model=selected, returned_model=result.get('model'),
                    generation_id=result.get('id'), attempt=attempt+1, successful=True,
                    llm_seconds=elapsed, **usage_record(result.get('usage')))
                result['_telemetry'] = telemetry
                self._record(telemetry)
                return result
            except (urllib.error.URLError, TimeoutError, OpenRouterError) as error:
                status = getattr(error, 'code', None) or getattr(error, 'status', None)
                if isinstance(error, urllib.error.HTTPError):
                    try:
                        detail = json.loads(error.read()).get('error', {})
                        message = str(detail.get('message', detail)) if isinstance(detail, dict) else str(detail)
                    except (ValueError, OSError):
                        message = str(error)
                else:
                    message = str(error)
                message = message.replace(self.api_key, '[redacted]')
                self._record(dict(at=at, requested_model=selected, attempt=attempt+1,
                    successful=False, llm_seconds=time.perf_counter()-started, status=status, error=message))
                retry = status in [429, 500, 502, 503, 504] and attempt < self.max_retries
                if not retry:
                    raise OpenRouterError(message, status=status) from None
                time.sleep(min(2**attempt, 4))
