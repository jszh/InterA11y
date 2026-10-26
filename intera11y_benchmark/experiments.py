"""Experiment names and conditions used in the paper."""
CRITERIA = ['1.1.1', '1.4.1', '1.4.13', '2.1.1', '2.1.2', '2.4.3', '2.4.4', '2.4.7', '3.3.1', '4.1.3']
CATEGORIES = {
    'Content Alternatives': ['1.1.1'],
    'Link Purpose': ['2.4.4'],
    'Keyboard and Focus': ['2.1.1', '2.1.2', '2.4.3', '2.4.7'],
    'Cues and Feedback': ['1.4.1', '1.4.13', '3.3.1', '4.1.3'],
}
CHECKERS = ['alfa', 'aslint', 'axe', 'bagel', 'ed11y', 'htmlcs', 'ibm', 'lynx', 'nuval', 'qualweb', 'testaro']
EXPERIMENTS = {
    'conformance-evaluation': dict(title='Evaluation of Current Checkers', dataset='conformance',
        systems=CHECKERS+['rule-ensemble', 'gena11y', 'accessguru', 'lopez-pereira']),
    'ablation-study': dict(title='InterA11y Ablations', dataset='conformance',
        systems=['gena11y', 'intera11y'],
        conditions=['rubrics', 'deterministic', 'deterministic-rubrics', 'full']),
    'expert-evaluation': dict(title='Expert Evaluation', dataset='expert',
        systems=CHECKERS+['rule-ensemble', 'gena11y', 'accessguru', 'agentlab', 'browser-use', 'intera11y']),
    'tool-contribution': dict(title='General-Purpose Web Agents', dataset='expert',
        systems=['agentlab', 'browser-use'], conditions=['general-tools', 'intera11y-tools']),
}


def includes(experiment, row):
    spec = EXPERIMENTS[experiment]
    if row['system'] not in spec['systems']:
        return False
    if row['system'] == 'intera11y':
        return row['condition'] in (spec.get('conditions') or ['full'])
    if row['system'] in ['agentlab', 'browser-use']:
        return row['condition'] in (spec.get('conditions') or ['general-tools'])
    return True


def conditions(experiment, system):
    spec = EXPERIMENTS[experiment]
    if system == 'intera11y':
        return spec.get('conditions', ['full'])
    if system in ['agentlab', 'browser-use']:
        return spec.get('conditions', ['general-tools'])
    return ['default']
