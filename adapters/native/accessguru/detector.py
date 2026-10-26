import os
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'gena11y'))
import a11y_detector
from ag_consts import AG_SYSTEM, AXE_JS_PATH, SEMANTIC_PROMPT_TEMPLATE, SEMANTIC_TAXONOMY_STR, SEMANTIC_VIOLATIONS, VIOLATION_TO_SCS
from semantic_evidence import ADAPTER_REVISION, prepare_evidence, locate_items, parse_semantic_items, parse_semantic
from acquisition_scope import ROOTS_JS, instruction, scoped_items
with open(AXE_JS_PATH) as _f:
    _AXE_SRC = _f.read()
_AXE_RUN_JS = "\nvar cb = arguments[arguments.length - 1];\ntry {\n  // file:// has an opaque origin ('null'), which is not a valid postMessage target.\n  // Limit this bundled axe messaging configuration to offline fixture pages.\n  if (location.protocol === 'file:' && window.origin === 'null')\n    axe.configure({allowedOrigins: ['<unsafe_all_origins>']});\n  axe.run(document, {resultTypes: ['violations']})\n     .then(function (r) { cb(r.violations.map(function (v) { return v.id; })); })\n     .catch(function (e) { cb({__error: String(e)}); });\n} catch (e) { cb({__error: String(e)}); }\n"
_XPATH_OF_JS = "\nwindow.__agXpathOf = function (e) {\n  if (!e || e.nodeType !== 1) return null;\n  var parts = [];\n  for (var n = e; n && n.nodeType === 1; n = n.parentElement) {\n    var i = 1;\n    for (var s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === n.tagName) i++;\n    parts.unshift(n.tagName.toLowerCase() + '[' + i + ']');\n  }\n  return '/' + parts.join('/');\n};\n"
_SEMANTIC_SNAPSHOT_JS = "\nvar index = {}, frames = [], serial = 0;\nfunction snapshot(doc, prefix) {\n  // An inert document has no custom-element registry. Cloning into the live\n  // document can invoke site constructors and alter the copy or even the page.\n  var inert = doc.implementation.createHTMLDocument('');\n  var clone = inert.importNode(doc.documentElement, true);\n  function walk(original, copied, parentPath, ordinal) {\n    var tag = original.localName.toLowerCase();\n    var path = parentPath + '/' + tag + '[' + ordinal + ']';\n    var marker = 'ag-' + serial++;\n    copied.setAttribute('data-accessguru-node', marker);\n    index[marker] = {xpath: prefix + path, tag: tag};\n    var counts = {}, originals = Array.from(original.children), copies = Array.from(copied.children);\n    originals.forEach(function (child, i) {\n      var name = child.localName.toLowerCase(); counts[name] = (counts[name] || 0) + 1;\n      walk(child, copies[i], path, counts[name]);\n    });\n    if (tag === 'iframe') {\n      try {\n        if (original.contentDocument && original.contentDocument.documentElement) {\n          copied.appendChild(snapshot(original.contentDocument, prefix + path + '>>'));\n          frames.push({xpath: prefix + path, accessible: true});\n        } else frames.push({xpath: prefix + path, accessible: false});\n      } catch (e) { frames.push({xpath: prefix + path, accessible: false}); }\n    }\n  }\n  walk(doc.documentElement, clone, '', 1);\n  return clone;\n}\nreturn {html: snapshot(document, '').outerHTML, nodeIndex: index, frames: frames};\n"

def capture_semantic_evidence(driver, max_html_chars=60000):
    return prepare_evidence(driver.execute_script(_SEMANTIC_SNAPSHOT_JS), max_html_chars)

def locate_semantic_items(items, evidence):
    return locate_items(items, evidence)
_AXE_NODES_JS = "\nvar cb = arguments[arguments.length - 1];\ntry {\n  // file:// has an opaque origin ('null'), which is not a valid postMessage target.\n  // Limit this bundled axe messaging configuration to offline fixture pages.\n  if (location.protocol === 'file:' && window.origin === 'null')\n    axe.configure({allowedOrigins: ['<unsafe_all_origins>']});\n  axe.run(window.__agScopeContext || document, {resultTypes: ['violations'], elementRef: true})\n     .then(function (r) {\n       var out = [];\n       r.violations.forEach(function (v) { v.nodes.forEach(function (n) { out.push({id: v.id, xpath: window.__agXpathOf(n.element)}); }); });\n       cb(out);\n     })\n     .catch(function (e) { cb({__error: String(e)}); });\n} catch (e) { cb({__error: String(e)}); }\n"

def run_axe(driver, strict=False) -> list:
    try:
        driver.set_script_timeout(45)
        driver.execute_script(_AXE_SRC)
        result = driver.execute_async_script(_AXE_RUN_JS)
    except Exception:
        if strict:
            raise
        return []
    if isinstance(result, dict):
        if strict:
            raise RuntimeError(result.get('__error') or 'Invalid axe result')
        return []
    return [v for v in result or [] if isinstance(v, str)]

def run_axe_nodes(driver, strict=False, targets=None) -> list:
    try:
        if targets:
            driver.execute_script(_AXE_SRC)
            whole_page = any((t.get('page') for t in targets.values()))
            roots = driver.execute_script(ROOTS_JS, list(dict.fromkeys((p for t in targets.values() for p in t.get('keys', [])))))['roots'] if not whole_page else None
            if roots == []:
                return []
            driver.execute_script('window.__agScopeContext = arguments[0];', roots)
        driver.execute_script(_XPATH_OF_JS)
        result = driver.execute_async_script(_AXE_NODES_JS)
    except Exception:
        if strict:
            raise
        return []
    if strict and (not isinstance(result, list)):
        raise RuntimeError(str(result))
    return [r for r in result or [] if isinstance(r, dict)] if isinstance(result, list) else []

def locate_snippets(driver, snippets) -> list:
    if not snippets:
        return []
    evidence = capture_semantic_evidence(driver)
    return [item['xpath'] for item in locate_items([dict(snippet=snippet, name=None) for snippet in snippets], evidence)]

def axe_scs(violation_ids) -> set:
    scs = set()
    for vid in violation_ids:
        scs |= VIOLATION_TO_SCS.get(vid, set())
    return scs

def build_semantic_prompt(domain: str, url: str, html: str, max_html_chars: int=60000) -> str:
    if len(html) > max_html_chars:
        raise ValueError('Oversized AccessGuru input must be chunked; prefix truncation is disabled')
    return SEMANTIC_PROMPT_TEMPLATE.replace('{DOMAIN}', domain).replace('{URL}', url).replace('{TAXONOMY}', SEMANTIC_TAXONOMY_STR).replace('{HTML}', html) + '\n\nThis is a compact DOM copy: resource scripts/styles, CSS class/style attributes, tracking metadata and unlabelled SVG geometry are omitted; use the screenshot for appearance. data-accessguru-node attributes identify original DOM nodes and are instrumentation, not authored page attributes. Preserve these identifiers when quoting affected elements. Other independent chunks may contain additional page content; assess the supplied evidence. Quote the affected control/image/link itself when available, rather than its whole container.'

def semantic_scs(violation_names) -> set:
    scs = set()
    for name in violation_names:
        scs |= VIOLATION_TO_SCS.get(name, set())
    return scs

def detect_semantic(domain: str, url: str, html, screenshot_b64: str, on_response=None) -> dict:
    evidence = html if isinstance(html, dict) and 'chunks' in html else prepare_evidence(html)
    ledger = a11y_detector.timing_ledger()

    def evaluate(chunks, parallel_group=None):
        with ledger.span('chunk-group' if len(chunks) > 1 else 'split-group', 'accessguru-semantic-chunks', parallelGroup=parallel_group) as group:
            if len(chunks) > 1:
                middle = len(chunks) // 2
                replies, parallel = a11y_detector._parallel_pair(evaluate, chunks[:middle], chunks[middle:], group)
                a11y_detector._terminal_group_time(ledger, group, parallel)
                return replies
            chunk_index, chunk = chunks[0]
            prompt = build_semantic_prompt(domain, url, chunk)
            if evidence.get('evaluationScope'):
                prompt = instruction(evidence['evaluationScope'], evidence.get('scopeContext')) + prompt
            blocks = [a11y_detector._text_block(prompt)]
            if screenshot_b64:
                blocks.append(a11y_detector._b64_image_block(screenshot_b64))
            first = len(getattr(a11y_detector._CTX, 'http_attempts', []))
            prompt_text, raw, usage, reasoning, provider = a11y_detector.dispatch(blocks, system=AG_SYSTEM)
            reply = dict(chunkIndex=chunk_index, prompt=prompt_text, raw=raw, usage=usage, reasoning=reasoning, provider=provider, screenshotProvided=bool(screenshot_b64))
            if on_response:
                on_response(reply)
            if not raw or usage.get('finishReason') in ('MAX_TOKENS', 'length') or usage.get('error'):
                a11y_detector._exclude_last_http('missing-or-truncated-semantic-response')
                message = usage.get('error')
                if not message and usage.get('httpStatus'):
                    message = f"HTTP {usage['httpStatus']}: {usage.get('body', '')}"
                raise RuntimeError(message or 'Missing or truncated AccessGuru semantic response')
            calls = getattr(a11y_detector._CTX, 'http_attempts', [])[first:]
            group['successfulProcessingOverrideMs'] = sum((c.get('elapsedMs', 0) for c in calls if c.get('accepted')))
            return [reply]
    replies = sorted(evaluate(list(enumerate(evidence['chunks']))), key=lambda r: r['chunkIndex'])
    items, seen = ([], set())
    with ledger.span('processing', 'parse-and-ground-semantic-findings'):
        for reply in replies:
            chunk_evidence = {**evidence, 'html': evidence['chunks'][reply['chunkIndex']]}
            for item in locate_items(parse_semantic_items(reply['raw']), chunk_evidence):
                item['chunkIndex'] = reply['chunkIndex']
                identity = (item['name'], tuple(item['xpaths']), item['snippet'] if not item['xpaths'] else '')
                if identity not in seen:
                    seen.add(identity)
                    items.append(item)
    names = sorted({item['name'] for item in items if item['name']})
    scope_excluded = []
    if evidence.get('evaluationScope'):
        items, scope_excluded = scoped_items(items, evidence['evaluationScope'])
        names = sorted({item['name'] for item in items if item['name']})
    from openrouter_usage import summarize
    usage_records = [reply['usage'] for reply in replies]
    if a11y_detector._provider() == 'openrouter':
        usage = summarize(usage_records)
    else:
        keys = ('input_tokens', 'output_tokens', 'thoughts_tokens', 'reasoning_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'estimatedCostUsd', 'apiCostUsd', 'costUsd')
        usage = {key: sum((record[key] for record in usage_records)) if all((record.get(key) is not None for record in usage_records)) else None for key in keys if any((key in record for record in usage_records))}
    return {'violation_names': names, 'scs': sorted({sc for item in items for sc in item.get('scs', [])}) if evidence.get('evaluationScope') else sorted(semantic_scs(names)), 'scopeExcludedFindings': scope_excluded, 'raw': '\n\n'.join((reply['raw'] for reply in replies)), 'reasoning': '\n\n'.join((reply['reasoning'] or '' for reply in replies)), 'usage': usage, 'provider': replies[0]['provider'], 'items': items, 'chunks': replies, 'evidenceCoverage': evidence['coverage'], 'adapterRevision': ADAPTER_REVISION, 'parsingAudit': dict(items=len(items), unknownCategories=sum((i['isViolation'] is None for i in items)), negativeItems=sum((i['isViolation'] is False for i in items)), unlocalizedFindings=sum((bool(i['name'] and (not i['xpath'])) for i in items)))}
