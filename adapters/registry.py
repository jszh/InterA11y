"""One adapter contract for native checkers and browser agents."""
from __future__ import annotations
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
TOOLS = {
    'axe': ('axe-core', 'rule-based'),
    'bagel': ('BAGEL', 'rule-based'),
    'aslint': ('ASLint', 'rule-based'),
    'alfa': ('Alfa', 'rule-based'),
    'ed11y': ('Editoria11y', 'rule-based'),
    'htmlcs': ('HTML_CodeSniffer', 'rule-based'),
    'ibm': ('IBM Equal Access', 'rule-based'),
    'lynx': ('LYNX', 'rule-based'),
    'nuval': ('Nu Html Checker', 'rule-based'),
    'qualweb': ('QualWeb', 'rule-based'),
    'testaro': ('Testaro', 'rule-based'),
    'gena11y': ('GenA11y', 'llm-driven'),
    'accessguru': ('AccessGuru', 'llm-driven'),
    'lopez-pereira': ('López-Gil and Pereira', 'llm-driven'),
    'browser-use': ('Browser Use', 'agentic'),
    'agentlab': ('AgentLab', 'agentic'),
    'ia-rubrics': ('InterA11y (Rubrics only)', 'ablation'),
}
ALIASES = {'nuVal': 'nuval', 'html_codesniffer': 'htmlcs', 'editoria11y': 'ed11y',
           'alfa-rules': 'alfa', 'accessibility-checker': 'ibm'}


def list_tools():
    return [{'id': key, 'name': value[0], 'family': value[1]} for key, value in TOOLS.items()]


def doctor(tool):
    tool = ALIASES.get(tool, tool)
    if tool not in TOOLS:
        raise ValueError('Unknown tool: ' + tool)
    checks = {'python': sys.version_info >= (3, 11), 'node': bool(shutil.which('node'))}
    def module_available(interpreter,name):
        try:
            return subprocess.run([interpreter,'-c',f"import importlib.util;raise SystemExit(importlib.util.find_spec('{name}') is None)"],capture_output=True).returncode==0
        except OSError:
            return False
    if tool in ('gena11y', 'accessguru', 'ia-rubrics'):
        checks.update({name: importlib.util.find_spec(name) is not None for name in ['selenium', 'bs4', 'PIL']})
    if tool == 'browser-use':
        interpreter=os.environ.get('BROWSER_USE_PYTHON',sys.executable)
        checks['browser_use'] = module_available(interpreter,'browser_use')
    if tool == 'agentlab':
        interpreter=os.environ.get('AGENTLAB_PYTHON',sys.executable)
        for name in ['agentlab','browsergym']:
            checks[name]=module_available(interpreter,name)
    if tool == 'lynx':
        checks['java'] = bool(shutil.which('java'))
        checks['maven'] = bool(shutil.which('mvn'))
        checks['external_source'] = (Path(os.environ.get('LYNX_HOME', 'missing-lynx')) / 'pom.xml').is_file()
    if tool == 'ed11y':
        checks['external_source'] = (Path(os.environ.get('EDITORIA11Y_HOME', 'missing-editoria11y')) / 'dist/js/ed11y.umd.min.js').is_file()
    if tool == 'nuval':
        checks['java'] = bool(shutil.which('java'))
    if checks['node']:
        packages = {'axe': ['axe-core'], 'bagel': ['puppeteer'], 'alfa': ['@siteimprove/alfa-rules', '@siteimprove/alfa-puppeteer'],
                    'htmlcs': ['html_codesniffer'], 'ibm': ['accessibility-checker'], 'qualweb': ['@qualweb/core'],
                    'aslint': ['@essentialaccessibility/aslint/package.json'], 'testaro': ['playwright', 'testaro-issues'],
                    'ed11y': ['playwright'], 'nuval': ['vnu-jar', 'playwright'], 'accessguru': ['axe-core']}
        for name in packages.get(tool, []):
            reply = subprocess.run(['node', '-e', 'require.resolve(process.argv[1]);', name], cwd=ROOT, capture_output=True)
            checks[name] = reply.returncode == 0
    return {'tool': tool, 'ready': all(checks.values()), 'checks': checks}


def run(tool, case, options=None):
    tool = ALIASES.get(tool, tool)
    if tool not in TOOLS:
        raise ValueError('Unknown tool: ' + tool)
    options = dict(options or {})
    options.setdefault('output_dir', str(ROOT / 'output' / str(case.get('case_id', 'case')) / tool))
    output = Path(options['output_dir']).resolve()
    output.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    if options.get('api_key'):
        env['OPENROUTER_API_KEY'] = options.pop('api_key')
    request = {'tool': tool, 'case': {key: value for key, value in case.items()
               if key not in {'label', 'truth', 'expected', 'positive', 'prediction'}}, 'options': options}
    with tempfile.TemporaryDirectory(prefix='intera11y-adapter-') as temporary:
        source = Path(temporary) / 'request.json'
        target = Path(temporary) / 'result.json'
        source.write_text(json.dumps(request))
        interpreter = os.environ.get('BROWSER_USE_PYTHON' if tool == 'browser-use' else 'AGENTLAB_PYTHON' if tool == 'agentlab' else 'INTERA11Y_PYTHON', sys.executable)
        process = subprocess.run([interpreter, str(ROOT / 'adapters/worker.py'), str(source), str(target)],
            cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        (output / 'adapter.stdout.log').write_text(process.stdout)
        (output / 'adapter.stderr.log').write_text(process.stderr)
        if not target.exists():
            return {'flagged': False, 'findings': [], 'native_rules': [], 'usage': {}, 'timing': {}, 'state': 'error',
                    'error': process.stderr[-4000:] or 'Adapter exited without a result'}
        return json.loads(target.read_text())
