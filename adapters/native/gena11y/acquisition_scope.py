import copy
import json
import re
import unicodedata
REVISION = 'expert-target-acquisition-v1'
GENA11Y_ACQUISITION_REVISION = 'gena11y-pagewide-output-filter-v1'

def gena11y_pagewide_record(record):
    scope = record.get('acquisitionScope')
    return scope is None or scope.get('revision') == GENA11Y_ACQUISITION_REVISION

def key(path):
    return re.sub('\\s+', ' ', unicodedata.normalize('NFC', path or '').replace('[1]', '')).strip()

def within(path, parent):
    path, parent = (key(path), key(parent))
    return bool(path and parent) and (path == parent or path.startswith(parent + '/') or path.startswith(parent + '>>'))

def allows(path, target):
    return bool(target and (target.get('page') or any((within(path, p) for p in target.get('keys', [])))))
ROOTS_JS = "\nconst roots=[], missing=[];\nfor (const original of arguments[0]) {\n  try {\n    let root=document, element=null;\n    for (const step of original.split('>>')) {\n      // Serialized keys omit [1]. Walk indexed local names exactly, including SVG\n      // namespaces; unprefixed document.evaluate cannot resolve SVG elements.\n      let parent=root;\n      element=null;\n      for (const part of step.trim().split('/').filter(Boolean)) {\n        const match=/^([A-Za-z_][\\w:.-]*)(?:\\[(\\d+)\\])?$/.exec(part);\n        if (!match) {element=null;break;}\n        const tag=match[1].split(':').pop().toLowerCase(), ordinal=Number(match[2] || 1);\n        element=Array.from(parent.children || []).filter(e=>e.localName.toLowerCase()===tag)[ordinal-1];\n        if (!element) break;\n        parent=element;\n      }\n      if (!element) break;\n      root=element.shadowRoot || element.contentDocument || element;\n    }\n    if (element) roots.push(element); else missing.push(original);\n  } catch (_) { missing.push(original); }\n}\nreturn {roots,missing};\n"

class TargetDriver:

    def __init__(self, driver, target):
        self.driver = driver
        self.target = target
        found = driver.execute_script(ROOTS_JS, target.get('keys', []))
        self.roots = found['roots']
        self.audit = {'revision': REVISION, 'target': target, 'resolvedRoots': len(self.roots), 'unresolvedKeys': found['missing'], 'queries': [], 'contextPolicy': 'preserve-parent-links-v1'}

    def __getattr__(self, name):
        return getattr(self.driver, name)

    def find_elements(self, by, value):
        if by in ('xpath', 'css selector', 'tag name'):
            result = self.driver.execute_script('\n              const roots=(function(){' + ROOTS_JS + "}).apply(null,[arguments[2]]);\n              let nodes=[];\n              if(arguments[0]==='xpath') {\n                const found=document.evaluate(arguments[1],document,null,XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,null);\n                for(let i=0;i<found.snapshotLength;i++)nodes.push(found.snapshotItem(i));\n              } else if(arguments[0]==='tag name')nodes=Array.from(document.getElementsByTagName(arguments[1]));\n              else nodes=Array.from(document.querySelectorAll(arguments[1]));\n              const parentContext=arguments[0]==='xpath' && arguments[1]==='//a//img/..';\n              return {elements:nodes.filter(e=>roots.roots.some(r=>e===r || r.contains(e) || (parentContext && e.contains(r)))),before:nodes.length,\n                      resolvedRoots:roots.roots.length,missing:roots.missing};\n            ", by, value, self.target.get('keys', []))
            selected = result['elements']
            self.audit['resolvedRoots'] = result['resolvedRoots']
            self.audit['unresolvedKeys'] = result['missing']
            self.audit['queries'].append({'by': by, 'selector': value, 'before': result['before'], 'after': len(selected), 'supportingContext': by == 'xpath' and value == '//a//img/..'})
            return selected
        found = self.driver.find_elements(by, value)
        selected = self.driver.execute_script('return arguments[0].filter(e=>arguments[1].some(r=>e===r || r.contains(e)));', found, self.roots) if found and self.roots else []
        self.audit['queries'].append({'by': by, 'selector': value, 'before': len(found), 'after': len(selected)})
        return selected

def target_context(driver, target, sc=None):
    found = driver.execute_script(ROOTS_JS, target.get('keys', []))
    return driver.execute_script('\n      function path(el) {const parts=[];for(let n=el;n && n.nodeType===1;n=n.parentElement){let i=1;for(let s=n.previousElementSibling;s;s=s.previousElementSibling)if(s.tagName===n.tagName)i++;parts.unshift(n.tagName.toLowerCase()+\'[\'+i+\']\');}return \'/\'+parts.join(\'/\');}\n      function name(el) {const refs=(el.getAttribute(\'aria-labelledby\')||\'\').split(/\\s+/).filter(Boolean).map(id=>el.ownerDocument.getElementById(id)).filter(Boolean);return (refs.length ? refs.map(e=>e.textContent).join(\' \') : el.getAttribute(\'aria-label\') || el.innerText || el.textContent || \'\').replace(/\\s+/g,\' \').trim();}\n      const targets=arguments[0].map(el=>{const r=el.getBoundingClientRect();\n        const refIds=new Set([el,...el.querySelectorAll(\'[aria-labelledby],[aria-describedby]\')].flatMap(e=>[\'aria-labelledby\',\'aria-describedby\'].flatMap(a=>(e.getAttribute(a)||\'\').split(/\\s+/))).filter(Boolean));\n        const referencedNames=Array.from(refIds).map(id=>el.ownerDocument.getElementById(id)).filter(Boolean).map(e=>({xpath:path(e),text:e.textContent}));\n        return {openingTag:\'<\'+el.tagName.toLowerCase()+Array.from(el.attributes).map(a=>\' \'+a.name+\'=\'+JSON.stringify(a.value.length>200 ? a.value.slice(0,200)+\'…\' : a.value)).join(\'\')+\'>\', text:(el.innerText || el.textContent || \'\').slice(0,3000),\n          referencedNames,\n          documentBox:{x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height}};});\n      const links=arguments[1]===\'2.4.4\' ? Array.from(document.querySelectorAll(\'a,[role="link"]\')) : [];\n      const names=new Set(links.filter(e=>arguments[0].some(r=>r===e||r.contains(e))).map(name).filter(Boolean));\n      return {targets,sameNameLinkPeers:links.filter(e=>names.has(name(e))).map(e=>({xpath:path(e),name:name(e),destination:e.getAttribute(\'href\'),html:e.outerHTML}))};\n    ', found['roots'], sc)

def instruction(scopes, context=None):
    if not scopes:
        return ''
    text = 'Evaluation scope (locations only; no ground-truth labels):\n' + json.dumps(scopes, ensure_ascii=False) + '\nFor each SC with page=false, evaluate only the designated element paths and their descendants. Assess every designated target individually. For page=true, evaluate the whole page for that SC. Other markup, peer links, ancestors, and screenshot content are supporting context; do not report them as additional targets. Report an observed failure at its actual XPath. Do not infer a failure merely because an element is designated for evaluation.\n'
    if context:
        text += 'Target HTML/text and document CSS-pixel positions for interpreting visual evidence:\n' + json.dumps(context, ensure_ascii=False) + '\n'
    return text

def scope_evidence(evidence, scopes):
    from bs4 import BeautifulSoup
    result = copy.deepcopy(evidence)
    index = result['nodeIndex']
    candidates = {marker: [sc for sc, t in scopes.items() if allows(node['xpath'], t)] for marker, node in index.items()}
    candidates = {m: scs for m, scs in candidates.items() if scs}
    whole_page = any((t.get('page') for t in scopes.values()))
    selected = [c for c in result['chunks'] if whole_page or any((m in candidates for m in re.findall('data-accessguru-node="([^"]+)"', c)))]
    soup = BeautifulSoup(result['html'], 'html.parser')
    links = soup.find_all(lambda e: e.name == 'a' or e.get('role') == 'link')
    link_scope = scopes.get('2.4.4', {})
    names = {e.get('aria-label') or e.get_text(' ', strip=True) for e in links if not link_scope.get('page') and allows(index.get(e.get('data-accessguru-node'), {}).get('xpath'), link_scope)}
    names.discard('')
    peers = [{'xpath': index[e['data-accessguru-node']]['xpath'], 'html': str(e)} for e in links if e.get('data-accessguru-node') in index and (e.get('aria-label') or e.get_text(' ', strip=True)) in names]
    result['chunks'] = selected
    result['evaluationScope'] = scopes
    referenced, target_ids = (set(), set())
    for e in [] if whole_page else soup.find_all(attrs={'data-accessguru-node': True}):
        if e['data-accessguru-node'] not in candidates:
            continue
        for attr in ('aria-labelledby', 'aria-describedby', 'aria-controls', 'headers'):
            referenced.update(str(e.get(attr, '')).split())
        if e.get('id'):
            target_ids.add(e['id'])
    context_nodes = [e for e in soup.find_all(id=True) if e['id'] in referenced]
    if not whole_page:
        context_nodes += [e for e in soup.find_all('label', attrs={'for': True}) if e['for'] in target_ids]
    result['scopeContext'] = {'sameNameLinkPeers': peers, 'referencedNameAndStateContext': [{'xpath': index.get(e.get('data-accessguru-node'), {}).get('xpath'), 'html': str(e)} for e in context_nodes] if not whole_page else []}
    result['coverage']['acquisitionScope'] = {'revision': REVISION, 'scopes': scopes, 'originalChunks': len(evidence['chunks']), 'selectedChunks': len(selected), 'candidateNodes': len(candidates), 'candidateSCsByNode': candidates, 'supportingPeerLinks': len(peers), 'unresolvedKeys': {sc: [p for p in t.get('keys', []) if not any((within(n['xpath'], p) for n in index.values()))] for sc, t in scopes.items() if not t.get('page')}}
    return result

def scoped_items(items, scopes):
    accepted, excluded = ([], [])
    for original in items:
        item = copy.deepcopy(original)
        item['scs'] = [sc for sc in item.get('scs', []) if sc in scopes and (scopes[sc].get('page') or any((allows(p, scopes[sc]) for p in item.get('xpaths') or [item.get('xpath')])))]
        (accepted if item['scs'] else excluded).append(item)
    return (accepted, excluded)
