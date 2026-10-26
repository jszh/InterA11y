"""Portable experiment dispatch with separate inputs and labels."""
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import csv
import json
import os
import shutil
import subprocess
import threading
import time
import uuid
from .analysis import read_csv
from .experiments import CHECKERS, EXPERIMENTS, conditions
from .providers import load_env, model_id

ROOT = Path(__file__).resolve().parents[1]


def node_json(script, payload):
    process = subprocess.run(['node', str(ROOT/script)], input=json.dumps(payload), text=True,
                             capture_output=True, cwd=ROOT)
    try:
        result = json.loads(process.stdout)
    except ValueError:
        raise RuntimeError('Adapter did not return JSON: '+process.stderr[-1200:]) from None
    if process.returncode and result.get('state') != 'error':
        raise RuntimeError(result.get('error') or process.stderr[-1200:])
    return result


def safe_case(row, page_root=None):
    page = Path(row['page'])
    path = ROOT/page
    if not path.exists() and page_root:
        base = Path(page_root).resolve()
        candidates = [base/page, base/page.name]
        path = next((p for p in candidates if p.is_file()), path)
    if not path.is_file():
        raise FileNotFoundError('Missing page: '+row['page']+'. Import matching expert snapshots or set --page-root.')
    return dict(case_id=row['case_id'], sc=row['sc'], page=row['page'], url=path.resolve().as_uri(),
                scope=row['scope'], xpath=row['xpath'] if row['scope'] == 'element' else '')


def _ensemble(results, sc):
    configuration = json.loads((ROOT/'results/rule-ensemble.json').read_text())
    signals = {}
    for tool, result in results.items():
        if result.get('state') == 'error':
            continue
        # Adapters localize native rules to the case after producing findings.
        # An empty list is meaningful and must not fall back to page-wide data.
        signals[tool] = set(result.get('native_rules', []))
    terms = [term for term in configuration['terms'] if term['sc'] == sc
             and all(rule in signals.get(tool, set()) for tool, rule in term['allOf'])]
    return dict(flagged=bool(terms), findings=[dict(sc=sc, reason='Frozen rule ensemble', allOf=t['allOf']) for t in terms],
                state='complete', native_rules=[], usage=None, timing=None)


def run_experiment(experiment, systems=None, models=None, case_ids=None, limit=None,
                   output=None, workers=1, page_root=None, condition=None):
    load_env()
    spec = EXPERIMENTS[experiment]
    elements = read_csv(ROOT/'datasets'/spec['dataset']/'elements.csv')
    if case_ids:
        wanted = set(case_ids)
        if wanted-set(r['case_id'] for r in elements):
            raise ValueError('Unknown case ID')
        elements = [r for r in elements if r['case_id'] in wanted]
    if limit:
        elements = elements[:limit]
    systems = systems or spec['systems']
    if set(systems)-set(spec['systems']):
        raise ValueError('A system is outside this experiment: '+str(set(systems)-set(spec['systems'])))
    output = Path(output or ROOT/'outputs'/experiment).resolve()
    output.mkdir(parents=True, exist_ok=True)
    models = models or ['gemini', 'glm', 'luna', 'claude']
    for alias in models:
        model_id(alias)
    if condition and any(condition not in conditions(experiment, system) for system in systems):
        raise ValueError('The requested condition is outside the selected experiment/system.')
    plan = []
    for row in elements:
        case = safe_case(row, page_root)
        for system in systems:
            selected_conditions = [condition] if condition else conditions(experiment, system)
            for selected_condition in selected_conditions:
                for model in (['none'] if system in CHECKERS+['rule-ensemble'] else models):
                    plan.append((case, system, selected_condition, model))
    execution_locks, locks_guard = {}, threading.Lock()
    def execute(task):
        case, system, selected_condition, alias = task
        identity = (case['case_id'], system, selected_condition, alias)
        with locks_guard:
            lock = execution_locks.setdefault(identity, threading.RLock())
        with lock:
            return execute_locked(task)
    def execute_locked(task):
        case, system, selected_condition, alias = task
        resolved = model_id(alias) if alias != 'none' else None
        identity = json.dumps([case, system, selected_condition, resolved], sort_keys=True)
        folder = output/'runs'/str(uuid.uuid5(uuid.NAMESPACE_URL, identity))
        folder.mkdir(parents=True, exist_ok=True)
        saved = folder/'result.json'
        if saved.exists():
            previous = json.loads(saved.read_text())
            if previous.get('state') in ['complete', 'partial', 'not_applicable', 'unsupported']:
                return previous
        attempt = 1+len(list(folder.glob('attempt-*.json')))
        started = time.perf_counter()
        options = dict(model=resolved, output_dir=str(folder/'artifacts'/f'attempt-{attempt}'),
                       condition=selected_condition, effort='high', llmConcurrency=1)
        try:
            from adapters.registry import run as run_adapter
            if system == 'intera11y' and selected_condition in ['deterministic', 'deterministic-rubrics']:
                base_condition = 'default' if selected_condition == 'deterministic' else 'rubrics'
                base_system = 'gena11y' if selected_condition == 'deterministic' else 'intera11y'
                baseline = execute((case, base_system, base_condition, alias))
                full = execute((case, 'intera11y', 'full', alias))
                result = node_json('runtime/combine.cjs', dict(baseline=baseline, full=full))
            elif system == 'intera11y' and selected_condition == 'rubrics':
                result = run_adapter('ia-rubrics', case, options)
            elif system == 'intera11y':
                result = node_json('runtime/run-intera11y.cjs', dict(url=case['url'], sc=case['sc'],
                    targets=[dict(scope=case['scope'], xpath=case['xpath'])], condition='full',
                    model=resolved, outputDir=options['output_dir'], options=options))
            elif system == 'rule-ensemble':
                native = {tool: execute((case, tool, 'default', 'none')) for tool in CHECKERS}
                result = _ensemble(native, case['sc'])
            else:
                result = run_adapter(system, case, options)
            result = {**result, 'case_id':case['case_id'], 'system':system, 'condition':selected_condition,
                      'model':alias, 'sc':case['sc'], 'url':case['url'], 'wall_seconds':time.perf_counter()-started}
            if result.get('flagged') is None:
                raise ValueError('Adapter did not return flagged')
        except Exception as error:
            result = dict(case_id=case['case_id'], system=system, condition=selected_condition, model=alias,
                          sc=case['sc'], url=case['url'], state='error', flagged=False, findings=[],
                          error=str(error), wall_seconds=time.perf_counter()-started)
        (folder/f'attempt-{attempt:02d}.json').write_text(json.dumps(result, indent=2, ensure_ascii=False)+'\n')
        saved.write_text(json.dumps(result, indent=2, ensure_ascii=False)+'\n')
        return result
    results = []
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        for future in as_completed([pool.submit(execute, task) for task in plan]):
            item = future.result()
            results.append(item)
            print(json.dumps(dict(completed=len(results), total=len(plan), case_id=item['case_id'],
                                 system=item['system'], model=item['model'], state=item['state'])), flush=True)
    with (output/'predictions.csv').open('w', newline='') as stream:
        fields = ['case_id', 'system', 'condition', 'model', 'flagged', 'state']
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        for r in results:
            writer.writerow({**{k:r[k] for k in fields}, 'flagged':int(bool(r['flagged']))})
    (output/'results.json').write_text(json.dumps(results, indent=2, ensure_ascii=False)+'\n')
    return dict(output=str(output), cases=len(elements), evaluations=len(results),
                errors=sum(r['state']=='error' for r in results))
