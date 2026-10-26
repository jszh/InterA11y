import json
import os
from pathlib import Path
GENA11Y_PROMPT = {}
EXPERT_TARGET_POLICY = os.environ.get('A11Y_EXPERT_TARGET_POLICY', 'page-wide-output-filter-v1')
if EXPERT_TARGET_POLICY not in ('page-wide-output-filter-v1', 'annotated-target-guided-v1'):
    raise ValueError('Unknown Expert acquisition policy: ' + EXPERT_TARGET_POLICY)
_rubric_file = os.environ.get('A11Y_MATCHED_RUBRIC_FILE')
FROZEN_RUBRICS = json.loads(Path(_rubric_file).read_text()) if _rubric_file else None
RUBRIC_SNAPSHOT = {'id': FROZEN_RUBRICS['id']} if FROZEN_RUBRICS else None

def parse_condition(value):
    return '0b' if value == '0b' else int(value)

def default_judgment_prompt(condition):
    if condition == '0b':
        return 'gena11y'
    return 'v2' if condition == 2 else 'ablation-rules'

def task_prompt(sc, rubric, targets, condition):
    if FROZEN_RUBRICS:
        if condition not in (1, 2) or EXPERT_TARGET_POLICY != 'annotated-target-guided-v1' or targets is None:
            raise ValueError('Frozen source rubric is only for scope-matched Expert conditions 1/2')
        frozen = FROZEN_RUBRICS['criteria'][sc]
        if frozen['definition'] != rubric['definition'] or frozen['title'] != rubric['title']:
            raise ValueError('Frozen rubric criterion identity differs from current corpus')
        rubric = {**rubric, 'matched': frozen['matched']}
    if condition == '0b':
        text = GENA11Y_PROMPT['criteria'][sc]['text']
        return GENA11Y_PROMPT['system'] + '\n\n' + text + '\nEvaluate the currently open page for this criterion.'
    lines = [f"Evaluate the currently open page against WCAG 2.2 SC {sc} ({rubric['title']}).", 'Inspect and interact with the page as necessary. Decide from observed evidence.', 'Return PASS if the page meets the criterion, FAIL if a failure is observed, or UNDETERMINED if the available evidence cannot settle it.', 'Give supporting evidence and a justification. For every failure, report its observed native element reference. A CSS selector or XPath is also allowed when it uniquely identifies that observed element. Do not guess an element identity. Each reported failure must identify exactly one observed element; continue inspecting until its reference is unambiguous. Do not change a failure to PASS merely to avoid localization.']
    if targets is not None and EXPERT_TARGET_POLICY == 'annotated-target-guided-v1':
        if targets.get('page'):
            lines.append('Evaluation scope: the whole page for this criterion.')
        else:
            keys = targets.get('paths') or targets.get('keys') or []
            if not keys:
                raise ValueError('Target-guided element scope requires annotated paths')
            lines.append('Evaluation scope: these annotated element paths (and their descendants): ' + ', '.join(keys) + '. Assess all of them and identify failures individually.')
    lines += ['', 'Criterion definition:', rubric['definition']]
    if condition != 0:
        heading = 'InterA11y ablation judgment rules:' if rubric['promptId'] == 'ablation-rules-v1' else 'Pass/fail rubric and edge-case guidance:'
        lines += ['', heading, rubric['matched']]
    return '\n'.join(lines)

def prompt_id(spec, condition):
    if condition == '0b':
        return GENA11Y_PROMPT['id']
    return 'wcag-definition-v1' if condition == 0 else spec['judgmentPrompt']['id']

def prompt_record(text, identifier):
    return {'id': identifier}

def normalize_gena11y_assessment(raw):
    verdict = raw.get('verdict')
    if verdict not in ('REPRODUCED', 'NOT REPRODUCED', 'PARTIAL'):
        raise ValueError(f'Invalid GenA11y verdict: {verdict}')
    summary = str(raw.get('summary') or '')
    return {'verdict': 'PASS' if verdict == 'NOT REPRODUCED' else 'FAIL', 'evidence': summary, 'justification': summary, 'findings': [{'xpath': v.get('xpath'), 'evidence': str(v.get('outerHTML') or ''), 'reason': str(v.get('reason') or '')} for v in raw.get('violations') or []]}

def check_saved_prompt(record, requested):
    saved = record.get('judgmentPrompt')
    if saved == requested:
        return
    if saved is None and requested['id'] in ('legacy-v2-v1', 'wcag-definition-v1'):
        return
    raise ValueError('Saved case uses a different or unversioned judgment prompt; use a new --out directory.')

def check_output_prompt(out, identifier):
    manifest = out / 'manifest.json'
    populated = (out / 'results.json').exists() or any((out / 'cases').glob('*.json'))
    if not populated:
        return
    previous = json.loads(manifest.read_text()) if manifest.exists() else {}
    saved_id = (previous.get('judgmentPrompt') or {}).get('id')
    if saved_id == identifier or (saved_id is None and identifier in ('legacy-v2-v1', 'wcag-definition-v1')):
        return
    raise ValueError('Output directory contains results from a different judgment prompt; use a new --out directory.')

def check_output_protocol(out, protocol):
    if not ((out / 'results.json').exists() or any((out / 'cases').glob('*.json'))):
        return
    manifest = out / 'manifest.json'
    previous = json.loads(manifest.read_text()) if manifest.exists() else {}
    if previous.get('executionProtocol') != protocol:
        raise ValueError('Output directory uses a different execution protocol; use a fresh --out directory.')
