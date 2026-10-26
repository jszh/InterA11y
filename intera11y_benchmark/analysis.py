"""Case-level confusion counts, model means, and model ranges."""
from collections import Counter, defaultdict
from pathlib import Path
import csv
import json
import statistics
from .experiments import CATEGORIES, EXPERIMENTS, includes

ROOT = Path(__file__).resolve().parents[1]


def read_csv(path):
    with Path(path).open(newline='') as stream:
        return list(csv.DictReader(stream))


def counts_metrics(items):
    counts = Counter(('TP' if truth else 'FP') if flagged else ('FN' if truth else 'TN')
                     for truth, flagged in items)
    tp, fp, fn, tn = [counts[key] for key in ['TP', 'FP', 'FN', 'TN']]
    return dict(N=len(items), positives=tp+fn, negatives=fp+tn, TP=tp, FP=fp, FN=fn, TN=tn,
        precision=tp/(tp+fp) if tp+fp else None, recall=tp/(tp+fn) if tp+fn else None,
        fpr=fp/(fp+tn) if fp+tn else None, fdr=fp/(tp+fp) if tp+fp else None,
        f1=2*tp/(2*tp+fp+fn) if 2*tp+fp+fn else None)


def analyze(experiment, predictions=None, labels=None):
    spec = EXPERIMENTS[experiment]
    element_rows = read_csv(labels or ROOT/'datasets'/spec['dataset']/'elements.csv')
    elements = {r['case_id']: r for r in element_rows}
    if len(elements) != len(element_rows):
        raise ValueError('Duplicate labeled case IDs.')
    if any(r['label'] not in ['0', '1'] for r in element_rows):
        raise ValueError('Labels must be 0 or 1.')
    predicted = read_csv(predictions or ROOT/'results'/(spec['dataset']+'-predictions.csv'))
    selected = [r for r in predicted if includes(experiment, r)]
    groups = defaultdict(dict)
    for row in selected:
        if row['case_id'] not in elements:
            raise ValueError('Unknown prediction case: '+row['case_id'])
        if row['flagged'] not in ['0', '1']:
            raise ValueError('flagged must be 0 or 1')
        key = (row['system'], row['condition'], row['model'])
        if row['case_id'] in groups[key]:
            raise ValueError('Duplicate case prediction: '+str(key)+' '+row['case_id'])
        groups[key][row['case_id']] = row
    rows = []
    scopes = {'All': set(elements)}
    scopes.update({name: {cid for cid, e in elements.items() if e['sc'] in scs} for name, scs in CATEGORIES.items()})
    scopes.update({sc: {cid for cid, e in elements.items() if e['sc'] == sc} for sc in sorted({e['sc'] for e in elements.values()}, key=lambda s: tuple(map(int, s.split('.'))))})
    for (system, condition, model), by_case in sorted(groups.items()):
        for scope, ids in scopes.items():
            items = [(elements[cid]['label'] == '1', by_case.get(cid, {}).get('flagged') == '1') for cid in ids]
            statuses = Counter(by_case[cid].get('state', 'complete') if cid in by_case else 'missing' for cid in ids)
            rows.append(dict(system=system, condition=condition, model=model, scope=scope,
                             states=dict(statuses), **counts_metrics(items)))
    means = defaultdict(list)
    for row in rows:
        means[row['system'], row['condition'], row['scope']].append(row)
    aggregates = []
    for (system, condition, scope), values in means.items():
        summary = dict(system=system, condition=condition, scope=scope, N=values[0]['N'],
                       models=[v['model'] for v in values])
        for metric in ['precision', 'recall', 'fpr', 'fdr', 'f1']:
            defined = [v[metric] for v in values if v[metric] is not None]
            summary[metric] = dict(mean=statistics.mean(defined) if defined else None,
                min=min(defined) if defined else None, max=max(defined) if defined else None,
                range=max(defined)-min(defined) if defined else None, defined_models=len(defined))
        aggregates.append(summary)
    return dict(experiment=spec['title'], dataset=spec['dataset'], N=len(elements),
        policy='Each case contributes once. Missing, failed, and unsupported evaluations remain unflagged. Model means use defined values; ranges are min-max across models. FDR is FP/(TP+FP), not FPR.',
        per_model=rows, across_models=aggregates,
        resources=resource_summary(experiment) if not predictions and spec['dataset']=='expert' else [])


def resource_summary(experiment):
    path = ROOT/'results/resources.csv'
    groups = defaultdict(list)
    if not path.exists():
        return []
    for row in read_csv(path):
        if includes(experiment, row):
            groups[row['system'], row['condition'], row['model']].append(row)
    result = []
    for (system, condition, model), rows in sorted(groups.items()):
        entry = dict(system=system, condition=condition, model=model, cases=len(rows))
        for field in ['input_tokens','output_tokens','total_tokens','llm_seconds',
                      'tool_seconds','browser_harness_seconds','total_seconds']:
            values = [float(r[field]) for r in rows if r[field] != '']
            entry[field] = dict(N=len(values), mean=statistics.mean(values) if values else None,
                                sd=statistics.stdev(values) if len(values)>1 else None)
        result.append(entry)
    return result


def write_analysis(result, output):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    (output/'metrics.json').write_text(json.dumps(result, indent=2, ensure_ascii=False)+'\n')
    fields = ['scope', 'system', 'condition', 'model', 'N', 'positives', 'negatives', 'TP', 'FP', 'FN', 'TN', 'precision', 'recall', 'fpr', 'fdr', 'f1']
    with (output/'metrics.csv').open('w', newline='') as stream:
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        writer.writerows({k: row[k] for k in fields} for row in result['per_model'])
    return output/'metrics.json'
