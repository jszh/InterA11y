import copy
import html as html_lib
import re
from bs4 import BeautifulSoup, Comment, NavigableString, Tag
from ag_consts import SEMANTIC_VIOLATIONS, VIOLATION_TO_SCS
ADAPTER_REVISION = 'semantic-evidence-v3'
NODE_ATTRIBUTE = 'data-accessguru-node'
VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'}
_SEMANTIC_ATTRS = {'id', 'role', 'lang', 'dir', 'title', 'alt', 'href', 'src', 'srcset', 'srcdoc', 'name', 'type', 'value', 'for', 'tabindex', 'disabled', 'hidden', 'inert', 'required', 'readonly', 'checked', 'selected', 'placeholder', 'autocomplete', 'contenteditable', 'headers', 'scope', 'colspan', 'rowspan', 'target', 'download', 'controls', 'autoplay', 'muted', 'kind', 'srclang', 'label', 'datetime'}
_NAMES = re.compile('(?<![a-z0-9-])(' + '|'.join((re.escape(n) for n in sorted(SEMANTIC_VIOLATIONS, key=len, reverse=True))) + ')(?![a-z0-9-])', re.I)
_INLINE_CATEGORY = re.compile('^[ \\t]*(?:[—–-][ \\t]*)?\\*{0,2}(' + '|'.join((re.escape(n) for n in sorted(SEMANTIC_VIOLATIONS, key=len, reverse=True))) + ')\\*{0,2}(?=$|[ \\t.,;:!?—–])', re.I)
_SECTIONS = re.compile('(?m)^\\s*(?:#{1,6}\\s*)?\\*{0,2}(?:Violation\\s+\\d+|\\d+[.)])[^\\n]*', re.I)
_LABEL = re.compile('(?im)^[ \\t]*(?:[-*][ \\t]*)?(?:\\d+[.)][ \\t]*)?\\*{0,2}(?:Violation(?:(?:[ \\t]+|[-_])(?:name|type))?|Taxonomy(?:[ \\t]+name)?)\\*{0,2}[ \\t]*:[ \\t]*\\*{0,2}[ \\t]*([^\\n]*)')
_NEGATIVE = re.compile('\\b(?:not a violation|no (?:confirmed |semantic |accessibility )?violations?|cannot (?:reliably )?confirm|unable to determine|uncertain|insufficient evidence|not enough evidence)\\b', re.I)
_SNIPPETS = re.compile('\\[START\\](.*?)\\[END\\]', re.S)

def _names(text):
    return {name.lower() for name in _NAMES.findall(text)}

def _clean_snippet(text):
    text = text.strip()
    text = re.sub('^```(?:html|xml)?\\s*\\n?', '', text, flags=re.I)
    text = re.sub('\\s*```$', '', text)
    return text.strip().strip('`').strip()

def parse_semantic_items(raw):
    raw = raw or ''
    spans = list(_SNIPPETS.finditer(raw))
    headings = list(_SECTIONS.finditer(raw))
    labels = list(_LABEL.finditer(raw))

    def is_label_heading(heading):
        return any((heading.start() <= label.start() < heading.end() for label in labels))

    def label_names(label):
        value = label.group(1).strip()
        if not value:
            following = next((line.strip() for line in raw[label.end():].splitlines() if line.strip()), '')
            value = following
        return _names(value)
    labels_for_span = {i: set() for i in range(len(spans))}
    for label in labels:
        if not spans:
            break
        previous = next((i for i in range(len(spans) - 1, -1, -1) if spans[i].end() <= label.start()), None)
        following = next((i for i, span in enumerate(spans) if span.start() >= label.end()), None)
        intervening_heading = previous is not None and any((spans[previous].end() <= heading.start() < label.start() and (not is_label_heading(heading)) for heading in headings))
        owner = following if previous is None or intervening_heading else previous
        if owner is not None:
            labels_for_span[owner].update(label_names(label))
    items = []
    for i, span in enumerate(spans):
        preceding = [h for h in headings if h.start() < span.start() and (not is_label_heading(h))]
        heading = preceding[-1] if preceding else None
        next_heading = next((h for h in headings if h.start() > span.end() and (not is_label_heading(h))), None)
        start = heading.start() if heading else spans[i - 1].end() if i else 0
        end = min(next_heading.start() if next_heading else len(raw), spans[i + 1].start() if i + 1 < len(spans) else len(raw))
        context = raw[start:end]
        heading_names = _names(heading.group()) if heading else set()
        inline_limit = min(next((other.start() for other in spans[i + 1:]), len(raw)), next_heading.start() if next_heading else len(raw))
        inline_tail = raw[span.end():inline_limit].splitlines()
        inline_end = inline_tail[0] if inline_tail else ''
        inline_match = _INLINE_CATEGORY.match(inline_end)
        inline_names = {inline_match.group(1).lower()} if inline_match else set()
        names = labels_for_span[i] or heading_names or inline_names
        negative = bool(_NEGATIVE.search(heading.group() if heading else ''))
        verdict_lines = re.findall('(?im)^\\s*\\**(?:Verdict|Result|Status|Conclusion)\\**\\s*:[^\\n]*', context)
        negative |= any((_NEGATIVE.search(line) for line in verdict_lines))
        negative |= bool(re.search('(?im)^\\s*[-*]?\\s*\\*{0,2}(?:no violation|not a violation|uncertain|unable to determine|insufficient evidence)\\b', context))
        if inline_match:
            negative |= bool(_NEGATIVE.search(inline_end[inline_match.end():]))
        if negative:
            names = set()
        snippet = _clean_snippet(span.group(1))
        if not re.search('<[a-zA-Z][\\w:-]*\\b', snippet) and (not names):
            continue
        for name in sorted(names) or [None]:
            items.append(dict(snippet=snippet, rawSnippet=span.group(1), name=name, scs=sorted(VIOLATION_TO_SCS.get(name, set())), isViolation=False if negative else True if name else None, responseStart=span.start(), responseEnd=span.end()))
    return items

def parse_semantic(raw):
    return sorted({item['name'] for item in parse_semantic_items(raw) if item['name']})

def _opening(tag):
    attributes = ''.join((' ' + k + '="' + html_lib.escape(' '.join(v) if isinstance(v, list) else str(v or ''), quote=True) + '"' for k, v in tag.attrs.items()))
    return '<' + tag.name + attributes + '>'

def _parts(node, limit):
    value = html_lib.escape(str(node), quote=False) if isinstance(node, NavigableString) else str(node)
    if len(value) <= limit:
        return [value]
    if isinstance(node, NavigableString):
        result, current = ([], '')
        for character in str(node):
            encoded = html_lib.escape(character, quote=False)
            if len(current) + len(encoded) > limit:
                result.append(current)
                current = ''
            current += encoded
        if current:
            result.append(current)
        return result
    opening = _opening(node)
    closing = '' if node.name in VOID else '</' + node.name + '>'
    room = limit - len(opening) - len(closing)
    if room < 64:
        raise ValueError('AccessGuru HTML budget cannot fit an intact element opening tag')
    results, contents = ([], '')
    for child in node.contents:
        for fragment in _parts(child, room):
            if len(contents) + len(fragment) > room:
                results.append(opening + contents + closing)
                contents = ''
            contents += fragment
    if contents or not results:
        results.append(opening + contents + closing)
    return results

def prepare_evidence(snapshot, max_html_chars=60000):
    if max_html_chars < 512:
        raise ValueError('max_html_chars must be at least 512')
    source = snapshot['html'] if isinstance(snapshot, dict) else str(snapshot)
    index = copy.deepcopy(snapshot.get('nodeIndex', {})) if isinstance(snapshot, dict) else {}
    trusted_index = bool(index)
    soup = BeautifulSoup(source, 'html.parser')
    if not soup.html:
        wrapper = BeautifulSoup('<html><head></head><body></body></html>', 'html.parser')
        for child in list(soup.contents):
            if isinstance(child, Tag) and child.name == 'body':
                wrapper.body.replace_with(child.extract())
            elif isinstance(child, Tag) and child.name == 'head':
                wrapper.head.replace_with(child.extract())
            else:
                wrapper.body.append(child.extract())
        soup = wrapper
    root = soup.html
    body = root.find('body', recursive=False)
    head_node = root.find('head', recursive=False)
    if body is None:
        body = soup.new_tag('body')
        for child in list(root.contents):
            if child is not head_node:
                body.append(child.extract())
        root.append(body)
    if head_node is None:
        head_node = soup.new_tag('head')
        root.insert(0, head_node)
    unindexed_as_text = 0
    if trusted_index:
        for element in list(soup.find_all(True)):
            if element.get(NODE_ATTRIBUTE) in index or element.parent is None:
                continue
            if any((isinstance(parent, Tag) and parent.name != '[document]' and (parent.get(NODE_ATTRIBUTE) not in index) for parent in element.parents)):
                continue
            element.replace_with(NavigableString(str(element)))
            unindexed_as_text += 1
    counters, paths = ({}, {})
    for i, element in enumerate(soup.find_all(True)):
        parent = element.parent
        k = (id(parent), element.name)
        counters[k] = counters.get(k, 0) + 1
        path = paths.get(id(parent), '') + '/' + element.name + f'[{counters[k]}]'
        paths[id(element)] = path
        marker = element.get(NODE_ATTRIBUTE) if index else None
        if not marker:
            marker = f'ag-{i}'
            element[NODE_ATTRIBUTE] = marker
        index.setdefault(marker, dict(xpath=path, tag=element.name))
    omitted = []
    for element in list(soup.find_all(['script', 'style', 'link', 'noscript'])):
        omitted.append(element.name)
        element.decompose()
    for meta in list(head_node.find_all('meta', recursive=False)):
        if not meta.has_attr('charset') and str(meta.get('name', '')).lower() not in ('description', 'viewport') and (str(meta.get('http-equiv', '')).lower() != 'content-type') or len(str(meta.get('content', ''))) > 4096:
            omitted.append('meta')
            meta.decompose()
    for shape in list(soup.find_all(['path', 'rect', 'circle', 'line', 'ellipse', 'polygon', 'polyline'])):
        if shape.find_parent('svg') and (not any((k == 'role' or k.startswith('aria-') for k in shape.attrs))):
            omitted.append('svg-geometry')
            shape.decompose()
    for comment in list(soup.find_all(string=lambda s: isinstance(s, Comment))):
        comment.extract()
    removed_attributes = {}
    for element in soup.find_all(True):
        marker = element[NODE_ATTRIBUTE]
        index[marker]['attributes'] = {k: v for k, v in element.attrs.items() if k != NODE_ATTRIBUTE}
        for attr in list(element.attrs):
            if attr in ('nonce', 'integrity', 'crossorigin', 'class', 'style') or (attr.startswith('data-') and attr != NODE_ATTRIBUTE) or (len(str(element[attr])) > 4096 and attr not in _SEMANTIC_ATTRS and (not attr.startswith('aria-')) and (attr != NODE_ATTRIBUTE)):
                removed_attributes[attr] = removed_attributes.get(attr, 0) + 1
                del element[attr]
            elif 'data:' in str(element[attr]) and len(str(element[attr])) > 4096:
                removed_attributes[attr] = removed_attributes.get(attr, 0) + 1
                element[attr] = re.sub('data:[^\\s\\)"\\\']+', '[data payload omitted]', str(element[attr]))
        if element.name in ('path', 'polygon', 'polyline'):
            for attr in ('d', 'points'):
                if attr in element.attrs:
                    del element[attr]
    moved = 0
    for child in list(root.children):
        if isinstance(child, Tag) and child is not head_node and (child is not body):
            body.append(child.extract())
            moved += 1
    for child in list(head_node.children):
        if isinstance(child, Tag) and child.name not in ('title', 'meta', 'base'):
            body.append(child.extract())
            moved += 1
    head = str(head_node)
    opening, closing = (_opening(root), '</html>')
    room = max_html_chars - len(opening) - len(head) - len(closing)
    if room < 256:
        raise ValueError('AccessGuru document metadata exceeds HTML budget')
    chunks = [opening + head + part + closing for part in _parts(body, room)]
    compact = str(root)
    provided = {element[NODE_ATTRIBUTE] for element in soup.find_all(True)}
    covered = {marker for chunk in chunks for marker in re.findall(NODE_ATTRIBUTE + '="([^"]+)"', chunk)}
    if provided != covered:
        raise ValueError('AccessGuru chunking omitted DOM node identities')
    return dict(revision=ADAPTER_REVISION, html=compact, chunks=chunks, nodeIndex={marker: index[marker] for marker in provided}, coverage=dict(originalHtmlChars=len(source), compactHtmlChars=len(compact), chunkCount=len(chunks), nodesProvided=len(provided), nodesCovered=len(covered), complete=True, removedResourceElements=dict(((tag, omitted.count(tag)) for tag in set(omitted))), removedResourceAttributes=removed_attributes, copiedNodesReparented=moved, unindexedMarkupRetainedAsText=unindexed_as_text, frameCoverageComplete=all((frame.get('accessible') for frame in snapshot.get('frames', []))) if isinstance(snapshot, dict) else None, frames=snapshot.get('frames', []) if isinstance(snapshot, dict) else []))
_IDENTITY_ATTRS = {'id', 'href', 'src', 'alt', 'aria-label', 'aria-labelledby', 'name', 'title', 'role', 'type', 'class', 'for', 'lang'}
_TARGET_TAGS = {'image-alt-not-descriptive': {'img', 'svg', 'object', 'input'}, 'link-text-mismatch': {'a'}, 'button-label-mismatch': {'button', 'input'}, 'form-label-mismatch': {'input', 'select', 'textarea'}, 'ambiguous-heading': {'h1', 'h2', 'h3', 'h4', 'h5', 'h6'}, 'page-title-not-descriptive': {'title'}, 'video-captions-not-descriptive': {'video', 'track'}}
_TARGET_ROLES = {'image-alt-not-descriptive': {'img', 'graphics-symbol', 'graphics-document'}, 'link-text-mismatch': {'link'}, 'button-label-mismatch': {'button'}, 'ambiguous-heading': {'heading'}, 'form-label-mismatch': {'textbox', 'combobox', 'listbox', 'checkbox', 'radio', 'slider', 'spinbutton'}}

def _normal(value):
    return re.sub('\\s+', ' ', ' '.join(value) if isinstance(value, list) else str(value or '')).strip()

def locate_items(items, evidence):
    soup = BeautifulSoup(evidence['html'], 'html.parser')
    by_marker = {e.get(NODE_ATTRIBUTE): e for e in soup.find_all(True)}
    index = evidence['nodeIndex']
    output = []
    for item in items:
        quoted = BeautifulSoup(item['snippet'], 'html.parser')
        roots = [n for n in quoted.contents if isinstance(n, Tag)]
        tags = _TARGET_TAGS.get(item.get('name'))
        roles = _TARGET_ROLES.get(item.get('name'), set())
        queries = roots if not tags else [q for root in roots for q in [root, *root.find_all(True)] if (q.name in tags or bool(set(str(q.get('role', '')).split()) & roles)) and (not (item.get('name') == 'image-alt-not-descriptive' and q.name == 'input' and (str(q.get('type', '')).lower() != 'image')))]
        candidates_at_depth = {id(query) for query in queries}
        queries = [q for q in queries if not any((id(parent) in candidates_at_depth for parent in q.parents))]
        paths, reasons = ([], [])
        for query in queries:
            marker = query.get(NODE_ATTRIBUTE)
            identifying = {k: v for k, v in query.attrs.items() if k in _IDENTITY_ATTRS}
            text = _normal(query.get_text(' ', strip=True))
            wildcard = any(('...' in _normal(v) or '…' in _normal(v) for v in identifying.values()))
            if wildcard:
                reasons.append('placeholder-attribute')
                continue
            candidates = [by_marker[marker]] if marker in by_marker else [] if marker else list(soup.find_all(query.name))

            def authored(candidate, key):
                return index.get(candidate.get(NODE_ATTRIBUTE), {}).get('attributes', {}).get(key, candidate.get(key))
            candidates = [candidate for candidate in candidates if candidate.name == query.name and all((_normal(candidate.get(k)) == _normal(v) or _normal(authored(candidate, k)) == _normal(v) for k, v in identifying.items()))]
            if text and '...' not in text and ('…' not in text):
                candidates = [candidate for candidate in candidates if text in _normal(candidate.get_text(' ', strip=True))]
            if not marker and (not identifying) and (not text):
                reasons.append('unidentified-element')
                continue
            if len(candidates) != 1:
                reasons.append('ambiguous' if candidates else 'not-found')
                continue
            target = candidates[0].get(NODE_ATTRIBUTE)
            if target in index:
                paths.append(index[target]['xpath'])
        paths = list(dict.fromkeys(paths))
        output.append({**item, 'xpath': paths[0] if paths else None, 'xpaths': paths, 'localization': dict(grounded=bool(paths), reasons=sorted(set(reasons)), method='frozen-dom-identity')})
    return output
