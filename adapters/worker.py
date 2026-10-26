"""Isolated native adapter execution."""
from __future__ import annotations
import asyncio
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
NATIVE = ROOT / 'adapters/native'
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(NATIVE))


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def node(script, request):
    process = subprocess.run(['node', str(ROOT / script)], input=json.dumps(request),
        text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=ROOT)
    if process.returncode:
        raise RuntimeError(process.stderr[-4000:])
    return json.loads(process.stdout.strip().splitlines()[-1])


def within(path, target):
    def key(value):
        if not value:return None
        value=re.sub(r'\[1\](?=/|$|>>)', '', value.strip())
        value=re.sub(r'\*\[local-name\(\)=[\'\"]([^\'\"]+)[\'\"]\]',r'\1',value)
        return value
    path,target=key(path),key(target)
    return bool(path and target and (path == target or path.startswith(target + '/') or path.startswith(target + '>>')))


def normalized(entry, rows, *, state='complete', usage=None, timing=None, raw=None):
    findings=[]
    for row in rows:
        scs=row.get('sc') or row.get('scs') or []
        scs=[scs] if isinstance(scs,str) else scs
        if row.get('outcome', 'violation') not in ['violation', 'failed', 'FAIL']:
            continue
        for sc in scs:
            if sc != entry['sc']:
                continue
            findings.append({**row,'sc':sc,'xpath':row.get('xpath'),
                'reason':row.get('reason') or row.get('message') or row.get('ruleId') or ''})
    target = entry.get('xpath')
    page_scope = entry.get('scope') == 'page' or not target
    matched = [f for f in findings if page_scope or within(f.get('xpath'), target)]
    flagged = bool(matched)
    native_rules = sorted({f['ruleId'] for f in matched if f.get('ruleId')})
    return {'flagged':flagged,'findings':matched,'native_rules':native_rules,
        'usage':usage or {},'timing':timing or {},'state':state,'raw':raw}


def run_gena11y(entry, options, rubrics=False):
    sys.path.insert(0,str(NATIVE/'gena11y'))
    import a11y_detector as detector
    import extract_elements as extraction
    from consts import COVERED_SCS
    from openrouter_transport import install
    from openrouter_usage import summarize_ledger
    from temp_isolation import ThreadLocalTempFolders
    install(detector, options['model'], options.get('effort','high'))
    detector.configure(model=options['model'],llm_concurrency=options.get('split_concurrency',8),
        effort=options.get('effort','high'),stance='neutral' if rubrics else 'original',
        rules='intera11y' if rubrics else 'gena11y')
    detector.set_context(entry['sc'],entry['url'])
    out=Path(options['output_dir'])
    ledger=detector.timing_ledger();ledger.path=out/'calls.jsonl'
    trace=(out/'model-responses.jsonl').open('a')
    detector.TRACE_SINK=lambda row: (trace.write(json.dumps(row)+'\n'),trace.flush())
    if not rubrics and entry['sc'] not in COVERED_SCS:
        return normalized(entry,[],state='unsupported',raw={'reason':'No original GenA11y extractor for this criterion.'})
    driver=None
    with tempfile.TemporaryDirectory(prefix='gena11y-evidence-') as temporary:
        extraction.TEMP_FILE_FOLDER=ThreadLocalTempFolders(temporary)
        try:
            driver=extraction.make_driver(entry['url'],timing=ledger)
            with ledger.span('tool','gena11y-extraction'):
                if rubrics:
                    from shared_evidence import extract_bundle,judge_bundle
                    detector._INTERA11Y_RULES=json.loads((ROOT/'runtime/intera11y/rules.json').read_text())
                    data=extraction.TEMP_FILE_FOLDER.run('shared-',lambda:extract_bundle(driver,extraction.extract_for_sc,ledger))
                else:
                    data=extraction.TEMP_FILE_FOLDER.run('criterion-',lambda:extraction.extract_for_sc(driver,entry['sc']))
            (out/'extracted-evidence.json').write_text(json.dumps(data))
            with ledger.span('infra','browser-teardown'):driver.quit()
            driver=None
            result=judge_bundle(entry['sc'],data,detector) if rubrics else detector.detect_for_sc(entry['sc'],data)
        finally:
            if driver is not None:
                with ledger.span('infra','browser-teardown'):driver.quit()
            trace.close()
    if result.get('verdict')=='NO VERDICT':
        raise RuntimeError(result.get('summary') or 'No model verdict')
    rows=[{**v,'sc':entry['sc']} for v in result.get('violations',[])]
    answer=normalized(entry,rows,usage=summarize_ledger(ledger.records),timing=ledger.summary(),raw=result)
    if entry.get('scope')=='page' and result.get('verdict') in ['REPRODUCED','PARTIAL']:
        answer['flagged']=True
    return answer


def run_accessguru(entry, options):
    sys.path.insert(0,str(NATIVE/'gena11y'))
    sys.path.insert(0,str(NATIVE/'accessguru'))
    import a11y_detector as detector
    from extract_elements import make_driver
    from openrouter_transport import install
    from openrouter_usage import summarize_ledger
    os.environ['AXE_JS_PATH']=subprocess.check_output(['node','-e',"process.stdout.write(require.resolve('axe-core/axe.min.js'))"],cwd=ROOT,text=True)
    import detector as accessguru
    install(detector,options['model'],options.get('effort','high'))
    detector.set_context(entry['sc'],entry['url']);ledger=detector.timing_ledger()
    ledger.path=Path(options['output_dir'])/'calls.jsonl'
    driver=None
    try:
        driver=make_driver(entry['url'],timing=ledger)
        with ledger.span('tool','accessguru-screenshot'):
            width=driver.execute_script('return document.documentElement.scrollWidth') or 1280
            height=driver.execute_script('return document.documentElement.scrollHeight') or 1024
            driver.set_window_size(min(max(width,1280),2000),min(max(height,1024),6000))
            time.sleep(0.2)
            screenshot=driver.get_screenshot_as_base64()
        with ledger.span('tool','accessguru-html'):
            evidence=accessguru.capture_semantic_evidence(driver)
        with ledger.span('tool','accessguru-axe'):
            accessguru.run_axe(driver,strict=True)
            axe=accessguru.run_axe_nodes(driver,strict=True)
        with ledger.span('infra','browser-teardown'):driver.quit()
        driver=None
        result=accessguru.detect_semantic(urlparse(entry['url']).hostname or 'accessibility test page',entry['url'],evidence,screenshot)
        rows=[{'sc':list(accessguru.axe_scs([r['id']])),'xpath':r['xpath'],'ruleId':r['id']} for r in axe]
        rows.extend({**r,'sc':r.get('scs',[]),'reason':r.get('name','')} for r in result['items'] if r.get('isViolation') is not False)
        return normalized(entry,rows,usage=summarize_ledger(ledger.records),timing=ledger.summary(),raw=result)
    finally:
        if driver is not None:
            with ledger.span('infra','browser-teardown'):driver.quit()


def run_lopez(entry,options):
    from intera11y_benchmark.providers import OpenRouterClient
    from openrouter_usage import normalize_response
    templates=json.loads((ROOT/'adapters/lopez/templates.json').read_text())
    if entry['sc'] not in templates:
        return normalized(entry,[],state='unsupported',raw={'reason':'No published Query 110 template for this criterion.'})
    from urllib.request import urlopen
    html=urlopen(entry['url'],timeout=90).read().decode('utf-8')
    prompt=templates[entry['sc']].replace('{{HTML_CODE}}',html)
    started=time.monotonic()
    response=OpenRouterClient(model=options['model'],max_retries=0).chat([{'role':'user','content':prompt}],
        model=options['model'],reasoning={'effort':options.get('effort','high')},usage={'include':True})
    usage=normalize_response(response)
    raw=response['choices'][0]['message'].get('content') or ''
    if response['choices'][0].get('finish_reason')!='stop':raise ValueError('Incomplete provider response')
    blocks=re.findall(r'<result\s*>(.*?)</result>',raw,re.S|re.I)
    if not blocks:raise ValueError('Missing XML result block')
    votes={}
    for name in ['passed','failed','inapplicable']:
        values=re.findall(r'<'+name+r'>\s*(true|false)\s*</'+name+'>',blocks[-1],re.I)
        if len(values)!=1:raise ValueError('Missing or ambiguous XML boolean: '+name)
        votes[name]=values[0].lower()=='true'
    if sum(votes.values())!=1:raise ValueError('XML requires exactly one true verdict')
    if not re.search(r'<RESPONSE_COMPLETE>\s*TRUE\s*</RESPONSE_COMPLETE>',raw,re.I):
        raise ValueError('Missing published completion marker')
    return {'flagged':votes['failed'],'findings':[],'usage':usage,'timing':{'llmMs':(time.monotonic()-started)*1000},
        'state':'complete','raw':{'response':raw,'prompt':prompt,'votes':votes}}


def run_agents(tool, entry,options):
    if '/' not in options.get('model',''):raise ValueError('Explicit OpenRouter model ID required')
    condition=2 if options.get('condition') in [2,'2','intera11y-tools'] else 1
    target={'page':entry.get('scope')=='page','keys':[entry['xpath']] if entry.get('xpath') else [],'paths':[entry['xpath']] if entry.get('xpath') else []}
    os.environ['A11Y_EXPERT_TARGET_POLICY']='annotated-target-guided-v1'
    from urllib.parse import unquote
    os.environ['INTERA11Y_ALLOWED_PAGES']=str(Path(unquote(urlparse(entry['url']).path)).parent
        if entry['url'].startswith('file:') else ROOT/'datasets')
    chrome=options.get('chrome') or os.environ.get('CHROME_PATH')
    if not chrome:
        chrome=subprocess.check_output(['node','-e',"const {CONFIG}=require('./runtime/intera11y/src/core/config.js');process.stdout.write(CONFIG.chromePath||require('puppeteer').executablePath())"],cwd=ROOT,text=True)
    os.environ['A11Y_NATIVE_CHROME_PATH']=chrome
    spec=node('adapters/export-agent-spec.cjs',{'sc':entry['sc'],'condition':condition})
    out=Path(options['output_dir']);out.mkdir(parents=True,exist_ok=True)
    if tool=='browser-use':
        native=load('browser_use_native',NATIVE/'browser_use_native.py')
        task={'id':entry['case_id'],'url':entry['url'],'expected':None,'meta':{},'targets':{entry['sc']:target}}
        opts=SimpleNamespace(condition=condition,disable_javascript=True,model=options['model'],effort=options.get('effort','high'),
            execution_protocol={'maxTurns':options.get('max_steps',100),'agentJavascriptExecution':False},
            retry_errors=False,chrome=chrome,max_steps=options.get('max_steps',100),timeout=options.get('timeout'))
        result=asyncio.run(native.run_unit(task,entry['sc'],spec,opts,out))
    else:
        native=load('agentlab_native',NATIVE/'agentlab_native.py')
        from comparison_prompt import task_prompt,prompt_record,prompt_id
        prompt=task_prompt(entry['sc'],spec['rubrics'][entry['sc']],target,condition)
        task={'id':entry['case_id'],'sc':entry['sc'],'url':entry['url'],'meta':{},'targets':target,'prompt':prompt,
            'tools':spec['tools'] if condition==2 else [],'judgmentPrompt':prompt_record(prompt,prompt_id(spec,condition)),
            'executionProtocol':{'memoryPolicy':native.MEMORY_POLICY,'maxTurns':options.get('max_steps',100)}}
        task_file=out/'task.json';task_file.write_text(json.dumps(task))
        result=native.run_worker(task_file,out,options['model'],options.get('effort','high'),options.get('max_steps',100),chrome,condition)
    if result.get('error'):raise RuntimeError(result['error'])
    rows=[{**r,'sc':entry['sc']} for r in (result.get('assessment') or {}).get('findings',[])]
    answer=normalized(entry,rows,usage=result.get('usageAllAttempts') or result.get('usage'),timing=result.get('timing'),raw=result)
    if target['page']:answer['flagged']=result.get('verdict')=='FAIL'
    return answer


def run_research(tool,entry,options):
    supported='2.4.7' if tool=='bagel' else '2.4.3'
    if entry['sc']!=supported:
        return normalized(entry,[],state='unsupported',raw={'reason':'This implementation supports SC '+supported+'.'})
    out=Path(options['output_dir']);out.mkdir(parents=True,exist_ok=True)
    if tool=='bagel':
        command=['node',str(ROOT/'adapters/bagel/run.cjs'),'--url='+entry['url'],'--output='+str(out),
            '--keys=','--width=1920','--height=1080','--progress','--timeout='+str(options.get('browser_timeout',120000))]
        if os.environ.get('CHROME_PATH'):command+=['--chrome='+os.environ['CHROME_PATH']]
        process=subprocess.run(command,cwd=ROOT,capture_output=True,text=True)
        (out/'progress.jsonl').write_text(process.stderr)
        if process.returncode:raise RuntimeError(process.stderr[-4000:])
        raw=json.loads((out/'report.json').read_text())
        rows=[{'sc':'2.4.7','xpath':f['xpath'],'reason':', '.join(f.get('reasons',[])),
               'ruleId':reason} for f in raw['focus'] if f['result']=='FAIL' for reason in f.get('reasons',[])]
        return normalized(entry,rows,state='complete' if raw['acquisitionComplete'] else 'partial',
            timing={'totalMs':raw['elapsedMs']},raw=raw)
    source=os.environ.get('LYNX_HOME')
    if not source:raise RuntimeError('Set LYNX_HOME to the pinned NavigationDetection checkout.')
    command=[sys.executable,str(ROOT/'adapters/lynx/run.py'),'--source',source,'--url',entry['url'],
        '--output',str(out),'--max-tabs',str(options.get('max_tabs',2000)),'--timeout',str(options.get('timeout',14400) or 14400)]
    if os.environ.get('CHROME_PATH'):command+=['--chrome-binary',os.environ['CHROME_PATH']]
    if os.environ.get('LYNX_CLASSPATH_FILE'):command+=['--classpath-file',os.environ['LYNX_CLASSPATH_FILE']]
    process=subprocess.run(command,cwd=ROOT,capture_output=True,text=True)
    if process.returncode:raise RuntimeError(process.stderr[-4000:])
    raw=json.loads((out/'result.json').read_text());acquisition=json.loads((out/'acquisition.json').read_text())
    counts={}
    text=(out/'run.log').read_text()
    names={'Skip':'Skip','Re-enter':'ReEnter','Opposite':'Opposite','LeftChoice':'LeftChoice','VerticalAscent':'VerticalAscent','Top':'Top'}
    for label,name in names.items():
        values=re.findall(r'^'+re.escape(label)+r' edges: (\d+)\s*$',text,re.M)
        if len(values)==1:counts[name]=int(values[0])
    rows=[{**f,'sc':'2.4.3','xpath':f.get('xpath') or f.get('source')} for f in raw['findings']]
    phase_timing={name+'Ms':raw[key]*1000 for name,key in [('acquisition','acquisitionSeconds'),
        ('contextTree','contextTreeSeconds'),('detection','detectionSeconds'),('total','totalSeconds')]
        if isinstance(raw.get(key),(int,float))}
    phase_timing['basis']='raw-phase-elapsed'
    answer=normalized(entry,rows,state='complete' if acquisition.get('complete') else 'partial',
        timing=phase_timing,raw=raw)
    if entry['sc']=='2.4.3' and (entry.get('scope')=='page' or not entry.get('xpath')):
        answer['flagged']=raw['flagged']
        answer['native_rules']=sorted(name for name,count in counts.items() if count)
    return answer


def main(request):
    tool,entry,options=request['tool'],request['case'],request['options']
    os.environ['A11Y_HTTP_MAX_ATTEMPTS']='1'
    os.environ['A11Y_ANSWER_MAX_ATTEMPTS']='1'
    if tool in ['gena11y','ia-rubrics']:return run_gena11y(entry,options,rubrics=tool=='ia-rubrics')
    if tool=='accessguru':return run_accessguru(entry,options)
    if tool=='lopez-pereira':return run_lopez(entry,options)
    if tool in ['browser-use','agentlab']:return run_agents(tool,entry,options)
    if tool in ['bagel','lynx']:return run_research(tool,entry,options)
    reply=node('adapters/run-checker.cjs',request)
    return normalized(entry,reply['nativeRows'],state=reply['state'],timing=reply.get('timing'),raw=reply)


if __name__=='__main__':
    request=json.loads(Path(sys.argv[1]).read_text())
    try:result=main(request)
    except Exception as error:
        import traceback
        traceback.print_exc()
        result={'flagged':False,'findings':[],'native_rules':[],'usage':{},'timing':{},'state':'error','error':str(error)}
    Path(sys.argv[2]).write_text(json.dumps(result))
