'use strict';

const { toolHandlers, toolDeclarations } = require('../lib/v3.js');
const { timed } = require('../core/timing.js');
const { workflowStates } = require('./tool-state-session.js');
const widgetState = require('./widget-state.js');
const { targetPaths, guardToolSession } = require('./tool-target-identity.js');

let DECLS = null;
function declarationsFor(names) {
  DECLS = DECLS || toolDeclarations();
  return names.filter((n) => DECLS[n] && toolHandlers[n]).map((n) => n === 'interact_and_observe' ? { ...DECLS[n], description: DECLS[n].description + ' Optional stateId:new creates a retained isolated workflow; reuse the returned stateId to continue it, inspect it, or split longer sequences into bounded calls. Without stateId, mutations use a fresh page. Every press action requires key explicitly (e.g. Tab, Shift+Tab, Space). A text field is not a key; malformed requests execute no actions. stateSnapshots records before/after DOM and computed widget states plus authored state transitions on the SAME clone.' } : DECLS[n]);
}

function normalizeToolArgs(name, args) {
  if (name !== 'interact_and_observe') return args;
  if (!Array.isArray(args?.actions)) throw new Error('actions[] required');
  return { ...args, actions: args.actions.map((a, i) => {
    if (a?.op !== 'press') return a;
    if (typeof a.key !== 'string' || !a.key.length || (a.key !== ' ' && !a.key.trim()))
      throw new Error(`actions[${i}]: press requires an explicit key; text is not a key. No actions executed.`);
    return { ...a, key: a.key === ' ' ? 'Space' : a.key.trim() };
  }) };
}

async function safeHiResCrop(session, args) {
  if (typeof args?.targetXpath !== 'string' || !args.targetXpath) return {error:'targetXpath required'};
  const live=await session.freshPage();
  const originalViewport=live.viewport();
  try {
    const vp=live.viewport(),scale=Math.max(1,Math.min(Number(args.scale)||3,4));
    await live.setViewport({...vp,deviceScaleFactor:scale});
    await live.evaluate(xp=>window.__ia.resolve(xp)?.scrollIntoView({block:'center',inline:'center',behavior:'instant'}),args.targetXpath);
    await new Promise(r=>setTimeout(r,150));
    const box=await live.evaluate(xp=>{
      const el=window.__ia.resolve(xp);
      if (!el || !el.checkVisibility({visibilityProperty:true,opacityProperty:true})) return null;
      const r=el.getBoundingClientRect();
      return {x:r.x,y:r.y,w:r.width,h:r.height,scrollX,scrollY};
    },args.targetXpath);
    if (!box || box.w<=0 || box.h<=0) return {error:'target not found or zero-size'};
    if (box.x<0 || box.y<0 || box.x+box.w>vp.width || box.y+box.h>vp.height)
      return {error:'target not fully visible after scrolling; no target pixels captured',targetBounds:box};
    const clip={x:box.x+box.scrollX,y:box.y+box.scrollY,width:box.w,height:box.h};
    const screenshot=await live.screenshot({type:'png',encoding:'base64',clip,captureBeyondViewport:false});
    return {screenshot,scaleUsed:scale,cssPixelSize:{w:box.w,h:box.h},
      devicePixelSize:{w:Math.round(box.w*scale),h:Math.round(box.h*scale)},targetBounds:box,
      note:'Higher device-scale raster of the target at its current resolved bounds. No substitute pixels.'};
  } finally {if(originalViewport)await live.setViewport(originalViewport).catch(()=>{});await live.close();}
}

function bindTools(session, names) {
  const declarations = declarationsFor(names || []);
  const allowed = new Set(declarations.map((d) => d.name));
  const states = workflowStates(session);
  return {
    declarations,
    close: () => states.close(),
    async call(name, args, nativeTargets) {
      if (!allowed.has(name)) return { error: `unknown tool ${name}` };
      try { args = normalizeToolArgs(name, args); } catch (e) { return { error:e.message }; }
      let selected = session, stateId;
      if (args?.stateId) {
        try { const state = await states.acquire(args.stateId); selected = state.session; stateId = state.id; }
        catch (e) { return {error:e.message}; }
      }
      if (name === 'resolve_destination' && args?.targetXpath) {
        const placeholder = await selected.page.evaluate(xp => {
          const e = window.__ia.resolve(xp);
          return !!(e && /^(A|AREA)$/.test(e.tagName) && !e.hasAttribute('href'));
        }, args.targetXpath);
        if (placeholder) return { error: 'The target has no href: it is a placeholder, not a destination. No navigation performed.' };
      }
      return (await timed(async () => {
        let guarded;
        try { guarded = await guardToolSession(selected, targetPaths(args), nativeTargets); }
        catch (e) { return { error: e.message, targetIdentity: e.targetIdentity || null }; }
        const activeSession = guarded.session;
        const ctx = { freshClone: () => activeSession.freshPage() };
        if (name === 'request_hi_res_crop') return { ...(await safeHiResCrop(activeSession,args)), resolvedTargets: guarded.expected, ...(stateId ? {stateId} : {}) };
        const paths=[...new Set(name==='interact_and_observe' ? args.actions.map(a=>a?.xpath).filter(Boolean) : name==='observe_state_after_activation' ? [args.targetXpath].filter(Boolean) : [])];
        const stateSnapshots={};
        const context=paths.length ? {freshClone:()=>widgetState.trackedClone(activeSession,paths,stateSnapshots)} : ctx;
        let result;
        try { result=await toolHandlers[name](activeSession.page,args,context); }
        catch (e) { return { error:e.message, targetIdentity:e.targetIdentity || null }; }
        result.resolvedTargets=guarded.expected;
        if (stateId) result.stateId=stateId;
        if (paths.length && !result?.error) result.stateSnapshots=stateSnapshots;
        if (name==='query_ax_node' && args.targetXpath && result?.resolved)
          result.widgetState=(await widgetState.snapshot(activeSession.page,[args.targetXpath]))[0];
        return result;
      }, { kind: 'tool', name, accept: (r) => !(r && r.error) })).value;
    },
  };
}

module.exports = { bindTools, declarationsFor, normalizeToolArgs };
