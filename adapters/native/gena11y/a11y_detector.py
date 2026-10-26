import asyncio
import base64
import json
from pathlib import Path
import os
import re
import tempfile
import threading
import time
import sys
import urllib.request
from contextvars import copy_context
from concurrent.futures import Future
from call_timing import TimingLedger, VERSION as TIMING_VERSION
from openrouter_usage import normalize_response
from execution_health import ensure_provider_available, record_terminal, terminal_code
import requests
from dotenv import load_dotenv
from consts import CLAUDE_MODEL, SYSTEM_MESSAGE, TEMP_FILE_FOLDER
from helper import aggregate_responses, chunk_data
from link_contexts import group_link_contexts, render_contexts, split_contexts
MODEL = CLAUDE_MODEL
EFFORT = None
_LOCK = threading.Lock()
_LLM_SEM = threading.Semaphore(8)
_SPLIT_BRANCH_SEM = threading.BoundedSemaphore(7)
_CTX = threading.local()
TRACE_SINK = None
STANCE = 'original'
RULES = 'gena11y'
CONTEXT_DEDUP = False
_INTERA11Y_RULES = None
_HEADER = re.compile('Analyze compliance with WCAG SC (\\d+\\.\\d+\\.\\d+) \\(.*?(?=\\n(?:Elements prefixed|Use the screenshot|Look for form|Each element includes|-{6}))', re.S)

def _swap_rules(blocks: list) -> list:
    global _INTERA11Y_RULES
    if RULES != 'intera11y':
        return blocks
    if _INTERA11Y_RULES is None:
        _INTERA11Y_RULES = json.loads((Path(__file__).parent / 'intera11y-rules.json').read_text())
    out, swapped = ([], False)
    for b in blocks:
        if not swapped and isinstance(b, dict) and (b.get('type') == 'text') and ('Analyze compliance with WCAG SC' in b.get('text', '')):
            m = _HEADER.search(b['text'])
            if not m or m.group(1) not in _INTERA11Y_RULES:
                raise ValueError(f"cannot swap in InterA11y rules: header not recognised ({b['text'][:120]!r})")
            b = {**b, 'text': b['text'][:m.start()] + _INTERA11Y_RULES[m.group(1)] + b['text'][m.end():]}
            swapped = True
        out.append(b)
    return out
SYSTEM_NEUTRAL = 'You are an accessibility auditor testing one web page against one WCAG 2.2 success criterion.\n\nYou receive the criterion\'s test rules and the page\'s elements that the rules concern, each prefixed with a [path: /html/...] label giving its XPath, and sometimes a screenshot. For each element, decide whether it meets the criterion\'s test condition.\n\nVerdicts, one per element:\n- FAIL — the evidence shows the test condition is not met.\n- PASS — the evidence shows the test condition is met.\n- NOT_APPLICABLE — the evidence shows the criterion does not apply to this element (say which applicability condition it lacks).\n- UNDETERMINED — the evidence supports none of the above.\n\nIf the page has a failure of this criterion that is not one of the listed elements (or only a screenshot is given), report it under pageFindings with the XPath of the element it concerns if you have it, or null.\n\nAnswer with one JSON object and nothing else:\n{"elements":[{"xpath":"<the element\'s [path: ...] value, verbatim>","outerHTML":"<opening tag only>","verdict":"FAIL|PASS|NOT_APPLICABLE|UNDETERMINED","reason":"<why>"}],\n "pageFindings":[{"xpath":"<xpath or null>","outerHTML":"<opening tag, or empty>","reason":"…"}]}'
_BIAS = 'Be precise and avoid false positives — only flag clear violations, not ambiguous cases.'
if _BIAS not in SYSTEM_MESSAGE:
    raise RuntimeError('consts.SYSTEM_MESSAGE no longer carries the bias instruction step 1a removes')
SYSTEM_UNBIASED = SYSTEM_MESSAGE.replace(' ' + _BIAS, '')
LLM_STATS = {'calls': 0, 'done': 0, 'inputTokens': 0, 'outputTokens': 0, 'cacheReadTokens': 0, 'cacheCreateTokens': 0, 'costUsd': 0.0, 'thinkingTokens': 0, 'missingApiCostCalls': 0}

def configure(model: str=None, llm_concurrency: int=None, trace_sink=None, effort: str=None, stance: str=None, rules: str=None, deduplicate_link_contexts: bool=False) -> None:
    global MODEL, EFFORT, _LLM_SEM, _SPLIT_BRANCH_SEM, TRACE_SINK, STANCE, RULES, CONTEXT_DEDUP
    CONTEXT_DEDUP = deduplicate_link_contexts
    if rules:
        if rules not in ('gena11y', 'intera11y'):
            raise ValueError(f'unknown rules {rules}')
        RULES = rules
    if stance:
        if stance not in ('original', 'unbiased', 'neutral'):
            raise ValueError(f'unknown stance {stance}')
        STANCE = stance
    if model:
        MODEL = model
    EFFORT = effort
    if llm_concurrency:
        _LLM_SEM = threading.Semaphore(llm_concurrency)
        _SPLIT_BRANCH_SEM = threading.BoundedSemaphore(max(0, llm_concurrency - 1))
    if trace_sink is not None:
        TRACE_SINK = trace_sink

def set_context(sc: str, file: str) -> None:
    _CTX.sc, _CTX.file = (sc, file)
    _CTX.timing = TimingLedger()
    _CTX.last_llm_call = None
    _CTX.http_attempts = []
    _CTX.context_dedup = None

def timing_ledger():
    if not getattr(_CTX, 'timing', None):
        _CTX.timing = TimingLedger()
    return _CTX.timing

def _exclude_last_http(reason):
    attempts = getattr(_CTX, 'http_attempts', [])
    if attempts:
        timing_ledger().exclude(attempts[-1], reason)

def _backoff(seconds):
    with timing_ledger().span('wait', 'provider-backoff'):
        time.sleep(seconds)

def _b64_image_block(b64_data: str, media_type: str='image/png') -> dict:
    return {'type': 'image', 'source': {'type': 'base64', 'media_type': media_type, 'data': b64_data}}

def _url_image_block(url: str) -> dict:
    return {'type': 'image', 'source': {'type': 'url', 'url': url}}

def _text_block(text: str) -> dict:
    return {'type': 'text', 'text': text}

def _stat_add(input_tok=0, output_tok=0, cache_read=0, cache_create=0, cost=0.0, done=False, thinking=0):
    with _LOCK:
        LLM_STATS['inputTokens'] += int(input_tok or 0)
        LLM_STATS['outputTokens'] += int(output_tok or 0)
        LLM_STATS['cacheReadTokens'] += int(cache_read or 0)
        LLM_STATS['cacheCreateTokens'] += int(cache_create or 0)
        LLM_STATS['costUsd'] += float(cost or 0)
        LLM_STATS['thinkingTokens'] += int(thinking or 0)
        if done:
            LLM_STATS['done'] += 1

def _emit_trace(prompt_text, raw, verdict, usage, reasoning, provider, extra=None):
    sink = TRACE_SINK
    if sink is None:
        return
    rec = {'sc': getattr(_CTX, 'sc', None), 'file': getattr(_CTX, 'file', None), 'model': MODEL, 'provider': provider, 'prompt': prompt_text, 'raw': raw, 'verdict': verdict, 'reasoning': reasoning, 'usage': usage}
    if extra:
        rec.update(extra)
    try:
        with _LOCK:
            sink(rec)
    except Exception:
        pass

def _prepare_inline(content_blocks: list) -> tuple[str, list[tuple[str, str]]]:
    parts, images = ([], [])
    for block in content_blocks:
        if block['type'] == 'text':
            parts.append(block['text'])
        elif block['type'] == 'image':
            src = block['source']
            if src['type'] == 'base64':
                images.append((src.get('media_type', 'image/png'), src['data']))
            elif src['type'] == 'url':
                try:
                    data = urllib.request.urlopen(src['url'], timeout=30).read()
                    images.append(('image/png', base64.b64encode(data).decode()))
                    parts.append(f"[image: {src['url']}]")
                except Exception:
                    parts.append(f"[image URL (fetch failed): {src['url']}]")
    return (''.join(parts), images)
_UNPARSEABLE = ('No JSON object in response', 'JSON parse error', 'Unbalanced JSON')
_LONG_ATTR = re.compile('(=\\\\?["\\\'])([^"\\\'\\\\]{2000,})')

def _shorten_long_attributes(blocks: list) -> list:
    out = []
    for b in blocks:
        if isinstance(b, dict) and b.get('type') == 'text' and isinstance(b.get('text'), str) and (len(b['text']) > 2000):
            b = {**b, 'text': _LONG_ATTR.sub(lambda m: f'{m.group(1)}{m.group(2)[:200]}…[{len(m.group(2)) - 200} characters omitted]', b['text'])}
        out.append(b)
    return out

def _call_llm(content_blocks: list, _retries: int=3) -> dict:
    content_blocks = _swap_rules(_shorten_long_attributes(content_blocks))
    ledger = timing_ledger()
    for attempt in range(max(1, int(os.environ.get('A11Y_ANSWER_MAX_ATTEMPTS', '2')))):
        start = len(getattr(_CTX, 'http_attempts', []))
        with ledger.span('llm-group', 'logical-verdict-call', attempt=attempt) as call:
            prompt_text, raw, usage, reasoning, provider = dispatch(content_blocks, system={'neutral': SYSTEM_NEUTRAL, 'unbiased': SYSTEM_UNBIASED}.get(STANCE, SYSTEM_MESSAGE))
            verdict = _parse_verdict(raw) if raw else _no_verdict(f'{provider} transport returned no text ({usage})')
            if (usage or {}).get('error'):
                verdict['error'] = usage['error']
                verdict['failureKind'] = 'provider-terminal' if terminal_code(usage['error']) else 'provider-error'
            unparseable = verdict.get('verdict') == 'NO VERDICT' and any((m in verdict.get('summary', '') for m in _UNPARSEABLE))
            if (usage or {}).get('finishReason') in ('MAX_TOKENS', 'length'):
                verdict['truncated'] = True
            attempts = getattr(_CTX, 'http_attempts', [])[start:]
            accepted = verdict.get('verdict') != 'NO VERDICT' and (not verdict.get('truncated'))
            if not accepted:
                ledger.exclude(call, 'truncated-or-invalid-answer')
                _exclude_last_http('truncated-or-invalid-answer')
            good = [r for r in attempts if r.get('accepted') and 'elapsedMs' in r]
            call['successfulProcessingOverrideMs'] = good[-1]['elapsedMs'] if accepted and good else 0
            _CTX.last_llm_call = call
            _emit_trace(prompt_text, raw, verdict, usage, reasoning, provider, extra={'attempt': attempt, 'callId': call['id'], 'timing': {'version': TIMING_VERSION, 'accepted': accepted, 'processingMs': call['successfulProcessingOverrideMs'], 'instrumentationComplete': provider in ('gemini', 'openrouter', 'openai')}, 'httpAttempts': [{k: v for k, v in r.items() if not k.startswith('_')} for r in attempts]})
        if (usage or {}).get('error') or verdict.get('truncated') or (not unparseable):
            break
        content_blocks = content_blocks + [_text_block('The previous response could not be parsed: ' + verdict.get('summary', '') + '. Return the same assessment as valid JSON only. Escape double quotes ' + 'inside string values as \\"; a single quote must not have a backslash. ' + 'Do not request more input. Previous response:\n' + str(raw or '')[:8000])]
    return verdict

def _halves(chunk):
    if isinstance(chunk, dict):
        items = list(chunk.items())
        return [dict(items[:len(items) // 2]), dict(items[len(items) // 2:])]
    return [chunk[:len(chunk) // 2], chunk[len(chunk) // 2:]]

def _parallel_pair(fn, left, right, group):
    permit = _SPLIT_BRANCH_SEM
    if not permit.acquire(blocking=False):
        return (fn(left, None) + fn(right, None), False)
    context = copy_context()
    ledger = timing_ledger()
    sc, file = (getattr(_CTX, 'sc', None), getattr(_CTX, 'file', None))
    future = Future()

    def work():
        _CTX.sc, _CTX.file = (sc, file)
        _CTX.timing, _CTX.http_attempts, _CTX.last_llm_call = (ledger, [], None)
        try:
            future.set_result(context.run(fn, left, group['id']))
        except BaseException as exc:
            future.set_exception(exc)
        finally:
            permit.release()
    thread = threading.Thread(target=work, name='gena11y-independent-branch')
    thread.start()
    try:
        result = fn(right, group['id'])
    finally:
        thread.join()
    return (future.result() + result, True)

def _terminal_group_time(ledger, group, parallel):
    children = [r.get('successfulProcessingOverrideMs', 0) for r in ledger.records if r.get('parentId') == group['id'] and r['kind'] in ('split-group', 'chunk-group')]
    group['reduction'] = 'max-parallel-final-branches' if parallel else 'sum-sequential-final-branches'
    group['successfulProcessingOverrideMs'] = max(children, default=0) if parallel else sum(children)

def _call_chunks(chunks, build, parallel_group=None, split=None):
    if not chunks:
        return []
    if len(chunks) == 1:
        return _call_chunk(chunks[0], build, parallel_group, split=split)
    ledger = timing_ledger()
    with ledger.span('chunk-group', 'independent-chunks', parallelGroup=parallel_group) as group:
        middle = len(chunks) // 2
        answers, parallel = _parallel_pair(lambda part, pg: _call_chunks(part, build, pg, split=split), chunks[:middle], chunks[middle:], group)
        _terminal_group_time(ledger, group, parallel)
        return answers

def _call_chunk(chunk, build, parallel_group=None, split=None) -> list:
    ledger = timing_ledger()
    with ledger.span('split-group', 'chunk', parallelGroup=parallel_group) as group:
        verdict = _call_llm(build(chunk))
        call = getattr(_CTX, 'last_llm_call', None)
        halves = (split(chunk) if split else _halves(chunk) if len(chunk) >= 2 else None) if verdict.get('truncated') else None
        if halves:
            if call:
                ledger.exclude(call, 'superseded-by-split')
            a, b = halves
            answers, parallel = _parallel_pair(lambda part, pg: _call_chunk(part, build, pg, split=split), a, b, group)
            _terminal_group_time(ledger, group, parallel)
            return answers
        group['successfulProcessingOverrideMs'] = call.get('successfulProcessingOverrideMs', 0) if call and call.get('accepted') else 0
        return [verdict]

def _cleanup(paths: list) -> None:
    for p in paths:
        try:
            os.unlink(p)
        except Exception:
            pass

def _parse_verdict(text: str) -> dict:
    text = re.sub('^```[a-z]*\\n?', '', text.strip(), flags=re.MULTILINE)
    text = re.sub('\\n?```$', '', text.strip(), flags=re.MULTILINE)
    start = text.find('{')
    if start < 0:
        return _no_verdict('No JSON object in response')
    depth, in_str, esc = (0, False, False)
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if esc:
                esc = False
            elif ch == '\\':
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                span = text[start:i + 1]
                try:
                    obj = json.loads(span)
                except Exception:
                    return _no_verdict('JSON parse error')
                return _normalize(obj)
    return _no_verdict('Unbalanced JSON')

def _normalize_neutral(obj: dict) -> dict:
    elements = [e for e in obj.get('elements') or [] if isinstance(e, dict)]
    findings = [f for f in obj.get('pageFindings') or [] if isinstance(f, dict)]
    fails = [e for e in elements if str(e.get('verdict', '')).upper() == 'FAIL']
    counts = {}
    for e in elements:
        v = str(e.get('verdict', '')).upper() or 'MISSING'
        counts[v] = counts.get(v, 0) + 1
    violations = [{'xpath': v.get('xpath'), 'outerHTML': v.get('outerHTML', ''), 'reason': ' — '.join((x for x in (v.get('evidence', ''), v.get('reason', '')) if x)), 'recommendation': ''} for v in fails + findings]
    return {'verdict': 'REPRODUCED' if violations else 'NOT REPRODUCED', 'confidence': 'medium', 'violations': violations, 'summary': f'element verdicts {counts}; page findings {len(findings)}', 'elementVerdicts': counts}

def _normalize(obj: dict) -> dict:
    if STANCE == 'neutral':
        return _normalize_neutral(obj)
    valid_verdicts = {'REPRODUCED', 'NOT REPRODUCED', 'PARTIAL'}
    verdict = obj.get('verdict', 'NOT REPRODUCED')
    if verdict not in valid_verdicts:
        verdict = 'NOT REPRODUCED'
    violations = obj.get('violations', [])
    if not isinstance(violations, list):
        violations = []
    return {'verdict': verdict, 'confidence': obj.get('confidence', 'low') if obj.get('confidence') in ('high', 'medium', 'low') else 'low', 'violations': [{'xpath': v.get('xpath'), 'outerHTML': v.get('outerHTML', ''), 'reason': v.get('reason', ''), 'recommendation': v.get('recommendation', '')} for v in violations if isinstance(v, dict)], 'summary': obj.get('summary', '')}

def _error_verdict(msg: str) -> dict:
    return {'verdict': 'NOT REPRODUCED', 'confidence': 'low', 'violations': [], 'summary': f'Analysis error: {msg}'}

def _no_verdict(msg: str) -> dict:
    return {'verdict': 'NO VERDICT', 'confidence': 'low', 'violations': [], 'summary': f'No verdict: {msg}'}

def detect_page_title(page_title_dict: dict) -> dict:
    user_text = f"Analyze compliance with WCAG SC 2.4.2 (Page Titled).\nTest rules:\n1. The page title must not be null or empty.\n2. The page title must be descriptive of the page content.\n------------------\nTitle: {page_title_dict['title']}\nPortion of page text: {page_title_dict['portion_text']}\n"
    return _call_llm([_text_block(user_text)])

def detect_non_text_content(visual_elements_dict: dict) -> dict:
    chunks = chunk_data(visual_elements_dict, threshold_tokens=20000, max_chunk_tokens=5000)
    responses = []
    base_text = 'Analyze compliance with WCAG SC 1.1.1 (Non-text Content).\nTest rules:\n1. Image buttons must have a non-empty accessible name.\n2. Images, videos, and audio must have non-empty accessible names unless decorative (alt="", role="presentation", aria-hidden="true").\n3. Accessible names must be meaningful, not just filenames or "image".\n4. Object elements must have accessible names.\n5. SVG elements with explicit roles must have accessible names.\nElements prefixed with [path: ...] give the XPath of the element.\n------------------\n'
    responses = _call_chunks(chunks, lambda c: [_text_block(base_text + '\n'.join((f'{k}: {v}' for k, v in c.items())))])
    return aggregate_responses(responses) if responses else _error_verdict('No elements')

def detect_images_of_text(img_urls: list) -> dict:
    if not img_urls:
        return {'verdict': 'NOT REPRODUCED', 'confidence': 'high', 'violations': [], 'summary': 'No images found on page.'}
    base_text = 'Analyze compliance with WCAG SC 1.4.5 (Images of Text).\nFor each image, determine if it contains visible text that could instead be rendered as actual text.\nExceptions: purely decorative images, logos, essential text (e.g., in diagrams).\n------------------\n'
    valid_exts = ('.png', '.jpg', '.jpeg', '.gif', '.webp')
    checkable = [u for u in img_urls if u and any((u.lower().endswith(e) for e in valid_exts))][:10]
    if not checkable:
        return {'verdict': 'NOT REPRODUCED', 'confidence': 'medium', 'violations': [], 'summary': 'No checkable image URLs found.'}
    blocks = [_text_block(base_text)]
    for url in checkable:
        try:
            blocks.append(_url_image_block(url))
            blocks.append(_text_block(f'Image URL: {url}\n--\n'))
        except Exception:
            continue
    return _call_llm(blocks)

def detect_missing_labels(form_elements: list) -> dict:
    if not form_elements:
        return {'verdict': 'NOT REPRODUCED', 'confidence': 'high', 'violations': [], 'summary': 'No form elements found.'}
    chunks = chunk_data(form_elements)
    base_text = 'Analyze compliance with WCAG SC 3.3.2 (Labels or Instructions).\nTest rules:\n1. Groups with nested inputs must have a unique accessible name (fieldset + legend).\n2. Checkboxes and radio buttons must have a label after the control.\n3. Text inputs and <select> elements must have a label before the control.\n4. The HTML5 placeholder must not replace a visible label.\n5. Each input must have an associated visible label.\nElements prefixed with [path: ...] give the XPath.\n------------------\n'
    responses = []

    def build(chunk):
        content = base_text + '\n-------------\n'.join((str(e) for e in chunk))
        return [_text_block(content)]
    responses = _call_chunks(chunks, build)
    return aggregate_responses(responses)

def detect_reflow(reflow_dict: dict) -> dict:
    blocks = [_text_block('Analyze compliance with WCAG SC 1.4.10 (Reflow).\nThe first screenshot shows the original page, the second shows it at 400% zoom with a 1280×1024 viewport.\nFailures:\n1. Content disappears after zooming and is no longer available.\n2. The page requires scrolling in two dimensions to read content at 400% zoom.\n------------------\n'), _b64_image_block(reflow_dict['original']), _text_block('Above: original. Below: 400% zoom.\n'), _b64_image_block(reflow_dict['reflow'])]
    return _call_llm(blocks)

def detect_link_purpose(link_list: list) -> dict:
    if not link_list:
        return {'verdict': 'NOT REPRODUCED', 'confidence': 'high', 'violations': [], 'summary': 'No links found on page.'}
    base_text = 'Analyze compliance with WCAG SC 2.4.4 (Link Purpose In Context).\nA link passes if its purpose is clear from its accessible name OR from its surrounding context (same sentence, paragraph, list item, or table cell).\nTest rules:\n1. The link must have a non-empty accessible name.\n2. The link in context must be descriptive (not just "click here", "read more", etc. unless context clarifies the destination).\n3. Links with identical names in the same context must serve an equivalent purpose.\nElements prefixed with [path: ...] give the XPath of the link.\n------------------\n'
    if CONTEXT_DEDUP:
        groups, audit = group_link_contexts(link_list)
        _CTX.context_dedup = audit
        if TRACE_SINK:
            with _LOCK:
                TRACE_SINK({'kind': 'context-dedup', 'sc': '2.4.4', 'file': getattr(_CTX, 'file', None), **audit})
        shared_text = base_text + 'Each shared HTML context is supplied once, followed by all of its target links. Match each target using its relative XPath and link HTML. Judge each target individually; sharing context does not imply equal conformance. All peers remain available as context. Report findings only for the target XPaths designated for evaluation in this call, using their absolute XPaths. Never copy a finding to the other targets.\n'
        responses = _call_chunks(chunk_data(groups), lambda c: [_text_block(shared_text + render_contexts(c))], split=split_contexts)
        return aggregate_responses(responses)
    chunks = chunk_data(link_list)
    responses = []
    responses = _call_chunks(chunks, lambda c: [_text_block(base_text + '\n-------------\n'.join((str(e) for e in c)))])
    return aggregate_responses(responses)

def detect_contrast(contrast_list: list, bg_image_dict: dict) -> dict:
    base_text = 'Analyze compliance with WCAG SC 1.4.3 (Contrast Minimum).\nTest rules:\n1. Normal text and its background must achieve at least 4.5:1 contrast ratio.\n2. Large text (≥18pt normal or ≥14pt bold) must achieve at least 3:1.\n3. When a background image is present, check text readability from the screenshot.\nElements prefixed with [path: ...] give the XPath. Each element includes inline style with color/font-size/background-color for reference.\n------------------\n'
    text_data = [{'type': 'text', 'content': t} for t in contrast_list]
    img_data = [{'type': 'image', 'html': k, 'b64': v} for k, v in bg_image_dict.items()]
    combined = text_data + img_data
    chunks = chunk_data(combined)
    responses = []

    def build(chunk):
        blocks = [_text_block(base_text)]
        for item in chunk:
            if item['type'] == 'text':
                blocks.append(_text_block(f"{item['content']}\n-------------\n"))
            else:
                blocks.append(_text_block(f"{item['html']}\n"))
                blocks.append(_b64_image_block(item['b64']))
                blocks.append(_text_block('-------------\n'))
        return blocks
    responses = _call_chunks(chunks, build)
    return aggregate_responses(responses) if responses else _error_verdict('No contrast data')

def detect_headings_labels(form_and_headings: dict) -> dict:
    base_text = 'Analyze compliance with WCAG SC 2.4.6 (Headings and Labels).\nA heading or label passes if it is present AND descriptive. Missing headings/labels are NOT violations of this SC — only non-descriptive ones are.\nTest rules:\n1. If a heading is present, it must describe the section it introduces.\n2. If a form field label is present, it must describe the purpose of the field.\nElements prefixed with [path: ...] give the XPath.\n------------------\n'
    headings = form_and_headings.get('headings', [])
    forms = form_and_headings.get('forms', [])
    combined = [{'type': 'heading', 'content': h} for h in headings] + [{'type': 'form', 'content': f} for f in forms]
    chunks = chunk_data(combined)
    responses = []

    def build(chunk):
        lines = [base_text, 'Headings:\n']
        for item in chunk:
            if item['type'] == 'heading':
                lines.append(f"{item['content']}\n-------------\n")
        lines.append('\nForm containers:\n')
        for item in chunk:
            if item['type'] == 'form':
                lines.append(f"{item['content']}\n-------------\n")
        return [_text_block(''.join(lines))]
    responses = _call_chunks(chunks, build)
    return aggregate_responses(responses) if responses else _error_verdict('No heading/label data')

def detect_section_headings(section_list: list, screenshot_b64: str) -> dict:
    base_blocks = [_text_block('Analyze compliance with WCAG SC 2.4.10 (Section Headings).\nTest rules:\n1. Each distinct section of content should have a heading.\n2. Each heading should be descriptive of its section.\nUse the screenshot to identify visual sections not marked up with <section>.\n------------------\n'), _b64_image_block(screenshot_b64), _text_block('Section heading data:\n')]
    for i, sec in enumerate(section_list, 1):
        if sec.get('no_heading'):
            base_blocks.append(_text_block(f'Section {i}: no heading present.\n-------------\n'))
        else:
            base_blocks.append(_text_block(f"Section {i} heading: {sec.get('headings', '')}\n-------------\n"))
    return _call_llm(base_blocks)

def detect_info_relation(info_dict: dict) -> dict:
    base_text = 'Analyze compliance with WCAG SC 1.3.1 (Info and Relationships).\nCommon failures:\n- Tables: missing <th>, missing scope, inconsistent columns, layout tables with semantics.\n- ARIA: invalid roles, missing required context, missing required owned elements.\n- onClick on divs/spans emulating links without role="link".\n- White-space columns/tables in <pre> or plain text.\n- Headings not hierarchical; empty headings.\n- Lists/definitions marked up incorrectly.\n- Radio/checkbox groups not in a <fieldset>.\n- Fieldset without a <legend>.\n- CSS ::before/::after content conveying non-decorative information.\nElements prefixed with [path: ...] give the XPath.\n------------------\n'
    combined = []
    for key, items in info_dict.items():
        if isinstance(items, list):
            combined.extend(({'_key': key, 'content': item} for item in items))
        else:
            combined.append({'_key': key, 'content': str(items)})
    chunks = chunk_data(combined)
    responses = []

    def build(chunk):
        lines = [base_text]
        for item in chunk:
            lines.append(f"{item['_key'].replace('_', ' ').capitalize()}:\n")
            lines.append(f"{item['content']}\n-------------\n")
        return [_text_block(''.join(lines))]
    responses = _call_chunks(chunks, build)
    return aggregate_responses(responses) if responses else _error_verdict('No info/relation data')

def detect_meaningful_sequence(table_list: list, whitespace_list: list, layout_list: list) -> dict:
    base_text = 'Analyze compliance with WCAG SC 1.3.2 (Meaningful Sequence).\nCommon failures:\n1. Layout table whose linearized order does not match reading order.\n2. White-space characters used to create visual spacing within words.\n3. CSS float/flex/grid that rearranges visual vs. DOM order meaningfully.\n------------------\n'
    combined = [{'type': 'table', 'original': t['original'], 'linear': t['linearized']} for t in table_list] + [{'type': 'whitespace', 'content': w} for w in whitespace_list] + [{'type': 'layout', 'content': l} for l in layout_list]
    chunks = chunk_data(combined)
    responses = []

    def build(chunk):
        lines = [base_text]
        for item in chunk:
            if item['type'] == 'table':
                lines.append(f"Original table:\n{item['original']}\nLinearized:\n{item['linear']}\n-------------\n")
            elif item['type'] == 'whitespace':
                lines.append(f"White-space formatted text:\n{item['content']}\n-------------\n")
            else:
                lines.append(f"Layout-rearranged element:\n{item['content']}\n-------------\n")
        return [_text_block(''.join(lines))]
    responses = _call_chunks(chunks, build)
    return aggregate_responses(responses) if responses else _error_verdict('No sequence data')

def detect_name_role_value(name_role_dict: dict, form_dict: list) -> dict:
    base_text = 'Analyze compliance with WCAG SC 4.1.2 (Name, Role, Value).\nTest rules:\n1. Buttons must have non-empty, descriptive accessible names.\n2. Elements with aria-hidden must not receive focus.\n3. Form fields must have non-empty, descriptive accessible names; one label per field.\n4. Menu items must have non-empty, descriptive accessible names.\n5. Iframes must have non-empty, descriptive accessible names; identical names → same purpose.\n6. div/span used as controls (with onclick/keydown) must have an appropriate ARIA role.\n7. Links must have valid href values.\nElements prefixed with [path: ...] give the XPath.\n------------------\n'
    combined = []
    for key, items in name_role_dict.items():
        combined.extend(({'_key': key, 'content': item} for item in items))
    for form in form_dict or []:
        combined.append({'_key': 'form', 'content': form})
    if not combined:
        base_text += 'Extracted page elements: [] (extraction completed; no matching elements). Return the prescribed JSON for the supplied evidence.\n'
    chunks = chunk_data(combined)
    responses = []
    responses = _call_chunks(chunks, lambda c: [_text_block(base_text + ''.join((f"{item['_key'].replace('_', ' ').capitalize()}:\n{item['content']}\n-------------\n" for item in c)))])
    return aggregate_responses(responses) if responses else _error_verdict('No name/role data')

def detect_use_of_color(color_dict: dict) -> dict:
    blocks = [_text_block('Analyze compliance with WCAG SC 1.4.1 (Use of Color).\nTest rules:\n1. Links distinguished only by color must also have another visual indicator (underline, bold, different lightness, etc.).\n2. Required or error form fields identified only by color must have an additional non-color indicator (asterisk, label text, icon, etc.).\nUse the screenshot to identify these situations.\n------------------\n'), _b64_image_block(color_dict['screenshot'])]
    return _call_llm(blocks)

def detect_error_identification(screenshot_b64: str) -> dict:
    blocks = [_text_block('Analyze compliance with WCAG SC 3.3.1 (Error Identification).\nTest rules:\n1. If an input error is automatically detected, the item in error must be identified    and the error described to the user in text.\nLook for form validation errors visible in the screenshot.' + ('\n' if STANCE == 'neutral' else ' If no form or error state is present, the page passes.\n') + '------------------\n'), _b64_image_block(screenshot_b64)]
    return _call_llm(blocks)

def detect_error_suggestion(screenshot_b64: str) -> dict:
    blocks = [_text_block('Analyze compliance with WCAG SC 3.3.3 (Error Suggestion).\nTest rules:\n1. If an input error is detected and suggestions for correction are known, the    suggestion must be provided in text (unless it would jeopardize security).\nLook for form validation errors in the screenshot and check whether a correction suggestion is provided. If no error state is visible, the page passes.\n------------------\n'), _b64_image_block(screenshot_b64)]
    return _call_llm(blocks)

def detect_for_sc(sc: str, data) -> dict:
    sc = sc.strip()
    try:
        if sc == '1.1.1':
            return detect_non_text_content(data)
        if sc == '1.3.1':
            return detect_info_relation(data)
        if sc == '1.3.2':
            return detect_meaningful_sequence(data[0], data[1], data[2])
        if sc == '1.4.1':
            return detect_use_of_color(data)
        if sc == '1.4.3':
            return detect_contrast(data[0], data[1])
        if sc == '1.4.5':
            return detect_images_of_text(data)
        if sc == '1.4.10':
            return detect_reflow(data)
        if sc == '2.4.2':
            return detect_page_title(data)
        if sc == '2.4.4':
            return detect_link_purpose(data)
        if sc == '2.4.6':
            return detect_headings_labels(data)
        if sc == '2.4.10':
            return detect_section_headings(data[0], data[1])
        if sc == '3.3.1':
            return detect_error_identification(data)
        if sc == '3.3.2':
            return detect_missing_labels(data)
        if sc == '3.3.3':
            return detect_error_suggestion(data)
        if sc == '4.1.2':
            return detect_name_role_value(data, [])
    except Exception as e:
        return _no_verdict(f'Exception in detect_for_sc({sc}): {e}')
    return _error_verdict(f'SC {sc} not handled by detector')
