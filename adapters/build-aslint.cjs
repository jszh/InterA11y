'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {build}=require('esbuild');
const root=path.dirname(require.resolve('@essentialaccessibility/aslint/package.json'));
async function main(){
  const target=path.join(root,'dist/aslint.bundle.js');
  fs.mkdirSync(path.dirname(target),{recursive:true});
  const language=JSON.parse(fs.readFileSync(path.join(root,'app/translations/en-us.json'),'utf8'));
  const translations=Object.fromEntries(Object.entries(language).map(([key,value])=>[key,key==='_config'?value:value.value]));
  const translationDir=path.join(root,'dist/translations');fs.mkdirSync(translationDir,{recursive:true});
  fs.writeFileSync(path.join(translationDir,'en-us.json'),JSON.stringify(translations));
  await build({entryPoints:[path.join(root,'app/index.ts')],outfile:target,bundle:true,
    platform:'browser',format:'iife',target:'es2018',alias:{polyfills:path.join(root,'app/polyfills.ts')},
    loader:{'.html':'text'},legalComments:'eof'});
  console.log(target);
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={main};
