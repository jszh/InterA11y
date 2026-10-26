from contextlib import contextmanager, asynccontextmanager, nullcontext
import asyncio
import fcntl
import json
import os
from pathlib import Path
import re
import threading
import time

class ProviderBlocked(RuntimeError):

    def __init__(self, message, status_code=402):
        self.status_code = status_code
        super().__init__(message)

def native_failure(row, system):
    if row.get('error'):
        return str(row['error'])
    if system == 'ia':
        scs = (row.get('case') or {}).get('scs') or []
        criterion = row.get('criteria', {}).get(scs[0] if scs else '', {})
        if criterion.get('error'):
            return str(criterion['error'])
        if criterion.get('verdict') not in ('PASS', 'FAIL', 'INCOMPLETE', 'NOT_APPLICABLE'):
            return 'Missing assessment'
        if (criterion.get('screen') or {}).get('failedCalls'):
            return 'Failed screening calls'
        if (criterion.get('judgeUsage') or {}).get('failedCalls'):
            return 'Failed judge calls'
        if any((v.get('completeness') == 'failed' for v in criterion.get('coverage', {}).values())):
            return 'Failed probe'
    elif system == 'ag' and row.get('componentErrors'):
        return 'Required AccessGuru component failed: ' + str(row['componentErrors'])
    elif system == 'gen':
        assessment = row.get('gena11y') or {}
        if assessment.get('error'):
            return str(assessment['error'])
        summary = str(assessment.get('summary') or '')
        incomplete = re.search('\\[(\\d+) of \\d+ chunks returned no verdict\\]\\s*$', summary)
        if incomplete and int(incomplete.group(1)) > 0:
            return 'Incomplete GenA11y chunk evaluation: ' + summary[-1600:]
        if row.get('verdict') not in ('PASS', 'FAIL', 'UNDETERMINED'):
            return 'Missing assessment'
    elif system in ('bu', 'al') and row.get('verdict') not in ('PASS', 'FAIL', 'UNDETERMINED'):
        return 'Missing assessment'
    elif system in ('bu', 'al'):
        from final_assessment_validation import final_assessment_error
        evidence_ids = ((row.get('memoryState') or {}).get('results') or {}).keys() if system == 'al' and row.get('memoryState') else None
        return final_assessment_error(row.get('assessment'), evidence_ids=evidence_ids)
    return None

def terminal_code(value):
    code = getattr(value, 'status_code', None)
    if code is None:
        code = getattr(getattr(value, 'response', None), 'status_code', None)
    if isinstance(value, dict):
        error = value.get('error', value)
        code = error.get('code') if isinstance(error, dict) else None
    if str(code) in ('401', '402', '403'):
        return int(code)
    match = re.search('(?:http[- :]|error code:|status[ _-]?code[=: ]+)\\s*(401|402|403)\\b', str(value), re.I)
    return int(match[1]) if match else None

def marker_path():
    path = os.environ.get('A11Y_PROVIDER_HEALTH_PATH')
    return Path(path) if path else None

def blocked():
    path = marker_path()
    if path:
        try:
            return json.loads(path.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            pass
    return None

def ensure_provider_available():
    state = blocked()
    if state:
        raise ProviderBlocked(state['reason'], state.get('statusCode', 402))

def record_terminal(value):
    code = terminal_code(value)
    if not code:
        return False
    path = marker_path()
    if path:
        path.parent.mkdir(parents=True, exist_ok=True)
        state = {'state': 'blocked', 'statusCode': code, 'atEpoch': time.time(), 'reason': f'OpenRouter HTTP {code}: provider admission blocked; inspect credits or credentials', 'pid': os.getpid()}
        temp = path.with_name(f'{path.name}.{os.getpid()}.{threading.get_ident()}.tmp')
        temp.write_text(json.dumps(state, indent=2))
        temp.replace(path)
    return True

def check_credits(api_key, post=None, recover=True):
    if not api_key:
        raise ProviderBlocked('OpenRouter API key is missing', 401)
    if post is None:
        import requests
        post = requests.get
    response = post('https://openrouter.ai/api/v1/credits', headers={'Authorization': 'Bearer ' + api_key}, timeout=30)
    if response.status_code in (401, 402, 403):
        record_terminal({'code': response.status_code})
    response.raise_for_status()
    data = response.json()['data']
    remaining = float(data['total_credits']) - float(data['total_usage'])
    if remaining <= 0:
        record_terminal({'code': 402})
        raise ProviderBlocked(f'OpenRouter HTTP 402: remaining credits {remaining:.6f}')
    path = marker_path()
    if recover and path and path.exists() and ((blocked() or {}).get('statusCode') == 402):
        path.unlink()
    return remaining

@contextmanager
def browser_startup(ledger=None):
    slots = int(os.environ.get('A11Y_BROWSER_STARTUP_SLOTS', '0'))
    if slots <= 0:
        yield
        return
    directory = Path(os.environ.get('A11Y_BROWSER_STARTUP_DIR', f'/tmp/a11y-browser-startup-{os.getuid()}'))
    directory.mkdir(parents=True, exist_ok=True)
    lease = None
    with ledger.span('wait', 'browser-startup-slot') if ledger else nullcontext():
        while lease is None:
            for index in range(slots):
                handle = (directory / f'{index}.lock').open('a')
                try:
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    lease = handle
                    break
                except BlockingIOError:
                    handle.close()
            if lease is None:
                time.sleep(0.1)
    try:
        yield
    finally:
        fcntl.flock(lease, fcntl.LOCK_UN)
        lease.close()

@asynccontextmanager
async def async_browser_startup(ledger=None):
    slots = int(os.environ.get('A11Y_BROWSER_STARTUP_SLOTS', '0'))
    if slots <= 0:
        yield
        return
    directory = Path(os.environ.get('A11Y_BROWSER_STARTUP_DIR', f'/tmp/a11y-browser-startup-{os.getuid()}'))
    directory.mkdir(parents=True, exist_ok=True)
    lease = None
    with ledger.span('wait', 'browser-startup-slot') if ledger else nullcontext():
        while lease is None:
            for index in range(slots):
                handle = (directory / f'{index}.lock').open('a')
                try:
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    lease = handle
                    break
                except BlockingIOError:
                    handle.close()
            if lease is None:
                await asyncio.sleep(0.1)
    try:
        yield
    finally:
        fcntl.flock(lease, fcntl.LOCK_UN)
        lease.close()
