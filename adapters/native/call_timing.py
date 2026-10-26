from contextlib import contextmanager
from contextvars import ContextVar
import json
from pathlib import Path
import threading
import time
import uuid
VERSION = 'successful-service-v2'
_current = ContextVar('a11y_timing_span', default=None)

def union(intervals):
    result = []
    for a, b in sorted(((a, b) for a, b in intervals if b > a)):
        if result and a <= result[-1][1]:
            result[-1][1] = max(result[-1][1], b)
        else:
            result.append([a, b])
    return result

def subtract(intervals, blockers):
    result = []
    for start, end in union(intervals):
        cursor = start
        for a, b in union(blockers):
            if b <= cursor:
                continue
            if a >= end:
                break
            if a > cursor:
                result.append([cursor, min(a, end)])
            cursor = max(cursor, b)
            if cursor >= end:
                break
        if cursor < end:
            result.append([cursor, end])
    return result

def milliseconds(intervals):
    return sum((b - a for a, b in union(intervals)))

class TimingLedger:

    def __init__(self, path=None, clock=time.monotonic):
        self.path = Path(path) if path else None
        self.clock = clock
        self.origin = clock()
        self.records = []
        self.lock = threading.RLock()

    @contextmanager
    def span(self, kind, name, **metadata):
        parent = _current.get()
        record = dict(version=VERSION, id=uuid.uuid4().hex, parentId=parent['id'] if parent and parent.get('_ledger') is self else None, kind=kind, name=name, startMs=(self.clock() - self.origin) * 1000, accepted=True, **metadata)
        record['_ledger'] = self
        token = _current.set(record)
        with self.lock:
            self.records.append(record)
        try:
            yield record
        except BaseException as exc:
            record.update(accepted=False, exclusionReason=f'{type(exc).__name__}: {exc}')
            raise
        finally:
            record['endMs'] = (self.clock() - self.origin) * 1000
            record['elapsedMs'] = record['endMs'] - record['startMs']
            _current.reset(token)
            self.write(record)

    def write(self, record):
        if self.path:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.lock, self.path.open('a') as out:
                out.write(json.dumps({k: v for k, v in record.items() if not k.startswith('_')}, ensure_ascii=False) + '\n')

    def exclude(self, record, reason):
        record.update(accepted=False, exclusionReason=reason)
        self.write({'event': 'eligibility', 'id': record['id'], 'accepted': False, 'exclusionReason': reason})

    def import_remote(self, parent, timing, dispatch_wait_ms=0):
        parent['successfulProcessingOverrideMs'] = timing['successfulProcessingMs']
        parent['remoteTiming'] = timing
        origin = parent['startMs'] + dispatch_wait_ms
        spans = [('infra', 'remote-infrastructure', a, b) for a, b in timing.get('exclusiveInfrastructureIntervals', [])]
        spans += [('wait', w['kind'], w['startMs'], w['endMs']) for w in timing.get('resourceWaitIntervals', [])]
        if dispatch_wait_ms:
            spans.append(('wait', 'bridge-dispatch', -dispatch_wait_ms, 0))
        for kind, name, a, b in spans:
            row = dict(version=VERSION, id=uuid.uuid4().hex, parentId=parent['id'], kind=kind, name=name, accepted=True, startMs=origin + a, endMs=origin + b, elapsedMs=b - a)
            self.records.append(row)
            self.write(row)

    @contextmanager
    def acquire(self, semaphore, name):
        with self.span('wait', name):
            semaphore.acquire()
        try:
            yield
        finally:
            semaphore.release()

    def summary(self):
        records = [r for r in self.records if 'endMs' in r]
        return summarize(records)

def summarize(records):
    by_id = {r['id']: dict(r) for r in records if 'id' in r and 'endMs' in r}
    for r in records:
        if r.get('event') == 'eligibility' and r.get('id') in by_id:
            by_id[r['id']].update(r)
    children = {}
    for r in by_id.values():
        children.setdefault(r.get('parentId'), []).append(r)
    productive, infra, waits, excluded = ([], [], [], [])
    raw_waits = [[r['startMs'], r['endMs']] for r in by_id.values() if r['kind'] == 'wait']

    def cost(row, lower=float('-inf'), upper=float('inf')):
        a, b = (max(lower, row['startMs']), min(upper, row['endMs']))
        if b <= a:
            return 0
        own = [[a, b]]
        nested = children.get(row['id'], [])
        if row['kind'] == 'wait':
            waits.append([a, b])
            return 0
        if not row.get('accepted', True):
            excluded.append([a, b])
            return 0
        own = subtract(own, [[max(a, c['startMs']), min(b, c['endMs'])] for c in nested])
        if row['kind'] == 'infra':
            infra.extend(own)
            groups = {}
            for child in nested:
                group = child.get('parallelGroup') or child['id']
                groups.setdefault(group, []).append(cost(child, a, b))
            return sum((max(values) for values in groups.values()))
        productive.extend(own)
        groups = {}
        for child in nested:
            value = cost(child, a, b)
            group = child.get('parallelGroup') or child['id']
            groups.setdefault(group, []).append(value)
        child_cost = sum((max(values) for values in groups.values()))
        override = row.get('successfulProcessingOverrideMs')
        return override if override is not None else milliseconds(own) + child_cost
    totals = [cost(r) for r in children.get(None, [])]
    exclusive_infra = subtract(infra, productive)
    raw_wait_kinds = {r['name'] for r in by_id.values() if r['kind'] == 'wait'}
    return dict(version=VERSION, wallMs=milliseconds([[r['startMs'], r['endMs']] for r in children.get(None, [])]), successfulProcessingMs=sum(totals), exclusiveInfrastructureMs=milliseconds(exclusive_infra), accountedMs=sum(totals) + milliseconds(exclusive_infra), recordedWaitMs=milliseconds(raw_waits), excludedAttemptMs=milliseconds(excluded), recordedWaitMsByKind={kind: milliseconds([[r['startMs'], r['endMs']] for r in by_id.values() if r['kind'] == 'wait' and r['name'] == kind]) for kind in raw_wait_kinds}, calls=sum((r['kind'] in ('llm', 'tool') for r in by_id.values())), excludedCalls=sum((r['kind'] in ('llm', 'tool') and (not r.get('accepted', True)) for r in by_id.values())), infrastructureIntervals=union(exclusive_infra))

def load_summary(path):
    path = Path(path)
    if not path.exists():
        return None
    return summarize([json.loads(line) for line in path.open()])

def write_run_infrastructure(path, name, started_at, finished_at=None):
    finished_at = time.monotonic() if finished_at is None else finished_at
    path = Path(path)
    data = json.loads(path.read_text()) if path.exists() else {'version': VERSION, 'scope': 'run; counted once per invocation, not allocated to cases', 'calls': []}
    if data.get('version') != VERSION:
        raise ValueError('Infrastructure timing version differs; use a fresh output directory')
    data['calls'].append(dict(name=name, startedAtMonotonicMs=started_at * 1000, returnedAtMonotonicMs=finished_at * 1000, exclusiveInfrastructureMs=(finished_at - started_at) * 1000))
    data['exclusiveInfrastructureMs'] = sum((c['exclusiveInfrastructureMs'] for c in data['calls']))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + '\n')
