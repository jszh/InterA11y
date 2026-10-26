import hashlib
import json

def group_link_contexts(records):
    groups, by_key = ([], {})
    for index, record in enumerate(records):
        if not isinstance(record, dict):
            raise ValueError('Deduplicated links require context metadata from extraction')
        html = record['contextHTML']
        root = record['contextXPath']
        kind = record.get('contextKind', 'subtree')
        key = (root, html, kind) if root else ('unidentified', index)
        if key not in by_key:
            group = {'contextXPath': root, 'contextHTML': html, 'contextKind': kind, 'targets': [], 'contextId': hashlib.sha1(json.dumps(key).encode()).hexdigest()}
            by_key[key] = group
            groups.append(group)
        path = record['xpath']
        relative = '.' + path[len(root):] if kind == 'subtree' and root and (path == root or path.startswith(root + '/')) else None
        by_key[key]['targets'].append({'xpath': path, 'relativeXPath': relative, 'outerHTML': record['linkHTML']})
    audit = {'version': 'shared-link-context-v1', 'sourceLinks': len(records), 'uniqueContexts': len(groups), 'representedTargets': sum((len(g['targets']) for g in groups)), 'originalContextCharacters': sum((len(r['contextHTML']) for r in records)), 'uniqueContextCharacters': sum((len(g['contextHTML']) for g in groups)), 'groups': [{'contextId': g['contextId'], 'contextXPath': g['contextXPath'], 'targets': [t['xpath'] for t in g['targets']]} for g in groups]}
    return (groups, audit)

def render_contexts(groups):
    parts = []
    for group in groups:
        targets = group['targets']
        evaluate = group.get('evaluateTargets', [t['xpath'] for t in targets])
        parts.append(f"Context {group['contextId']} at {group['contextXPath'] or '(unknown root)'}\nContext representation: {group['contextKind']}\nShared context HTML:\n{group['contextHTML']}\nTarget links (absolute XPath, XPath relative to the context root, and link HTML):\n" + '\n'.join((f"[path: {t['xpath']}]\nrelativeXPath={t['relativeXPath']}\n{t['outerHTML']}" for t in targets)) + '\nEvaluate these target XPaths in this call: ' + json.dumps(evaluate, ensure_ascii=False))
    return '\n-------------\n'.join(parts)

def split_contexts(groups):
    if len(groups) > 1:
        middle = len(groups) // 2
        return (groups[:middle], groups[middle:])
    group = groups[0]
    targets = group.get('evaluateTargets', [t['xpath'] for t in group['targets']])
    if len(targets) < 2:
        return None
    middle = len(targets) // 2
    return ([{**group, 'evaluateTargets': targets[:middle]}], [{**group, 'evaluateTargets': targets[middle:]}])
