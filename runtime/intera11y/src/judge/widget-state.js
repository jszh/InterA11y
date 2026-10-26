'use strict';

const ATTRS=['aria-checked','aria-expanded','aria-pressed','aria-selected','aria-valuenow','aria-valuetext','aria-disabled','aria-label'];
async function snapshot(page,paths){
 const dom=await page.evaluate((paths,attrs)=>paths.map(path=>{
  const el=window.__ia.resolve(path);if(!el)return {path,resolved:false};
  return {path,resolved:true,tag:el.tagName.toLowerCase(),attributes:Object.fromEntries(attrs.map(a=>[a,el.getAttribute(a)])),
    classAttribute:el.getAttribute('class'), text:(el.textContent||'').slice(0,300),
    native:Object.fromEntries(['checked','selected','value','open','disabled'].filter(k=>k in el && ['string','number','boolean'].includes(typeof el[k])).map(k=>[k,el[k]]))};
 }),paths,ATTRS);
 const cdp=await page.createCDPSession();
 try{
  await cdp.send('Accessibility.enable');
  for(const row of dom){if(!row.resolved)continue;
   let objectId;
   try{
    const obj=await cdp.send('Runtime.evaluate',{expression:`window.__ia.resolve(${JSON.stringify(row.path)})`,returnByValue:false});
    objectId=obj.result.objectId;if(!objectId)continue;
    const {node}=await cdp.send('DOM.describeNode',{objectId});
    const {nodes}=await cdp.send('Accessibility.getPartialAXTree',{backendNodeId:node.backendNodeId,fetchRelatives:false});
    const ax=nodes.find(n=>n.backendDOMNodeId===node.backendNodeId)||nodes[0];
    row.computed={role:ax?.role?.value,name:ax?.name?.value,ignored:ax?.ignored,
      states:Object.fromEntries((ax?.properties||[]).filter(p=>['checked','expanded','pressed','selected','disabled','value','valuemin','valuemax','valuetext'].includes(p.name)).map(p=>[p.name,p.value?.value]))};
   }catch(e){row.computedUnavailable=String(e.message);}
   finally{if(objectId)await cdp.send('Runtime.releaseObject',{objectId}).catch(()=>{});}
  }
 }finally{await cdp.detach().catch(()=>{});}
 return dom;
}
async function watch(page,paths){
 await page.evaluate((paths,attrs)=>{
  window.__iaWidgetStateController?.abort();
  window.__iaWidgetStateController=new AbortController();
  const targets=new Map(paths.map(path=>[window.__ia.resolve(path),path]).filter(([el])=>el));
  const log={ariaChanges:[],nativeEvents:[],truncated:false};window.__iaWidgetStateLog=log;
  window.__iaWidgetStateObserver=new MutationObserver(records=>{
   records.forEach((m,i)=>{
    if(!targets.has(m.target)||!attrs.includes(m.attributeName))return;
    if(log.ariaChanges.length>=128){log.truncated=true;return;}
    const next=records.slice(i+1).find(n=>n.target===m.target&&n.attributeName===m.attributeName);
    log.ariaChanges.push({path:targets.get(m.target),attribute:m.attributeName,before:m.oldValue,
      after:next?next.oldValue:m.target.getAttribute(m.attributeName)});
   });
  });
  for (const root of new Set([document,...[...targets.keys()].map(el=>el.getRootNode())]))
    window.__iaWidgetStateObserver.observe(root,{subtree:true,attributes:true,attributeOldValue:true,attributeFilter:attrs});
  for(const el of targets.keys())for(const type of ['input','change'])el.addEventListener(type,()=>{
   if(log.nativeEvents.length>=128){log.truncated=true;return;}
   log.nativeEvents.push({path:targets.get(el),event:type,classAttribute:el.getAttribute('class'), text:(el.textContent||'').slice(0,300),
    native:Object.fromEntries(['checked','selected','value','open'].filter(k=>k in el).map(k=>[k,el[k]]))});
  },{signal:window.__iaWidgetStateController.signal});
 },paths,ATTRS);
}
async function trackedClone(session,paths,evidence){
 const live=await session.freshPage();
 try{evidence.before=await snapshot(live,paths);await watch(live,paths);}
 catch(e){evidence.beforeUnavailable=String(e.message);}
 const close=live.close.bind(live);
 live.close=async()=>{
  try{evidence.after=await snapshot(live,paths);Object.assign(evidence,await live.evaluate(()=>{
    window.__iaWidgetStateObserver?.disconnect();window.__iaWidgetStateController?.abort();return window.__iaWidgetStateLog||{};
  }));}catch(e){evidence.afterUnavailable=String(e.message);}
  finally{return close();}
 };
 return live;
}
module.exports={snapshot,trackedClone};
