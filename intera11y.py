#!/usr/bin/env python3
"""Run InterA11y experiments and analyze saved results."""
from pathlib import Path
import argparse
import importlib.util
import json
import subprocess
import sys
from intera11y_benchmark.experiments import EXPERIMENTS

ROOT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    datasets = sub.add_parser('datasets', help='Validate the released datasets and predictions')
    datasets.add_argument('action', choices=['validate', 'import-expert'])
    datasets.add_argument('--source', type=Path)
    sub.add_parser('list', help='List experiments and adapters')
    doctor = sub.add_parser('doctor', help='Check installed tool dependencies')
    doctor.add_argument('--tools', default='all')
    parse = sub.add_parser('parse', help='Compute paper metrics from saved predictions')
    parse.add_argument('--experiment', choices=list(EXPERIMENTS), required=True)
    parse.add_argument('--predictions', type=Path)
    parse.add_argument('--labels', type=Path)
    parse.add_argument('--output', type=Path)
    run = sub.add_parser('run', help='Run an experiment using the published case selection')
    run.add_argument('--experiment', choices=list(EXPERIMENTS), required=True)
    run.add_argument('--systems', help='Comma-separated adapter names; default: experiment systems')
    run.add_argument('--models', default='gemini,glm,luna,claude')
    run.add_argument('--condition')
    run.add_argument('--cases', help='Comma-separated public case IDs')
    run.add_argument('--limit', type=int)
    run.add_argument('--workers', type=int, default=1)
    run.add_argument('--page-root', type=Path)
    run.add_argument('--output', type=Path)
    ensemble = sub.add_parser('ensemble', help='Fit native rule clauses on the conformance set')
    ensemble.add_argument('action', choices=['fit'])
    ensemble.add_argument('--native-rules', type=Path, default=ROOT/'results/native-rule-findings.csv')
    ensemble.add_argument('--elements', type=Path, default=ROOT/'datasets/conformance/elements.csv')
    ensemble.add_argument('--output', type=Path, default=ROOT/'outputs/rule-ensemble.json')
    args = parser.parse_args()
    from intera11y_benchmark.providers import load_env
    load_env()
    if args.command == 'datasets':
        if args.action == 'import-expert':
            if not args.source:
                parser.error('datasets import-expert requires --source')
            from intera11y_benchmark.snapshots import import_expert
            result = import_expert(args.source)
            print(json.dumps(result, indent=2))
            return 0
        spec = importlib.util.spec_from_file_location('dataset_validator', ROOT/'datasets/validate.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        result = module.validate()
    elif args.command == 'list':
        from adapters.registry import list_tools
        result = dict(experiments=EXPERIMENTS, adapters=[
            dict(id='intera11y', name='InterA11y', family='agentic'),
            dict(id='rule-ensemble', name='Rule Ensemble', family='rule-based')]+list_tools())
    elif args.command == 'doctor':
        from adapters.registry import doctor, list_tools
        names = [item['id'] for item in list_tools()] if args.tools == 'all' else args.tools.split(',')
        if args.tools == 'all':
            names += ['intera11y','rule-ensemble']
        result = {}
        for name in names:
            if name == 'intera11y':
                check = subprocess.run(['node','-e',"require('./runtime/run-intera11y.cjs')"],cwd=ROOT,capture_output=True)
                result[name] = dict(ready=check.returncode==0, checks=dict(runtime=check.returncode==0))
            elif name == 'rule-ensemble':
                result[name] = dict(ready=(ROOT/'results/rule-ensemble.json').is_file())
            else:
                result[name] = doctor(name)
    elif args.command == 'parse':
        from intera11y_benchmark.analysis import analyze, write_analysis
        result = analyze(args.experiment, args.predictions, args.labels)
        output = args.output or ROOT/'outputs'/args.experiment
        path = write_analysis(result, output)
        result = dict(experiment=result['experiment'], N=result['N'], metrics=str(path),
                      configurations=len({(r['system'],r['condition'],r['model']) for r in result['per_model']}))
    elif args.command == 'run':
        from intera11y_benchmark.runner import run_experiment
        if args.workers < 1 or (args.limit is not None and args.limit < 1):
            parser.error('--workers and --limit must be positive')
        result = run_experiment(args.experiment, systems=args.systems.split(',') if args.systems else None,
            models=args.models.split(','), case_ids=args.cases.split(',') if args.cases else None,
            limit=args.limit, workers=args.workers, page_root=args.page_root,
            output=args.output, condition=args.condition)
    elif args.command == 'ensemble':
        from intera11y_benchmark.ensemble import fit
        result = fit(args.native_rules, args.elements)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, indent=2)+'\n')
        result = dict(configuration=str(args.output), clauses=len(result['terms']))
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (ValueError, OSError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
