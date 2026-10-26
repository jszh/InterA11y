#!/usr/bin/env python3
"""Validate saved pages, labels, and complete prediction coverage."""
import csv
import json
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXPECTED = {'conformance': (682, 316, 366), 'expert': (197, 107, 90)}
CRITERIA = {'1.1.1', '1.4.1', '1.4.13', '2.1.1', '2.1.2',
            '2.4.3', '2.4.4', '2.4.7', '3.3.1', '4.1.3'}


def rows(path):
    with path.open(newline='') as handle:
        return list(csv.DictReader(handle))


def page_file(name):
    path = Path(name)
    assert not path.is_absolute() and '..' not in path.parts, name
    path = ROOT / path
    assert path.is_file() and path.stat().st_size > 0, name
    return path


def validate():
    summary = {}
    for dataset, expected in EXPECTED.items():
        elements = rows(ROOT / 'datasets' / dataset / 'elements.csv')
        labels = {row['case_id']: row['label'] for row in elements}
        assert len(labels) == len(elements), f'{dataset}: duplicate case IDs'
        assert set(labels.values()) == {'0', '1'}, f'{dataset}: invalid labels'
        actual = (len(elements), sum(value == '1' for value in labels.values()),
                  sum(value == '0' for value in labels.values()))
        assert actual == expected, (dataset, actual, expected)
        assert {row['sc'] for row in elements} == CRITERIA
        for row in elements:
            assert row['scope'] in ('element', 'page')
            assert row['scope'] != 'element' or row['xpath'], row['case_id']
            assert row['scope'] != 'page' or not row['xpath'], row['case_id']
            path = page_file(row['page'])
            if dataset == 'conformance':
                text = path.read_text()
                assert '<!--' not in text, row['case_id']
        manifest = rows(ROOT / 'datasets' / dataset / 'pages.csv')
        paths = {row['page'] for row in manifest}
        assert len(paths) == len(manifest) == (682 if dataset == 'conformance' else 54)
        assert paths == {row['page'] for row in elements}
        for row in manifest:
            path = page_file(row['page'])
            if row.get('bytes'):
                assert path.stat().st_size == int(row['bytes']), row['page']
        if dataset == 'conformance':
            assert {row['case_id'] for row in manifest} == set(labels)
            pages_by_case = {row['case_id']: row['page'] for row in elements}
            assert all(pages_by_case[row['case_id']] == row['page'] for row in manifest)
        predictions = rows(ROOT / 'results' / (dataset + '-predictions.csv'))
        groups = defaultdict(list)
        for row in predictions:
            assert row['case_id'] in labels
            assert row['flagged'] in ('0', '1')
            groups[row['system'], row['condition'], row['model']].append(row['case_id'])
        for condition, case_ids in groups.items():
            assert len(set(case_ids)) == len(case_ids) == len(labels), (dataset, condition)
            assert set(case_ids) == set(labels), (dataset, condition)
        native_rules = defaultdict(lambda: defaultdict(set))
        for finding in rows(ROOT / 'results' / 'native-rule-findings.csv'):
            if finding['dataset'] == dataset:
                native_rules[finding['case_id']][finding['tool']].add(finding['rule'])
        configuration = json.loads((ROOT / 'results' / 'rule-ensemble.json').read_text())
        criteria = {row['case_id']: row['sc'] for row in elements}
        for prediction in predictions:
            if prediction['system'] != 'rule-ensemble':
                continue
            signal = native_rules[prediction['case_id']]
            detected = any(term['sc'] == criteria[prediction['case_id']]
                           and all(rule in signal[tool] for tool, rule in term['allOf'])
                           for term in configuration['terms'])
            assert detected == bool(int(prediction['flagged'])), prediction['case_id']
        summary[dataset] = dict(cases=actual[0], pages=len(paths), positive=actual[1], negative=actual[2],
                                configurations=len(groups), predictions=len(predictions),
                                sc_counts=dict(sorted(Counter(row['sc'] for row in elements).items())))
    resources = rows(ROOT / 'results' / 'resources.csv')
    identities = {(row['case_id'], row['system'], row['condition'], row['model'])
                  for row in resources}
    assert len(identities) == len(resources) == 197 * 7 * 4
    for row in resources:
        if row['token_state'] == 'recorded':
            assert abs(float(row['input_tokens']) + float(row['output_tokens'])
                       - float(row['total_tokens'])) < 1e-7
        if row['time_state'] == 'recorded':
            assert abs(float(row['llm_seconds']) + float(row['tool_seconds'])
                       + float(row['browser_harness_seconds'])
                       - float(row['total_seconds'])) < 1e-7
    return summary


if __name__ == '__main__':
    print(json.dumps(validate(), indent=2))
