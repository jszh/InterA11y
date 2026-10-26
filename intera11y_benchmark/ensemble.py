"""Fit SC-specific monotone combinations of native violation rules on conformance cases."""
from __future__ import annotations
import argparse
import csv
import json
from pathlib import Path

from .experiments import CHECKERS, CRITERIA


def _read(path):
    with Path(path).open(newline='') as stream:
        return list(csv.DictReader(stream))


def _inputs(native_rules_csv, elements_csv, tools=None, *, training=True):
    elements = _read(elements_csv)
    if not elements:
        raise ValueError('The conformance training set is empty.')
    expert = [row.get('source', '').lower() == 'expert' or row.get('dataset', '').lower() == 'expert' for row in elements]
    if training and any(expert):
        raise ValueError('Fit the ensemble on conformance data; Expert labels are evaluation only.')
    if any(expert) and not all(expert):
        raise ValueError('Use one dataset per element table.')
    dataset = 'expert' if all(expert) else 'conformance'
    cases = {}
    for row in elements:
        if row['case_id'] in cases:
            raise ValueError('Duplicate conformance case: ' + row['case_id'])
        if row['sc'] not in CRITERIA or row['label'] not in ['0', '1']:
            raise ValueError('Each case requires a supported criterion and binary label.')
        cases[row['case_id']] = dict(case_id=row['case_id'], sc=row['sc'], positive=row['label'] == '1', rules={})
    tools = tuple(CHECKERS if tools is None else tools)
    if set(tools) - set(CHECKERS):
        raise ValueError('Unknown native checker in the requested tool set.')
    for row in _read(native_rules_csv):
        if row.get('dataset', dataset) != dataset or row['case_id'] not in cases:
            continue
        case = cases[row['case_id']]
        if row['sc'] != case['sc']:
            raise ValueError('A native rule signal has the wrong success criterion.')
        if row['tool'] in tools and row['rule']:
            case['rules'].setdefault(row['tool'], set()).add(row['rule'])
    return list(cases.values()), tools


def predict(configuration, native_rules_csv, elements_csv):
    """Apply a frozen formula; no labels influence the predictions."""
    rows, _ = _inputs(native_rules_csv, elements_csv, training=False)
    return {row['case_id']: any(term['sc'] == row['sc'] and all(
        rule in row['rules'].get(tool, set()) for tool, rule in term['allOf'])
        for term in configuration['terms']) for row in rows}


def _metrics(truth, predicted):
    tp = sum(bool(y and p) for y, p in zip(truth, predicted))
    fp = sum(bool(not y and p) for y, p in zip(truth, predicted))
    fn = sum(bool(y and not p) for y, p in zip(truth, predicted))
    tn = sum(bool(not y and not p) for y, p in zip(truth, predicted))
    ratio = lambda a, b: a / b if b else None
    return dict(N=len(truth), TP=tp, FP=fp, FN=fn, TN=tn,
        precision=ratio(tp, tp+fp), recall=ratio(tp, tp+fn), fpr=ratio(fp, fp+tn),
        fdr=ratio(fp, tp+fp), f1=ratio(2*tp, 2*tp+fp+fn) if 2*tp+fp+fn else 0.0)


def fit(native_rules_csv, elements_csv, *, tools=None, neutral=True):
    """Maximize pooled conformance F1, then optionally add prediction-neutral singleton rules."""
    try:
        import numpy as np
        from scipy.optimize import Bounds, LinearConstraint, milp
        from scipy.sparse import coo_matrix
    except ModuleNotFoundError:
        raise ValueError('Install ensemble dependencies: pip install -r requirements-ensemble.txt') from None
    rows, tools = _inputs(native_rules_csv, elements_csv, tools)
    truth = np.array([row['positive'] for row in rows], dtype=bool)
    atoms = sorted({(row['sc'], tool, rule) for row in rows for tool, rules in row['rules'].items() for rule in rules})
    active = np.array([[row['sc'] == sc and rule in row['rules'].get(tool, set())
                       for sc, tool, rule in atoms] for row in rows], dtype=bool).reshape(len(rows), len(atoms))
    profiles, inverse = np.unique(active, axis=0, return_inverse=True)
    positive = np.bincount(inverse, weights=truth, minlength=len(profiles))
    negative = np.bincount(inverse, weights=~truth, minlength=len(profiles))
    covered = profiles.any(axis=1)
    profiles, positive, negative = profiles[covered], positive[covered], negative[covered]
    count = len(profiles)
    terms, certificate, chosen = [], [], []
    if count:
        constraint_rows, constraint_cols, values, lower, upper = [], [], [], [], []
        for left in range(count):
            for right in range(count):
                if left == right or not np.all(~profiles[left] | profiles[right]):
                    continue
                index = len(lower)
                constraint_rows.extend([index, index])
                constraint_cols.extend([left, right])
                values.extend([1., -1.])
                lower.append(-np.inf)
                upper.append(0.)
        matrix = coo_matrix((values, (constraint_rows, constraint_cols)), shape=(len(lower), count)).tocsc()
        constraints = LinearConstraint(matrix, np.array(lower), np.array(upper))
        fraction = 0.0
        total_positive = int(truth.sum())
        for iteration in range(30):
            solution = milp(fraction*negative - (2-fraction)*positive + negative*1e-8,
                integrality=np.ones(count), bounds=Bounds(np.zeros(count), np.ones(count)),
                constraints=constraints, options={'mip_rel_gap': 0., 'time_limit': 30.})
            if solution.x is None or solution.status != 0:
                raise RuntimeError('The optimizer did not certify an optimum: ' + solution.message)
            chosen = np.flatnonzero(solution.x > .5)
            tp, fp = float(positive[chosen].sum()), float(negative[chosen].sum())
            fitted = 2*tp/(total_positive+tp+fp) if total_positive+tp+fp else 0.0
            certificate.append(dict(iteration=iteration, f1=fitted, status=int(solution.status),
                                    mipGap=float(getattr(solution, 'mip_gap', 0.))))
            if abs(fitted-fraction) < 1e-10:
                break
            fraction = fitted
        else:
            raise RuntimeError('The fractional optimization did not converge.')
        minimal = [index for index in chosen if not any(other != index and
                   np.all(~profiles[other] | profiles[index]) for other in chosen)]
        for index in minimal:
            selected = [atoms[j] for j in np.flatnonzero(profiles[index])]
            if len({atom[0] for atom in selected}) != 1:
                raise AssertionError('A conjunction crossed success criteria.')
            terms.append(dict(sc=selected[0][0], allOf=[[tool, rule] for _, tool, rule in selected]))
    configuration = dict(family='monotone-rules', terms=terms, optimal=True, certificate=certificate,
        searchScope='All SC-local monotone Boolean formulas of observed native rule signals; conjunction order is unrestricted; zero-alert profiles remain unflagged')
    def evaluate(formula):
        return np.array([any(term['sc'] == row['sc'] and all(rule in row['rules'].get(tool, set())
            for tool, rule in term['allOf']) for term in formula['terms']) for row in rows], dtype=bool)
    predictions = evaluate(configuration)
    minimal_count = len(terms)
    neutral_additions = []
    if neutral:
        singletons = {(term['sc'], *term['allOf'][0]) for term in terms if len(term['allOf']) == 1}
        for column, atom in enumerate(atoms):
            if not (active[:, column] & ~predictions).any() and atom not in singletons:
                term = dict(sc=atom[0], allOf=[[atom[1], atom[2]]])
                neutral_additions.append(term)
                terms.append(term)
        if not np.array_equal(predictions, evaluate(configuration)):
            raise AssertionError('Coverage additions changed a conformance prediction.')
    configuration['fit'] = dict(dataset='conformance', cases=len(rows), tools=list(tools),
        metrics=_metrics(truth, predictions), minimalClauses=minimal_count,
        neutralSingletonAdditions=neutral_additions)
    return configuration


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--native-rules', type=Path, required=True)
    parser.add_argument('--elements', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    arguments = parser.parse_args()
    result = fit(arguments.native_rules, arguments.elements)
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_text(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    main()
