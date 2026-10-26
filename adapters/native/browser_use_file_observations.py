import ast
import inspect
from pathlib import Path
import textwrap
from urllib.parse import unquote, urlparse
POLICY = 'trusted-corpus-file-native-observations-v1'

def trusted_corpus_file(url, corpus_root):
    parsed = urlparse(url)
    if parsed.scheme != 'file' or parsed.netloc not in ('', 'localhost'):
        return False
    target = Path(unquote(parsed.path)).resolve()
    return target.is_relative_to(Path(corpus_root).resolve()) and target.is_file()

def install(corpus_root):
    from browser_use.browser.watchdogs.dom_watchdog import DOMWatchdog
    current = DOMWatchdog.on_BrowserStateRequestEvent
    if getattr(current, '_a11y_file_observation_policy', None) == POLICY:
        return current._a11y_file_observation_audit
    original = inspect.unwrap(current)
    if original.__code__.co_freevars:
        raise RuntimeError('Unexpected closure in native Browser Use observation handler')
    source = textwrap.dedent(inspect.getsource(original))
    tree = ast.parse(source)
    expected = ast.parse("page_url.lower().split(':', 1)[0] not in ('http', 'https')", mode='eval').body
    matches = [node for node in ast.walk(tree) if isinstance(node, ast.Assign) and any((isinstance(t, ast.Name) and t.id == 'not_a_meaningful_website' for t in node.targets))]
    if len(matches) != 1 or ast.dump(matches[0].value) != ast.dump(expected):
        raise RuntimeError('Native Browser Use URL predicate changed; observation repair requires review')
    node = matches[0]
    node.value = ast.BoolOp(op=ast.And(), values=[node.value, ast.UnaryOp(op=ast.Not(), operand=ast.Call(func=ast.Name(id='_a11y_trusted_corpus_file', ctx=ast.Load()), args=[ast.Name(id='page_url', ctx=ast.Load())], keywords=[]))])
    ast.fix_missing_locations(tree)
    namespace = {**original.__globals__, '_a11y_trusted_corpus_file': lambda url: trusted_corpus_file(url, corpus_root)}
    exec(compile(tree, '<browser-use-trusted-file-observations>', 'exec'), namespace)
    patched = namespace[original.__name__]
    audit = dict(policy=POLICY, corpusRoot=str(Path(corpus_root).resolve()), change='Only skip the non-HTTP shortcut for existing files inside the trusted neutral corpus')
    patched._a11y_file_observation_policy = POLICY
    patched._a11y_file_observation_audit = audit
    DOMWatchdog.on_BrowserStateRequestEvent = patched
    return audit
