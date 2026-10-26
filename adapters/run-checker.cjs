'use strict';
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {fileURLToPath}=require('node:url');
const {spawn}=require('node:child_process');
const {launchBrowser,openSession,loadLazyContent}=require('../runtime/intera11y/src/core/session.js');
const {timed,infrastructure}=require('../runtime/intera11y/src/core/timing.js');
const {CONFIG}=require('../runtime/intera11y/src/core/config.js');

function xpathOf(el){
  if(!el||el.nodeType!==1)return null;
  const parts=[];
  for(let n=el;n&&n.nodeType===1;n=n.parentElement){
    let i=1;for(let p=n.previousElementSibling;p;p=p.previousElementSibling)if(p.localName===n.localName)i++;
    parts.unshift((n.namespaceURI==='http://www.w3.org/1999/xhtml'?n.localName:`*[local-name()='${n.localName}']`)+`[${i}]`);
  }
  return '/'+parts.join('/');
}
async function serve(url){
  if(!url.startsWith('file:'))return {url,close:async()=>{}};
  const file=path.resolve(fileURLToPath(url));
  const root=path.parse(file).root;
  const server=http.createServer((req,res)=>{
    const requested=path.resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname));
    if(!requested.startsWith(root)){res.writeHead(403).end();return;}
    const ext=path.extname(requested).toLowerCase();
    const types={'.html':'text/html','.css':'text/css','.js':'application/javascript','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg'};
    if(types[ext])res.setHeader('content-type',types[ext]);
    const stream=fs.createReadStream(requested);stream.on('error',()=>res.writeHead(404).end());stream.pipe(res);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {url:`http://127.0.0.1:${server.address().port}${file.split(path.sep).map(encodeURIComponent).join('/')}`,
    close:()=>new Promise(resolve=>server.close(resolve))};
}
async function validator(){
  if(process.env.NU_BASE)return null;
  const net=require('node:net');const probe=net.createServer();
  await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const jar=require('vnu-jar');
  const child=spawn('java',['-cp',String(jar),'nu.validator.servlet.Main',String(port)],{stdio:['ignore','ignore','pipe']});
  let error='';child.stderr.on('data',data=>{error+=data;});
  process.env.NU_BASE=`http://127.0.0.1:${port}`;
  const deadline=Date.now()+30000;
  while(Date.now()<deadline){
    if(child.exitCode!==null)throw Error('Nu Html Checker failed: '+error.slice(-1000));
    try{await fetch(process.env.NU_BASE+'/?out=json');return child;}catch{}
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  child.kill();throw Error('Nu Html Checker startup timeout');
}
async function run(input){
  const {tool,case:entry,options={}}=input;
  process.env.CHROME_PATH ||= CONFIG.chromePath || require('puppeteer').executablePath();
  const started=performance.now();
  const service=await serve(entry.url);
  let browser,validatorProcess,checker;
  try{
    if(['testaro','aslint','ed11y','nuval'].includes(tool)){
      const output=path.resolve(options.output_dir||'output');
      fs.mkdirSync(output,{recursive:true});process.env.INTERA11Y_OUTPUT_DIR=output;
      if(tool==='nuval')validatorProcess=await validator();
      checker=require('./checkers/worker.js');
      const nativeTool=tool==='nuval'?'nuVal':tool;
      const now=Date.now();
      const result=await checker.run({tool:nativeTool,case:{id:entry.case_id,corpus:'evaluation',key:entry.case_id,
        scs:[entry.sc],file:entry.url.startsWith('file:')?fileURLToPath(entry.url):entry.page},url:service.url,
        cssURL:service.url,attempt:1,queuedAt:now,dispatchedAt:now});
      const raw=JSON.parse(fs.readFileSync(result.file,'utf8'));
      if(raw.error)throw Error(raw.error);
      return {nativeRows:raw.findings,state:raw.partial?'partial':'complete',timing:raw.timing,raw};
    }
    const five=require('./checkers/native-five.cjs');
    const execution=await timed(async()=>{
      browser=await infrastructure('browser-setup',launchBrowser);
      let session;
      try{
        session=await openSession(browser,tool==='qualweb'?service.url:entry.url);
        await loadLazyContent(session.page);
        const methods={axe:'runAxe',ibm:'runIbm',htmlcs:'runHtmlcs',alfa:'runAlfa',qualweb:'runQualweb'};
        if(!methods[tool])throw Error('Unknown native checker: '+tool);
        if(tool==='qualweb')await infrastructure('qualweb-browser-setup',five.startQw);
        const scan=await timed(()=>five[methods[tool]](session.page,tool==='ibm'?entry.case_id:service.url),
          {kind:'tool',name:tool,recordTree:true});
        return {rows:scan.value,toolTiming:scan.timing};
      }finally{
        await infrastructure('qualweb-browser-teardown',five.closeQw);
        if(session)await session.close();
        await infrastructure('browser-teardown',()=>browser.close());browser=null;
      }
    },{kind:'case',name:'native-checker',recordTree:true});
    return {nativeRows:execution.value.rows,state:'complete',timing:execution.timing,
      toolTiming:execution.value.toolTiming};
  }finally{
    if(browser)await browser.close();if(checker)await checker.close();
    if(validatorProcess)validatorProcess.kill();await service.close();
  }
}
if(require.main===module){
  let text='';process.stdin.on('data',data=>{text+=data;});process.stdin.on('end',async()=>{
    try{console.log(JSON.stringify(await run(JSON.parse(text))));}
    catch(error){console.error(error.stack);process.exitCode=1;}
  });
}
module.exports={run};
