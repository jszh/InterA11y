'use strict';

const { LIVE_SEL, snapBefore, snapAfter, triggerAttrsNow, axOf, guardNavigation, settleMutations, hasEffect } = require('./delta.js');
const { parallel } = require('../core/timing.js');
const { isPerceivableVisually } = require('../model/page-model.js');
const { readRegionFocus } = require('./region-focus.js');

const PARALLEL = 4;
const WIDGET_ROLES = new Set(['button', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'switch', 'checkbox', 'radio', 'option', 'treeitem', 'combobox', 'slider', 'spinbutton', 'link']);
const SPACE_ROLES = new Set(['checkbox', 'switch', 'radio', 'option', 'menuitemcheckbox', 'menuitemradio']);

function controlKind(e) {
  const t = e.openTag || '';
  const native = /^(button|summary|select|input|a)$/.test(e.tag) && !e.role;
  const disclosure = /aria-(expanded|haspopup|controls|pressed)=/.test(t);
  const pointer = !!(e.listeners && /click|mousedown|pointerdown|mouseup|pointerup/.test(e.listeners)) || e.inlineHandlers.some((h) => /click|mousedown/.test(h));
  let kind = null, priority = 9;
  if (disclosure) { kind = 'disclosure'; priority = 0; }
  else if (e.role && WIDGET_ROLES.has(e.role) && e.role !== 'link') { kind = 'widget-role'; priority = 1; }
  else if (!native && pointer) { kind = 'pointer-handler'; priority = 2; }
  else if (e.tag === 'summary') { kind = 'summary'; priority = 1; }
  else if (e.tag === 'button' || (e.tag === 'input' && /^(button|image)$/.test(e.type || ''))) { kind = 'button'; priority = 3; }
  else if (e.tag === 'a' && /href="(#|javascript:)/i.test(t)) { kind = 'in-page-link'; priority = 4; }
  else if (e.role === 'link' && !native) { kind = 'widget-role'; priority = 2; }
  return kind ? { kind, priority, native } : null;
}

function selectControls(model) {
  const out = [];
  for (const e of model.elements) {
    if (!isPerceivableVisually(e) || e.disabled) continue;

    if ((e.tag === 'button' && (e.type === null || e.type === 'submit') && /\/form\[\d+\]/.test(e.xpath)) || (e.tag === 'input' && e.type === 'submit')) continue;
    const k = controlKind(e);
    if (!k) continue;

    out.push({ xpath: e.xpath, tag: e.tag, role: e.role || (e.ax && e.ax.role) || null, ...k });
  }
  out.sort((a, b) => a.priority - b.priority);
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function activateOnce(session, control, mode) {
  return session.withFreshPage(async (page) => {
    const blocked = await guardNavigation(page);
    let focused = null;
    if (mode === 'keyboard') {
      focused = await page.evaluate((xp) => { const el = window.__ia.resolve(xp); if (!el) return false; el.focus({ preventScroll: false }); return window.__ia.deepActive() === el; }, control.xpath);
      if (!focused) return { mode, focusable: false };
    }

    if (mode === 'pointer') await page.evaluate((xp) => { const el = window.__ia.resolve(xp); if (el) el.scrollIntoView({ block: 'center', behavior: 'instant' }); }, control.xpath);
    const attrsBefore = (await page.evaluate(triggerAttrsNow, control.xpath)).attrs;
    const axBefore = await axOf(page, control.xpath);
    const before = await page.evaluate(snapBefore, LIVE_SEL);
    let keyUsed = null, heldOnly = false;
    if (mode === 'keyboard') {
      const keys = SPACE_ROLES.has(control.role) ? ['Space', 'Enter'] : ['Enter', 'Space'];
      for (const k of keys) {
        await page.keyboard.press(k);
        keyUsed = k;
        await settleMutations(page);
        const probe = await page.evaluate(snapAfter, LIVE_SEL, control.xpath);
        const axNow = await axOf(page, control.xpath);
        if (hasEffect(before, probe, attrsBefore, axBefore, axNow, blocked())) break;
        if (k === keys[1]) {

          for (const hk of keys) {
            await page.evaluate((xp) => { const el = window.__ia.resolve(xp); if (el) el.focus(); }, control.xpath);
            await page.keyboard.down(hk); await sleep(2000); await page.keyboard.up(hk);
            await settleMutations(page);
            const held = await page.evaluate(snapAfter, LIVE_SEL, control.xpath);
            const axHeld = await axOf(page, control.xpath);
            if (hasEffect(before, held, attrsBefore, axBefore, axHeld, blocked())) { keyUsed = `${hk} held 2 s`; heldOnly = true; break; }
          }
          break;
        }

        await page.evaluate((xp) => { const el = window.__ia.resolve(xp); if (el) el.focus(); }, control.xpath);
      }
    } else {
      const box = await page.evaluate((xp) => { const el = window.__ia.resolve(xp); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, control.xpath);
      if (!box) return { mode, clickable: false };
      await page.mouse.click(box.x, box.y);
      await settleMutations(page);
    }
    const after = await page.evaluate(snapAfter, LIVE_SEL, control.xpath);
    const axAfter = await axOf(page, control.xpath);
    const nav = blocked();
    const result = {
      mode, key: keyUsed, heldOnly, focusable: focused,
      effect: hasEffect(before, after, attrsBefore, axBefore, axAfter, nav),
      trigger: { attrsBefore, attrsAfter: after.triggerAttrs, axBefore, axAfter, textAfter: after.triggerText },
      revealed: after.revealed, hidden: after.hidden, newText: after.newText, modal: after.modal,
      liveRegionChanges: after.liveRegionChanges, visualChanges: after.visualChanges, timeline: after.timeline,
      focus: { before: before.active, after: after.active, inRevealed: after.focusInRevealed },
      liveRegionsBefore: before.liveRegions,
      navigationBlocked: nav, nativeDialogs: (page.__dialogs || []).slice(),
    };
    if (mode === 'keyboard' && after.revealed.some((r) => r.focusables > 0 || r.modal)) result.revealedKeyboard = await keyboardInRevealed(page, control, after);
    return result;
  });
}

async function keyboardInRevealed(page, control, after) {
  const regions = after.revealed.filter((r) => r.focusables > 0 || r.modal).map((r) => r.xpath);
  const n = Math.min(40, after.revealed.reduce((s, r) => s + r.focusables, 0) + 3);
  const where = () => page.evaluate(readRegionFocus, regions, !!after.modal);
  const start = await where();
  const forward = [];
  for (let i = 0; i < n; i++) { await page.keyboard.press('Tab'); await sleep(40); forward.push(await where()); }
  const backward = [];
  for (let i = 0; i < n; i++) { await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift'); await sleep(40); backward.push(await where()); }

  await page.evaluate((rs) => {
    const FOC = 'a[href],button,input,select,textarea,summary,[tabindex]';
    for (const x of rs) { const r = window.__ia.resolve(x); const f = r && (r.matches(FOC) ? r : r.querySelector(FOC)); if (f) { f.focus(); return; } }
  }, regions);
  await page.keyboard.press('Escape');
  await settleMutations(page, 300, 1500);
  const esc = await page.evaluate((rs, trig) => {
    const vis = (el) => { try { return el.checkVisibility({ visibilityProperty: true, opacityProperty: true }); } catch (e) { return false; } };
    const stillOpen = rs.some((x) => { const r = window.__ia.resolve(x); return r && vis(r); });
    const a = window.__ia.deepActive();
    return { stillOpen, focusAt: a && a !== document.body ? window.__ia.xpathOf(a) : null, focusOnTrigger: !!(a && window.__ia.xpathOf(a) === trig) };
  }, regions, control.xpath);
  return {
    regions, focusAfterActivation: start,
    tabForward: forward, tabForwardLeftRegion: forward.some((w) => !w.inside),
    tabBackward: backward, tabBackwardLeftRegion: backward.some((w) => !w.inside),
    tabForwardEscapedOpenModal: forward.some(w => w.outsideOpenModal),
    tabBackwardEscapedOpenModal: backward.some(w => w.outsideOpenModal),
    modalStateMeasured: !after.modal || [start, ...forward, ...backward].every(w => w.modalOpen !== null),
    escape: esc,
  };
}

const IDLE_MS = 45000;
async function idleWatch(session) {
  return session.withFreshPage(async (page) => {
    const blocked = await guardNavigation(page);
    const before = await page.evaluate(snapBefore, LIVE_SEL);
    await sleep(IDLE_MS);
    const after = await page.evaluate(snapAfter, LIVE_SEL, null);
    return { mode: 'idle', waitedMs: IDLE_MS, effect: !!(after.newText.length || after.revealed.length || after.hidden.length || after.liveRegionChanges.length), revealed: after.revealed, hidden: after.hidden, newText: after.newText, liveRegionChanges: after.liveRegionChanges, visualChanges: after.visualChanges, modal: after.modal, focus: { before: before.active, after: after.active }, liveRegionsBefore: before.liveRegions, navigationBlocked: blocked(), nativeDialogs: (page.__dialogs || []).slice() };
  });
}

const TYPABLE = /^(input|textarea|select)$/;
async function typeInto(session, xpath) {
  return session.withFreshPage(async (page) => {
    const blocked = await guardNavigation(page);
    const kind = await page.evaluate((xp) => { const el = window.__ia.resolve(xp); if (!el) return null; el.focus(); if (window.__ia.deepActive() !== el) return null; return el.tagName === 'SELECT' ? 'select' : /^(checkbox|radio)$/.test(el.type) ? 'toggle' : 'text'; }, xpath);
    if (!kind) return null;
    const before = await page.evaluate(snapBefore, LIVE_SEL);
    if (kind === 'text') await page.keyboard.type('abc 123', { delay: 30 });
    else if (kind === 'toggle') await page.keyboard.press('Space');
    else await page.evaluate((xp) => { const el = window.__ia.resolve(xp); const i = [...el.options].findIndex((o, j) => j !== el.selectedIndex && !o.disabled); if (i >= 0) { el.selectedIndex = i; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); } }, xpath);
    await settleMutations(page);
    await page.keyboard.press('Tab');
    await settleMutations(page);
    const after = await page.evaluate(snapAfter, LIVE_SEL, xpath);
    return { mode: 'typing', xpath, typed: kind === 'text' ? 'abc 123 then Tab' : kind === 'toggle' ? 'Space (toggle) then Tab' : 'choose another option then Tab', effect: !!(after.newText.length || after.liveRegionChanges.length || after.visualChanges.length),
      newText: after.newText, liveRegionChanges: after.liveRegionChanges, visualChanges: after.visualChanges, timeline: after.timeline, revealed: after.revealed, hidden: after.hidden, modal: after.modal,
      focus: { before: before.active, after: after.active }, liveRegionsBefore: before.liveRegions, navigationBlocked: blocked(), nativeDialogs: (page.__dialogs || []).slice() };
  });
}

const empty = () => ({ controls: [], typed: [], idle: null, tested: 0, total: 0 });

async function run({ session, model, deadline, partial, options }) {
  const idle = async () => {
    partial.idle = await idleWatch(session).catch((e) => ({ mode: 'idle', error: String(e && e.message || e).slice(0, 200) }));
  };
  const controls = selectControls(model).filter(c => !options || options.relates(c.xpath));
  const results = partial.controls;
  partial.total = controls.length;
  let i = 0, truncated = false;
  const worker = async () => {
    while (i < controls.length) {
      if (deadline.remaining() < 30000) { truncated = true; return; }
      const c = controls[i++];
      const rec = { ...c };
      try {
        rec.keyboard = await activateOnce(session, c, 'keyboard');
        if ((!rec.keyboard.focusable || !rec.keyboard.effect) && !c.native) rec.pointer = await activateOnce(session, c, 'pointer');
      } catch (e) { rec.error = String(e && e.message || e).slice(0, 200); }
      results.push(rec);
    }
  };
  const typed = partial.typed;
  const controlsAndFields = async () => {
    await parallel(Array.from({ length: PARALLEL }, () => worker));

    const fields = model.elements.filter((e) => TYPABLE.test(e.tag) && isPerceivableVisually(e) && !e.disabled && !/type="(hidden|submit|button|reset|image|file|range|color)"/.test(e.openTag));
    for (const f of fields.filter(f => !options || options.relates(f.xpath))) {
      if (deadline.remaining() < 30000) { truncated = true; break; }
      const r = await typeInto(session, f.xpath).catch(() => null);
      if (r && r.effect) typed.push(r);
    }
  };
  await parallel([...(options && !options.activation.idle ? [] : [idle]), controlsAndFields]);
  return {
    typed,
    completeness: truncated ? 'truncated' : 'complete',
    controls: results,
    idle: partial.idle,
    tested: results.length, total: controls.length,
  };
}

module.exports = { run, empty, selectControls };
