import inspect
import logging
import time
import textwrap
import json
import os
import base64
import io
import asyncio
from contextlib import nullcontext
import numpy as np
from PIL import Image
import browsergym.core.env as env
import browsergym.core.observation as observation
from browsergym.core.task import OpenEndedTask
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright._impl._sync_base import mapping
REVISION = 'saved-page-runtime-r15'
logger = logging.getLogger(__name__)
_ledger_getter = lambda: None

def _frame_evaluate(frame, script, arg=None):

    async def run():
        try:
            return await asyncio.wait_for(frame._impl_obj.evaluate(script, arg), 30)
        except asyncio.TimeoutError as exc:
            _phase(frame.url, 'frame-evaluation.timeout')
            raise PlaywrightTimeoutError('BrowserGym frame observation exceeded 30 seconds') from exc
    ledger = _ledger_getter()
    scope = ledger.span('processing', 'browsergym-frame-observation') if ledger else nullcontext()
    with scope:
        return frame._sync(run())

def _phase(url, phase):
    path = os.environ.get('AGENTLAB_RUNTIME_TRACE_FILE')
    if path:
        with open(path, 'a') as log:
            log.write(json.dumps({'time': time.time(), 'phase': phase, 'url': url}) + '\n')

def _traced_title(page):
    _phase(page.url, 'title.start')

    async def run():
        try:
            return await asyncio.wait_for(page._impl_obj.title(), 30)
        except asyncio.TimeoutError as exc:
            _phase(page.url, 'title.timeout')
            raise PlaywrightTimeoutError('BrowserGym page title observation exceeded 30 seconds') from exc
    title = page._sync(run())
    _phase(page.url, 'title.end')
    return title

def _read_attribute(element, name):
    return _bounded_metadata(element, 'evaluate', '(el, name) => el.isConnected ? el.getAttribute(name) : null', name)

def _bounded_metadata(owner, method, *args):
    url = getattr(owner, 'url', '<frame-host>')
    _phase(url, 'frame-metadata.' + method + '.start')

    async def run():
        try:
            return await asyncio.wait_for(getattr(owner._impl_obj, method)(*args), 30)
        except asyncio.TimeoutError as exc:
            _phase(url, 'frame-metadata.' + method + '.timeout')
            raise PlaywrightTimeoutError(f'BrowserGym frame observation exceeded 30 seconds ({method})') from exc
    ledger = _ledger_getter()
    scope = ledger.span('processing', 'browsergym-frame-metadata') if ledger else nullcontext()
    with scope:
        result = owner._sync(run())
    _phase(url, 'frame-metadata.' + method + '.end')
    return result

def _frame_element(frame):
    return mapping.from_impl(_bounded_metadata(frame, 'frame_element'))

def _content_frame(element):
    return mapping.from_impl_nullable(_bounded_metadata(element, 'content_frame'))

def _host_visible(element):
    return _bounded_metadata(element, 'evaluate', "el => {\n        if (!el.isConnected) return false;\n        if (el.checkVisibility && !el.checkVisibility()) return false;\n        const style = getComputedStyle(el);\n        if (style.visibility !== 'visible') return false;\n        const rect = el.getBoundingClientRect();\n        return rect.width > 0 && rect.height > 0;\n    }")

def _frame_outside_viewport(frame, page):
    host = _frame_element(frame)
    if not _host_visible(host):
        return True
    box = _bounded_metadata(host, 'bounding_box')
    viewport = page.viewport_size
    if not box:
        return True
    return bool(viewport and (box['x'] + box['width'] <= 0 or box['y'] + box['height'] <= 0 or box['x'] >= viewport['width'] or (box['y'] >= viewport['height'])))

def install(ledger_getter=lambda: None):
    global _ledger_getter
    _ledger_getter = ledger_getter
    from execution_health import browser_startup
    from playwright.sync_api import BrowserType
    if not getattr(BrowserType.launch, '_a11y_startup_gate', False):
        native_launch = BrowserType.launch

        def gated_launch(self, *args, **kwargs):
            with browser_startup(ledger_getter()):
                kwargs.setdefault('timeout', 120000)
                return native_launch(self, *args, **kwargs)
        gated_launch._a11y_startup_gate = True
        BrowserType.launch = gated_launch
    replacements = {'_pre_extract': [('    js_frame_mark_elements = pkgutil.get_data(', '    snapshot_frames = frozenset(page.frames)\n    js_frame_mark_elements = pkgutil.get_data('), ('        for child_frame in frame.child_frames:\n', '        for child_frame in frame.child_frames:\n            if child_frame not in snapshot_frames:\n                _phase(child_frame.url, "mark.deferred-new-frame")\n                continue\n'), ('if child_frame.is_detached():', 'if child_frame.is_detached() or not child_frame.url:'), ('warning_msgs = frame.evaluate(\n            js_frame_mark_elements,', 'frame_js = js_frame_mark_elements\n        frame_js = frame_js.replace("    i = 0;", "    let i = 0;")\n        frame_js = frame_js.replace("    warning_msgs = new Array();", "    let warning_msgs = new Array();")\n        frame_js = frame_js.replace("if (elem.shadowRoot !== null)", "if (elem.shadowRoot)")\n        if frame_bid and _frame_outside_viewport(frame, page):\n            frame_js = frame_js.replace(\n                "await until(() => elems_to_be_visited.size == 0, visibility_marking_timeout);",\n                "/* Hidden frame: visibility remains zero; all elements are still marked. */")\n        _phase(frame.url, "mark.start")\n        warning_msgs = _frame_evaluate(frame,\n            frame_js,'), ('# print warning messages if any', '_phase(frame.url, "mark.end")\n        # print warning messages if any'), ('child_frame_elem.get_attribute("sandbox")', '_read_attribute(child_frame_elem, "sandbox")'), ('child_frame_elem.get_attribute(BID_ATTR)', '_read_attribute(child_frame_elem, BID_ATTR)'), ('child_frame_elem = child_frame.frame_element()', 'child_frame_elem = _frame_element(child_frame)'), ('child_frame_elem.content_frame()', '_content_frame(child_frame_elem)')], '_post_extract': [("    # we can't run this loop in JS due to Same-Origin Policy", '    # Preserve cleanup traversal order without expanding a large DOM into function arguments.\n    js_frame_unmark_elements = js_frame_unmark_elements.replace(\n        "if (elem.shadowRoot !== null)", "if (elem.shadowRoot)")\n    js_frame_unmark_elements = js_frame_unmark_elements.replace(\n        "new Array(\\n                ...Array.prototype.slice.call(elements, 0, i + 1),\\n"\n        "                ...Array.from(elem.shadowRoot.querySelectorAll(\\"*\\")),\\n"\n        "                ...Array.prototype.slice.call(elements, i + 1)\\n            )",\n        "elements.slice(0, i + 1).concat(Array.from(elem.shadowRoot.querySelectorAll(\\"*\\")), elements.slice(i + 1))")\n\n    # we can\'t run this loop in JS due to Same-Origin Policy'), ('for frame in page.frames:', 'for frame in page.frames:\n        if not frame.url or frame.is_detached():\n            continue'), ('frame.evaluate(js_frame_unmark_elements)', '_phase(frame.url, "unmark.start")\n            _frame_evaluate(frame, js_frame_unmark_elements)\n            _phase(frame.url, "unmark.end")'), ('frame.frame_element().get_attribute("sandbox")', '_read_attribute(frame.frame_element(), "sandbox")'), ('frame.frame_element().get_attribute(BID_ATTR)', '_read_attribute(frame.frame_element(), BID_ATTR)')]}
    observation._frame_outside_viewport = _frame_outside_viewport
    observation._phase = _phase
    observation._read_attribute = _read_attribute
    observation._frame_evaluate = _frame_evaluate
    observation._frame_element = _frame_element
    observation._content_frame = _content_frame
    for name, edits in replacements.items():
        source = inspect.getsource(getattr(observation, name))
        for old, new in edits:
            if source.count(old) != 1:
                raise RuntimeError(f'Unsupported BrowserGym implementation: {name}')
            source = source.replace(old, new)
        if name == '_post_extract':
            source = source.replace('frame.frame_element()', '_frame_element(frame)')
            source = source.replace('_frame_element(frame).content_frame()', '_content_frame(_frame_element(frame))')
        if name == '_pre_extract':
            marker = '        for child_frame in frame.child_frames:\n'
            start = source.index(marker) + len(marker)
            end = source.index('\n    # mark all frames recursively', start)
            body = source[start:end]
            source = source[:start] + '            try:\n' + textwrap.indent(body, '    ') + '\n            except playwright.sync_api.Error:\n' + '                if child_frame.is_detached():\n' + '                    continue\n' + '                raise\n' + source[end:]
        exec(compile(source, f'<{REVISION}:{name}>', 'exec'), observation.__dict__)
        setattr(env, name, getattr(observation, name))
    source = textwrap.dedent(inspect.getsource(env.BrowserEnv._get_obs))
    old = 'or "Cannot read properties of undefined" in err_msg'
    if source.count(old) != 1:
        raise RuntimeError('Unsupported BrowserGym implementation: _get_obs')
    source = source.replace(old, old + '\n                or "ElementHandle.get_attribute: Timeout" in err_msg' + '\n                or "BrowserGym frame observation exceeded" in err_msg')
    for assignment, call in [('dom', 'extract_dom_snapshot'), ('axtree', 'extract_merged_axtree'), ('focused_element_bid', 'extract_focused_element_bid')]:
        old = f'{assignment} = {call}(self.page)'
        source = source.replace(old, f'_phase(self.page.url, "{assignment}.start")\n            {old}\n            _phase(self.page.url, "{assignment}.end")')
    env._phase = _phase
    env._traced_title = _traced_title
    source = source.replace('page.title() for page in self.context.pages', '_traced_title(page) for page in self.context.pages')
    original_screenshot = env.extract_screenshot

    def traced_screenshot(page):
        _phase(page.url, 'screenshot.start')
        if getattr(page, '_bgym_scale_factor', 1.0) == 1.0:
            cdp = page.context.new_cdp_session(page)
            try:
                answer = cdp.send('Page.captureScreenshot', {'format': 'png'})
            finally:
                cdp.detach()
            with Image.open(io.BytesIO(base64.b64decode(answer['data']))) as img:
                result = np.array(img.convert('RGB'))
        else:
            result = original_screenshot(page)
        _phase(page.url, 'screenshot.end')
        return result
    env.extract_screenshot = traced_screenshot
    exec(compile(source, f'<{REVISION}:_get_obs>', 'exec'), env.__dict__)
    env.BrowserEnv._get_obs = env._get_obs

    def wait_dom_loaded(self):
        deadline = time.monotonic() + 3
        for page in self.context.pages:
            for frame in [page.main_frame, *page.frames[1:]]:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return
                if not frame.url or frame.is_detached():
                    continue
                try:
                    frame.wait_for_load_state('domcontentloaded', timeout=max(1, int(remaining * 1000)))
                except observation.playwright.sync_api.Error:
                    pass
    env.BrowserEnv._wait_dom_loaded = wait_dom_loaded
    original_setup = OpenEndedTask.setup

    def setup(self, page):
        try:
            return original_setup(self, page)
        except PlaywrightTimeoutError:
            page.wait_for_load_state('domcontentloaded', timeout=60000)
            if page.url == 'about:blank' or not page.url:
                raise RuntimeError('Starting document did not load')
            logger.warning('Initial load event timed out; document is ready: %s', page.url)
            return (self.goal, {})
    OpenEndedTask.setup = setup
