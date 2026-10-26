import copy
import json
import re
from collections import defaultdict
from pathlib import Path
POLICY = 'unique-observed-element-reference-output-translation-v3'
TOOL_TARGET_POLICY = 'unique-native-or-retained-state-identity-v3'
_INVALID_XML_TEXT = re.compile('[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]')

def browser_use_snapshot(state, step):
    nodes = []
    seen = {}

    def visit(node, parent=-1):
        if node is None:
            return None
        if id(node) in seen:
            return seen[id(node)]
        index = len(nodes)
        seen[id(node)] = index
        kind = getattr(node.node_type, 'value', node.node_type)
        nodes.append(dict(parent=parent, type=int(kind), name=node.node_name, value=node.node_value or '', attributes=node.attributes or {}, backendId=node.backend_node_id))
        for child in node.children_nodes or []:
            visit(child, index)
        for child in node.shadow_roots or []:
            visit(child, index)
        visit(node.content_document, index)
        return index
    dom = state.dom_state
    root = getattr(dom._root, 'original_node', dom._root)
    while root is not None and root.parent_node is not None:
        root = root.parent_node
    visit(root)
    refs = {}
    for index, node in dom.selector_map.items():
        if id(node) not in seen:
            chain, current = ([], node)
            while current is not None and id(current) not in seen:
                chain.append(current)
                current = current.parent_node
            parent = seen.get(id(current), -1)
            for ancestor in reversed(chain):
                parent = visit(ancestor, parent)
        refs['index:' + str(index)] = seen[id(node)]
    return dict(step=step, url=state.url, nodes=nodes, refs=refs)

def browsergym_snapshot(obs, step):
    dom = obs['dom_object']
    strings, documents = (dom['strings'], dom['documents'])
    nodes, offsets, refs = ([], [], {})
    frame_parents = {}
    for document in documents:
        offsets.append(len(nodes))
        raw = document['nodes']
        for index, kind in enumerate(raw['nodeType']):
            attributes = raw['attributes'][index]
            attributes = {strings[attributes[i]]: strings[attributes[i + 1]] for i in range(0, len(attributes), 2)}
            parent = raw['parentIndex'][index]
            node_index = len(nodes)
            nodes.append(dict(parent=offsets[-1] + parent if parent >= 0 else -1, type=kind, name=strings[raw['nodeName'][index]], value=strings[raw['nodeValue'][index]], attributes=attributes, backendId=raw['backendNodeId'][index]))
            if attributes.get('bid'):
                ref = 'bid:' + attributes['bid']
                if ref in refs:
                    previous = refs[ref]
                    refs[ref] = [*previous, node_index] if isinstance(previous, list) else [previous, node_index]
                else:
                    refs[ref] = node_index
        rare = raw.get('contentDocumentIndex', {})
        for index, value in zip(rare.get('index', []), rare.get('value', [])):
            frame_parents[value] = offsets[-1] + index
    for document_index, parent in frame_parents.items():
        start = offsets[document_index]
        stop = offsets[document_index + 1] if document_index + 1 < len(offsets) else len(nodes)
        for index in range(start, stop):
            if nodes[index]['parent'] == -1:
                nodes[index]['parent'] = parent
    return dict(step=step, url=obs.get('url'), nodes=nodes, refs=refs)

class Snapshot:

    def __init__(self, data):
        self.data = data
        self.nodes = data['nodes']
        self.paths = {}
        self.positions = {}
        self.child_elements = defaultdict(list)
        self.boundaries = defaultdict(list)
        counts = defaultdict(int)
        for index, node in enumerate(self.nodes):
            if node['type'] == 1:
                key = (node['parent'], node['name'].lower())
                counts[key] += 1
                self.positions[index] = counts[key]
                self.child_elements[key].append(index)
            elif node['type'] in (9, 11):
                self.boundaries[node['parent']].append(index)
        self._trees = None
        self._css_trees = {}
        self.children = defaultdict(list)
        for index, node in enumerate(self.nodes):
            self.children[node['parent']].append(index)

    def identity(self, index):
        node = self.nodes[index]
        attributes = {key: str(node['attributes'][key]) for key in ('id', 'href', 'type', 'role', 'name', 'aria-label', 'title', 'alt') if key in node['attributes']}
        text = []

        def visit(i):
            child = self.nodes[i]
            if child['name'].lower() in ('script', 'style') or child['type'] in (9, 11):
                return
            if child['type'] == 3:
                text.append(child['value'])
            for j in self.children[i]:
                visit(j)
        visit(index)
        return dict(xpath=self.xpath(index), tag=node['name'].lower(), attributes=attributes, text=re.sub('\\s+', ' ', ''.join(text)).strip()[:240])

    def literal_xpath(self, value):
        segments = value.split('>>')
        if not all((re.fullmatch('(?:/[A-Za-z_][\\w:.-]*(?:\\[\\d+\\])?)+', s[5:] if s.startswith('frame/') else s) for s in segments)):
            return None
        current = [-1, *[i for i, node in enumerate(self.nodes) if node['type'] == 9 and node['parent'] == -1]]
        for part_index, segment in enumerate(segments):
            if part_index:
                current = [child for parent in current for child in self.boundaries[parent]]
                if segment.startswith('frame/'):
                    current = [i for i in current if self.nodes[i]['type'] == 9]
                    segment = segment[5:]
                else:
                    current = [i for i in current if self.nodes[i]['type'] == 11 or (self.nodes[i]['type'] == 9 and segment.startswith('/html'))]
            for part in segment.split('/')[1:]:
                match = re.fullmatch('([^\\[]+)(?:\\[(\\d+)\\])?', part)
                tag, position = match.groups()
                found = [child for parent in current for child in self.child_elements[parent, tag] if position is None or self.positions[child] == int(position)]
                current = sorted(set(found))
        return current

    def xpath(self, index):
        if index in self.paths:
            return self.paths[index]
        node = self.nodes[index]
        parent = node['parent']
        prefix = self.xpath(parent) if parent >= 0 else ''
        if node['type'] == 1:
            path = prefix + '/' + node['name'].lower() + '[' + str(self.positions[index]) + ']'
        elif node['type'] in (9, 11):
            path = prefix + ('>>frame' if node['type'] == 9 else '>>') if prefix else ''
        else:
            path = prefix
        self.paths[index] = path
        return path

    def trees(self):
        from lxml import etree
        if self._trees is not None:
            return self._trees
        elements, roots = ({}, [])
        for index, node in enumerate(self.nodes):
            if node['type'] == 3:
                parent = elements.get(node['parent'])
                if parent is not None:
                    text = _INVALID_XML_TEXT.sub('�', node['value'])
                    if len(parent):
                        parent[-1].tail = (parent[-1].tail or '') + text
                    else:
                        parent.text = (parent.text or '') + text
                continue
            if node['type'] != 1:
                continue
            try:
                element = etree.Element(node['name'].lower())
            except ValueError:
                continue
            for name, value in node['attributes'].items():
                try:
                    element.set(name, str(value))
                except ValueError:
                    pass
            elements[index] = element
            parent = elements.get(node['parent'])
            if parent is not None:
                parent.append(element)
            else:
                roots.append(element)
        self._trees = (roots, {element: index for index, element in elements.items()})
        return self._trees

    def selector(self, value, kind):
        roots, indices = self.trees()
        found = []
        for root in roots:
            if '>>' in self.xpath(indices[root]):
                continue
            if kind == 'xpath':
                if value.startswith('/') and (not self.xpath(indices[root]).startswith('/html[')):
                    continue
                try:
                    matches = root.getroottree().xpath(value)
                except Exception:
                    continue
                if not isinstance(matches, list):
                    continue
                found += [indices[m] for m in matches if m in indices]
            else:
                from bs4 import BeautifulSoup
                from lxml import etree
                if root not in self._css_trees:
                    soup = BeautifulSoup(etree.tostring(root, encoding='unicode'), 'html.parser')
                    tags = list(soup.find_all(True))
                    original = list(root.iter())
                    if len(tags) != len(original):
                        continue
                    lookup = {id(tag): indices[element] for tag, element in zip(tags, original)}
                    self._css_trees[root] = (soup, lookup)
                soup, lookup = self._css_trees[root]
                try:
                    found += [lookup[id(tag)] for tag in soup.select(value)]
                except Exception:
                    continue
        return sorted(set(found))

class ReferenceLedger:

    def __init__(self, path=None):
        self.path = Path(path) if path else None
        self.snapshots = []

    def add(self, data):
        self.snapshots.append(Snapshot(data))
        if self.path:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open('a') as stream:
                stream.write(json.dumps(data, ensure_ascii=False) + '\n')

    def prepare_tool_targets(self, args, retained_state=False):
        targets = {}
        snapshot = self.snapshots[-1] if self.snapshots else None
        keys = {'targetXpath', 'nodeAXpath', 'nodeBXpath', 'triggerXpath', 'otherXpath', 'linkXpath', 'iframeXpath', 'xpath', 'toXpath'}
        arrays = {'linkXpaths', 'iframeXpaths'}

        def bind(value):
            if not isinstance(value, str) or not value.strip():
                raise ValueError('Tool target must be a nonempty observed XPath.')
            if retained_state:
                expression = value[6:] if value.startswith('xpath:') else value
                if not expression.startswith('/'):
                    raise ValueError('Retained-state targets require XPath from that state; native indices refer to a different page.')
                return expression
            if snapshot is None:
                raise ValueError('No native DOM observation exists for this tool target.')
            value = value.strip()
            if value.startswith(('index:', 'bid:')):
                index = snapshot.data['refs'].get(value)
                found = index if isinstance(index, list) else [index] if index is not None else []
            elif value.startswith('css:'):
                found = snapshot.selector(value[4:], 'css')
            else:
                expression = value[6:] if value.startswith('xpath:') else value
                found = snapshot.literal_xpath(expression)
                if found is None:
                    found = snapshot.selector(expression, 'xpath')
            if len(found) != 1:
                raise ValueError(f'Tool target {value!r} identifies {len(found)} observed elements; choose exactly one element from the current observation.')
            identity = snapshot.identity(found[0])
            targets[identity['xpath']] = identity
            return identity['xpath']

        def walk(value):
            if isinstance(value, list):
                return [walk(v) for v in value]
            if not isinstance(value, dict):
                return value
            return {key: bind(v) if key in keys and v is not None else [bind(x) for x in v] if key in arrays and isinstance(v, list) else walk(v) for key, v in value.items()}
        normalized = walk(args)
        return (normalized, None if retained_state else list(targets.values()))

    def resolve(self, reference, step=None, framework='bu', observed_tool_paths=()):
        result = dict(reference=reference, observationStep=step, xpath=None, status='missing-reference', policy=POLICY)
        if not isinstance(reference, str) or not reference.strip():
            return result
        reference = reference.strip()
        if reference.startswith('/'):
            reference = 'xpath:' + reference
        elif ':' not in reference:
            reference = ('index:' if framework == 'bu' else 'bid:') + reference.strip('[]')
        candidates = [s for s in self.snapshots if step is None or s.data['step'] == step]
        if not candidates:
            result['status'] = 'observation-not-recorded'
            return result

        def matches(snapshot):
            if reference in snapshot.data['refs']:
                index = snapshot.data['refs'][reference]
                return index if isinstance(index, list) else [index]
            kind, _, value = reference.partition(':')
            if kind == 'xpath':
                literal = snapshot.literal_xpath(value)
                if literal is not None:
                    return literal
            return snapshot.selector(value, kind) if kind in ('css', 'xpath') else []
        selected = candidates[-1]
        found = matches(selected)
        if not found and step is None:
            older = [(s, matches(s)) for s in candidates[:-1]]
            identities = {(s.data['url'], s.nodes[i].get('backendId'), s.xpath(i)) for s, indices in older for i in indices}
            if len(identities) == 1:
                selected, found = next(((s, indices) for s, indices in reversed(older) if indices))
            elif identities:
                result['status'] = 'ambiguous-earlier-reference'
                return result
        if len(found) != 1:
            result['status'] = 'ambiguous-reference' if found else 'reference-not-found'
            return result
        result.update(xpath=selected.xpath(found[0]), observationStep=selected.data['step'], url=selected.data['url'], status='resolved')
        return result

    def translate(self, assessment, framework, observed_tool_paths=()):
        answer = copy.deepcopy(assessment)
        for finding in answer.get('findings', []):
            reference = finding.get('element_ref')
            if reference is None and finding.get('xpath'):
                reference = 'xpath:' + finding['xpath']
            resolution = self.resolve(reference, finding.get('observation_step'), framework, observed_tool_paths)
            finding['xpath'] = resolution['xpath']
            finding['referenceResolution'] = resolution
        return answer

    def final_error(self, assessment, framework, observed_tool_paths=()):
        findings = assessment.get('findings') or []
        if not findings and assessment.get('verdict') == 'FAIL':
            return 'A FAIL assessment requires findings identifying the observed failing elements with native references.'
        for finding in findings:
            reference = finding.get('element_ref') or finding.get('xpath')
            if not isinstance(reference, str) or not reference.strip():
                return 'Each finding requires an observed native index/BID, or a CSS/XPath selector identifying exactly one observed element.'
        translated = self.translate(assessment, framework, observed_tool_paths)
        errors = []
        for finding in translated.get('findings', []):
            resolution = finding['referenceResolution']
            if resolution['xpath'] is None:
                errors.append(f"{resolution['reference']!r}: {resolution['status']}")
        if errors:
            return 'The final answer cannot be accepted: each finding must identify exactly one observed element. Invalid references: ' + '; '.join(errors) + '. Continue inspecting and supply the correct native element index/BID, or a unique observed selector. For an earlier observation specify observation_step. Prefer a native reference; a CSS or XPath selector must resolve uniquely in the recorded observation. Do not guess or replace a failure with PASS solely to avoid localization.'
        return None

def tool_paths(value):
    result = set()
    if isinstance(value, dict):
        for name, child in value.items():
            if name in ('xpath', 'xpaths'):
                for path in child if isinstance(child, list) else [child]:
                    if isinstance(path, str) and re.fullmatch('/[\\w/\\[\\]\\d.>:-]+', path):
                        result.add(path)
            result.update(tool_paths(child))
    elif isinstance(value, list):
        for child in value:
            result.update(tool_paths(child))
    return result
