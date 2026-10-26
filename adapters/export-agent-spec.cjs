'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {render,load}=require('../runtime/intera11y/src/judge/rubric.js');
const {toolDeclarations,toolHandlers}=require('../runtime/intera11y/src/lib/v3.js');
const definitions=require('./criterion-definitions.json');

function neutralize(value){
  if(typeof value==='string')return value.replace(/\b(?:WCAG\s*)?SC\s+\d\.\d{1,2}\.\d\b/gi,'the criterion')
    .replace(/\b\d\.\d{1,2}\.\d\b/g,'the criterion').replace(/\bACT\s+[a-f0-9]{6}\b/gi,'the test case');
  if(Array.isArray(value))return value.map(neutralize);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,neutralize(v)]));
  return value;
}
function exportSpec({sc,condition}){
  const variant=condition===2?'v2':'rules';
  const id=condition===2?'interactive-rubric':'ablation-rules-v1';
  const tools=Object.values(toolDeclarations()).filter(d=>toolHandlers[d.name]).map(neutralize).map(d=>({...d,
    description:d.description+' Browser-agent binding: state-preserving tools operate on the current native page and retain its changes; there is no implicit fresh-page reset there. The result echoes measurementContext. Instruments requiring destructive rendering changes require an explicit isolated stateId:new; reuse its returned ID to continue that workflow.'}));
  return {rubrics:{[sc]:{title:load(sc).title,definition:definitions[sc],matched:render(sc,variant,{tools:false}),promptId:id}},
    judgmentPrompt:{id,rubricVariant:variant},tools};
}
if(require.main===module){let text='';process.stdin.on('data',d=>{text+=d;});process.stdin.on('end',()=>{
  try{console.log(JSON.stringify(exportSpec(JSON.parse(text))));}catch(error){console.error(error.stack);process.exitCode=1;}
});}
module.exports={exportSpec};
