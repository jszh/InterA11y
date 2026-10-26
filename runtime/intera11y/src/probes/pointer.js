'use strict';

const { LIVE_SEL, snapBefore, snapAfter, guardNavigation, settleMutations } = require('./delta.js');
const { isReachableVisually } = require('../model/page-model.js');
const { parallel } = require('../core/timing.js');

const PARALLEL = 4;
const DWELL_MS = 6000;

function hoverTriggers() {
  const out = new Set();
  const visit = (rules) => {
    for (const r of rules) {
      if (r.cssRules && !r.selectorText) { try { visit(r.cssRules); } catch (e) {              } continue; }
      const sel = r.selectorText;
      if (!sel || sel.indexOf(':hover') < 0) continue;
      for (const part of sel.split(',')) {
        const i = part.indexOf(':hover');
        if (i < 0) continue;
        const head = part.slice(0, i).trim();
        const rest = part.slice(i + 6).trim();

        if (!rest || !/^[\s>+~]/.test(part.slice(i + 6))) continue;
        const style = r.style;
        if (!style || !/(display|visibility|opacity|transform|max-height|height|clip|left|top)/.test(style.cssText)) continue;
        try { for (const el of document.querySelectorAll(head || '*')) out.add(el); } catch (e) {                               }
      }
    }
  };
  for (const sh of document.styleSheets) { try { visit(sh.cssRules); } catch (e) {                    } }
  return [...out].slice(0, 400).map((el) => window.__ia.xpathOf(el));
}

function selectTriggers(model, cssTriggers) {
  const byX = new Map();

  const add = (xpath, why) => { const e = model.get(xpath); if (!e || !isReachableVisually(e)) return; if (!byX.has(xpath)) byX.set(xpath, { xpath, why: [] }); byX.get(xpath).why.push(why); };
  for (const x of cssTriggers) add(x, 'css-hover-rule');
  for (const e of model.elements) {
    if (e.listeners && /mouseover|mouseenter|pointerenter/.test(e.listeners)) add(e.xpath, 'hover-handler');
    if (/aria-describedby=|aria-haspopup=/.test(e.openTag)) add(e.xpath, 'popup-relationship');
    if (e.inlineHandlers.includes('onmouseover')) add(e.xpath, 'hover-handler');
  }

  return [...byX.values()].sort((a, b) => b.why.length - a.why.length);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function centre(page, xpath) {
  return page.evaluate((xp) => {
    const el = window.__ia.resolve(xp);
    if (!el) return null;
    const inView = (r) => r.top >= 0 && r.left >= 0 && r.top + r.height / 2 < innerHeight && r.left + r.width / 2 < innerWidth;
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    let r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    if (!inView(r)) {
      window.scrollTo({ top: scrollY + r.top - innerHeight / 2 + r.height / 2, left: scrollX, behavior: 'instant' });
      r = el.getBoundingClientRect();
    }
    if (!inView(r)) return { outOfView: true, box: { x: r.left, y: r.top, w: r.width, h: r.height } };
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, box: { x: r.left, y: r.top, w: r.width, h: r.height } };
  }, xpath);
}

function revealedState(xps) {
  return xps.map((xp) => {
    const el = window.__ia.resolve(xp);
    if (!el) return { xpath: xp, visible: false };
    let vis = false;
    try { vis = el.checkVisibility({ visibilityProperty: true, opacityProperty: true }); } catch (e) { vis = false; }
    const r = el.getBoundingClientRect();
    return { xpath: xp, visible: vis && r.width > 0 && r.height > 0, box: { x: r.left, y: r.top, w: r.width, h: r.height } };
  });
}

function overlapsOtherContent(xp) {
  const el = window.__ia.resolve(xp);
  if (!el) return null;
  const R = el.getBoundingClientRect();
  const hit = (q) => Math.min(R.right, q.right) - Math.max(R.left, q.left) > 2 && Math.min(R.bottom, q.bottom) - Math.max(R.top, q.top) > 2;
  const covered = [];
  const push = (node, what) => { if (covered.length < 6 && !covered.some((c) => c.xpath === window.__ia.xpathOf(node))) covered.push({ xpath: window.__ia.xpathOf(node), what }); };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t && covered.length < 6; t = walker.nextNode()) {
    const host = t.parentElement;
    if (!host || el.contains(host) || host.contains(el) || !t.textContent.trim() || host.closest('[aria-hidden="true"]')) continue;
    const range = document.createRange(); range.selectNodeContents(t);
    for (const q of range.getClientRects()) if (hit(q)) { push(host, 'text: ' + t.textContent.trim().slice(0, 50)); break; }
  }
  for (const g of document.querySelectorAll('img,svg,canvas,video,input,select,textarea,button,a[href],[role="img"]')) {
    if (el.contains(g) || g.contains(el) || g.closest('[aria-hidden="true"]') || (g.tagName === 'IMG' && g.getAttribute('alt') === '')) continue;
    if (g.parentElement && g.parentElement.closest('svg')) continue;
    if (hit(g.getBoundingClientRect())) push(g, g.tagName.toLowerCase());
  }
  return covered;
}

async function hoverReveal(page, trig) {
  await page.mouse.move(2, 2);
  const c = await centre(page, trig.xpath);
  if (!c) return null;
  if (c.outOfView) return { c, outOfView: true, after: null, revealed: [] };
  await page.evaluate(snapBefore, LIVE_SEL);
  await page.mouse.move(c.x, c.y, { steps: 4 });
  await settleMutations(page, 250, 1500);
  const after = await page.evaluate(snapAfter, LIVE_SEL, trig.xpath);
  return { c, after, revealed: after.revealed };
}

async function testTrigger(session, trig) {
  const rec = { xpath: trig.xpath, why: trig.why };

  await session.withFreshPage(async (page) => {
    await guardNavigation(page);
    const h = await hoverReveal(page, trig);
    if (!h) { rec.hoverable = null; rec.error = 'trigger has no box'; return; }
    if (h.outOfView) { rec.error = 'the trigger could not be scrolled into the viewport, so it was not hovered'; return; }
    rec.revealedOnHover = h.revealed.map((r) => ({ xpath: r.xpath, text: r.text.slice(0, 160), focusables: r.focusables }));
    rec.newTextOnHover = h.after.newText.slice(0, 10).map((t) => ({ xpath: t.xpath, text: t.text.slice(0, 120) }));
    if (!h.revealed.length) return;
    const xps = h.revealed.map((r) => r.xpath);
    rec.covers = await page.evaluate(overlapsOtherContent, xps[0]);
    await sleep(DWELL_MS);
    rec.persistsAfterDwell = (await page.evaluate(revealedState, xps)).map((s) => s.visible);

    const st = (await page.evaluate(revealedState, xps)).find((s) => s.visible);
    if (st) {
      const inset = (lo, len, v) => Math.min(Math.max(v, lo + Math.min(6, len / 2)), lo + len - Math.min(6, len / 2));
      const tx = Math.min(Math.max(inset(st.box.x, st.box.w, h.c.x), 1), 1279), ty = Math.min(Math.max(inset(st.box.y, st.box.h, h.c.y), 1), 899);
      await page.mouse.move(tx, ty, { steps: 20 });
      await settleMutations(page, 250, 1200);
      rec.stillVisibleWithPointerOnContent = (await page.evaluate(revealedState, xps)).map((s) => s.visible);
      rec.pointerTravel = { from: { x: Math.round(h.c.x), y: Math.round(h.c.y) }, to: { x: Math.round(tx), y: Math.round(ty) }, target: st.xpath };

      rec.targetStillVisibleWithPointerOnIt = rec.stillVisibleWithPointerOnContent[xps.indexOf(st.xpath)];
    }
  });
  if (!rec.revealedOnHover || !rec.revealedOnHover.length) return rec;
  const xps = rec.revealedOnHover.map((r) => r.xpath);

  await session.withFreshPage(async (page) => {
    await guardNavigation(page);
    const h = await hoverReveal(page, trig);
    if (!h || !h.revealed.length) { rec.dismissible = null; return; }
    await page.keyboard.press('Escape');
    await settleMutations(page, 250, 1200);
    rec.visibleAfterEscape = (await page.evaluate(revealedState, xps)).map((s) => s.visible);
  });

  await session.withFreshPage(async (page) => {
    await guardNavigation(page);
    const ok = await page.evaluate((xp) => { const el = window.__ia.resolve(xp); if (!el || typeof el.focus !== 'function') return false; el.focus(); return window.__ia.deepActive() === el; }, trig.xpath);
    rec.triggerFocusable = ok;
    if (!ok) return;
    await settleMutations(page, 250, 1200);
    rec.visibleOnFocus = (await page.evaluate(revealedState, xps)).map((s) => s.visible);
    await page.keyboard.press('Escape');
    await settleMutations(page, 250, 1200);
    rec.visibleOnFocusAfterEscape = (await page.evaluate(revealedState, xps)).map((s) => s.visible);
  });
  return rec;
}

const empty = () => ({ triggers: [], tested: 0, total: 0 });

async function run({ session, model, deadline, partial }) {
  const css = await session.page.evaluate(hoverTriggers).catch(() => []);
  const triggers = selectTriggers(model, css);
  const results = partial.triggers;
  partial.total = triggers.length;
  let i = 0, truncated = false;
  const worker = async () => {
    while (i < triggers.length) {
      if (deadline.remaining() < 30000) { truncated = true; return; }
      const t = triggers[i++];
      try { results.push(await testTrigger(session, t)); } catch (e) { results.push({ xpath: t.xpath, why: t.why, error: String(e && e.message || e).slice(0, 200) }); }
    }
  };
  await parallel(Array.from({ length: PARALLEL }, () => worker));
  return { completeness: truncated ? 'truncated' : 'complete', triggers: results, tested: results.length, total: triggers.length };
}

module.exports = { run, empty };
