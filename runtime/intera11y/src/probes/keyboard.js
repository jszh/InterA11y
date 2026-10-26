'use strict';

const png = require('../lib/png.js');
const { toV3, fromV3, key } = require('../lib/xpath.js');
const v3 = require('../lib/v3.js');
const { parallel } = require('../core/timing.js');

const PRESS_CAP = 1500;
const CAPTURE_CAP = PRESS_CAP;
const REGION_MARGIN = 48;
const SCRIPT_WAIT_MS = 30;
const NO_TRANSITIONS = '*,*::before,*::after{transition-duration:0s!important;transition-delay:0s!important}';

function readFocus() {
  let a = window.__ia.deepActive();

  let framePrefix = '';
  while (a && a.tagName === 'IFRAME') {
    let inner = null;
    try { inner = a.contentDocument && a.contentDocument.activeElement; } catch (e) { inner = null; }
    if (!inner || inner === a.contentDocument.body || inner === a.contentDocument.documentElement) break;
    framePrefix += window.__ia.xpathOf(a) + '>>frame';
    const X = (e) => { const parts = []; for (let n = e; n && n.nodeType === 1; n = n.parentElement) { let i = 1; for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === n.tagName) i++; parts.unshift(n.tagName.toLowerCase() + '[' + i + ']'); } return '/' + parts.join('/'); };
    const r0 = a.getBoundingClientRect();
    const rr = inner.getBoundingClientRect();
    return { boundary: false, seen: (() => { const seen = window.__iaSeen || (window.__iaSeen = new WeakSet()); const w = seen.has(inner); seen.add(inner); return w; })(),
      xpath: framePrefix + X(inner), tag: inner.tagName.toLowerCase(), segmented: false, inFrame: true,
      viewportRect: { x: r0.left + rr.left, y: r0.top + rr.top, w: rr.width, h: rr.height },
      pageRect: { x: Math.round(r0.left + rr.left + scrollX), y: Math.round(r0.top + rr.top + scrollY), w: Math.round(rr.width), h: Math.round(rr.height) },
      visibleWhenFocused: rr.width > 0 && rr.height > 0, modalOpen: null, insideModal: false, occludedBy: null, style: {}, scroll: { x: scrollX, y: scrollY } };
  }
  if (!a || a === document.body || a === document.documentElement) return { boundary: true };
  const seen = window.__iaSeen || (window.__iaSeen = new WeakSet());
  const wasSeen = seen.has(a); seen.add(a);
  const r = a.getBoundingClientRect();
  const cs = getComputedStyle(a);
  const visible = (typeof a.checkVisibility !== 'function' || a.checkVisibility({ opacityProperty: true, visibilityProperty: true }))
    && r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
  let modal = null;
  for (const m of document.querySelectorAll('dialog[open],[aria-modal="true"]')) {
    const ms = getComputedStyle(m); const mr = m.getBoundingClientRect();
    if (ms.display !== 'none' && ms.visibility !== 'hidden' && mr.width > 0 && mr.height > 0) { modal = m; break; }
  }
  let occludedBy = null;
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  if (cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight) {
    let top = document.elementFromPoint(cx, cy);
    while (top && top.shadowRoot) { const inner = top.shadowRoot.elementFromPoint(cx, cy); if (!inner || inner === top) break; top = inner; }
    if (top && top !== a && !a.contains(top) && !top.contains(a) && !(a.getRootNode().host && a.getRootNode().host.contains(top))) occludedBy = window.__ia.xpathOf(top);
  }
  const style = {};
  for (const p of ['outline-style', 'outline-width', 'outline-color', 'outline-offset', 'box-shadow', 'border-top-color', 'border-bottom-color', 'border-bottom-width', 'background-color', 'color', 'text-decoration-line', 'font-weight']) style[p] = cs.getPropertyValue(p);
  return {
    boundary: false, seen: wasSeen,
    xpath: window.__ia.xpathOf(a), tag: a.tagName.toLowerCase(),
    segmented: a.tagName === 'INPUT' && /^(time|date|datetime-local|month|week)$/.test(a.type || ''),
    viewportRect: { x: r.left, y: r.top, w: r.width, h: r.height },
    pageRect: { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) },
    visibleWhenFocused: visible,
    inFrame: a.tagName === 'IFRAME',
    modalOpen: modal ? window.__ia.xpathOf(modal) : null,
    insideModal: !!(modal && window.__ia.composedContains(modal, a)),
    occludedBy,
    style,
    scroll: { x: scrollX, y: scrollY },
  };
}

function blurActive() {
  const a = window.__ia.deepActive();
  if (a && a !== document.body) a.blur();
}

function focusNextInOrder(xp, backward) {
  const cur = window.__ia.resolve(xp);
  if (!cur) return null;
  const sel = 'a[href],area[href],button,input,select,textarea,iframe,summary,[tabindex],[contenteditable=""],[contenteditable="true"],audio[controls],video[controls]';
  const ok = (e) => e.tabIndex >= 0 && !e.disabled && !e.closest('[inert]') && !(e.tagName === 'INPUT' && e.type === 'hidden')
    && (typeof e.checkVisibility !== 'function' || e.checkVisibility({ visibilityProperty: true }));
  const all = [...document.querySelectorAll(sel)].filter(ok);
  const order = [...all.filter((e) => e.tabIndex > 0).sort((a, b) => a.tabIndex - b.tabIndex), ...all.filter((e) => e.tabIndex === 0)];
  let host = cur; while (host.getRootNode() !== document && host.getRootNode().host) host = host.getRootNode().host;
  let i = order.indexOf(host);
  if (i < 0) {

    const after = order.findIndex((e) => host.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING);
    i = after < 0 ? order.length : after - 0.5;
  }
  const j = backward ? Math.ceil(i) - 1 : Math.floor(i) + 1;
  const next = order[j];
  if (!next) return null;
  next.focus();
  return window.__ia.xpathOf(next);
}

function refocus(xp) {
  const a = window.__ia.resolve(xp);
  if (!a || typeof a.focus !== 'function') return false;

  const frames = [];
  for (let w = a.ownerDocument.defaultView; w && w.frameElement; w = w.parent) frames.unshift(w.frameElement);
  for (const f of frames) f.focus({ preventScroll: true });
  a.focus({ preventScroll: true });
  const inner = a.getRootNode && a.getRootNode().activeElement !== undefined ? a.getRootNode().activeElement : a.ownerDocument.activeElement;
  return inner === a && (!frames.length || document.activeElement === frames[0]);
}

function styleOf(xp) {
  const a = window.__ia.resolve(xp);
  if (!a) return null;
  const cs = getComputedStyle(a);
  const style = {};
  for (const p of ['outline-style', 'outline-width', 'outline-color', 'outline-offset', 'box-shadow', 'border-top-color', 'border-bottom-color', 'border-bottom-width', 'background-color', 'color', 'text-decoration-line', 'font-weight']) style[p] = cs.getPropertyValue(p);
  return { style, scroll: { x: scrollX, y: scrollY } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const grow = (r, m) => ({ x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m });
const union = (a, b) => { if (!b) return a; const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y); return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }; };
const clampToView = (r, vw, vh) => { const x = Math.max(0, r.x), y = Math.max(0, r.y); return { x, y, w: Math.max(1, Math.min(vw, r.x + r.w) - x), h: Math.max(1, Math.min(vh, r.y + r.h) - y) }; };

async function shot(page) {
  const b64 = await page.screenshot({ type: 'png', encoding: 'base64', captureBeyondViewport: false, optimizeForSpeed: true });
  return png.decode(b64);
}

async function shotRegion(page, r, scroll) {
  const b64 = await page.screenshot({ type: 'png', encoding: 'base64', optimizeForSpeed: true, clip: { x: r.x + scroll.x, y: r.y + scroll.y, width: r.w, height: r.h } });
  return png.decode(b64);
}

async function frames(page) {
  await page.evaluate(() => new Promise((r) => { requestAnimationFrame(() => requestAnimationFrame(r)); setTimeout(r, 200); })).catch(() => {});
  await sleep(SCRIPT_WAIT_MS);
}

const roundRect = (r) => { const x = Math.floor(r.x), y = Math.floor(r.y); return { x, y, w: Math.max(1, Math.ceil(r.x + r.w) - x), h: Math.max(1, Math.ceil(r.y + r.h) - y) }; };

async function walk(page, deadline, { backward = false, capture = true, captureWanted = () => true } = {}) {
  await page.mouse.move(1, 1);
  if (capture) await page.addStyleTag({ content: NO_TRANSITIONS }).catch(() => {});
  const stops = [];
  let boundaryAt = -1, boundaryStreak = 0, emptyStreak = 0, wrapped = false, lastXpath = null, segPresses = 0, framePresses = 0, revisit = null;
  const stalls = [];
  const entry = await page.evaluate(readFocus);
  if (!entry.boundary) stops.push({ ...entry, initialFocus: true });
  let captureNext = !entry.boundary;
  const vp = page.viewport();
  for (let press = 0; press < PRESS_CAP; press++) {
    if (deadline.remaining() < 20000) return { stops, wrapped: false, truncated: true, boundaryAt, revisit, stalls };

    if (capture && captureNext && stops.length <= CAPTURE_CAP && captureWanted(stops[stops.length - 1].xpath)) await captureIndicator(page, stops[stops.length - 1], vp);
    captureNext = false;
    if (backward) { await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift'); }
    else await page.keyboard.press('Tab');
    await v3.awaitFocusSettle(page);
    const f = await page.evaluate(readFocus).catch(() => ({ boundary: true, error: true }));
    if (f.boundary) {
      if (stops.length) { if (boundaryAt < 0) boundaryAt = stops.length - 1; if (++boundaryStreak >= 2) { wrapped = true; break; } }
      else if (++emptyStreak >= 5) break;
      continue;
    }

    const afterBoundary = boundaryStreak > 0;
    boundaryStreak = 0;
    if (f.seen) {
      if (f.segmented && f.xpath === lastXpath && segPresses < 10) { segPresses++; continue; }

      if (f.tag === 'iframe' && f.xpath === lastXpath && framePresses < 200) { framePresses++; continue; }

      if (f.xpath === lastXpath && !afterBoundary && f.tag !== 'iframe' && !f.segmented && stalls.length < 200 && !stalls.some((x) => x.xpath === f.xpath)) {
        const nextXp = await page.evaluate(focusNextInOrder, f.xpath, backward).catch(() => null);
        if (nextXp) {
          await v3.awaitFocusSettle(page);
          const g = await page.evaluate(readFocus).catch(() => ({ boundary: true }));
          if (!g.boundary && !g.seen) {
            stalls.push({ xpath: f.xpath, stop: stops.length - 1, continuedAt: nextXp });
            segPresses = 0; framePresses = 0; lastXpath = g.xpath;
            stops.push({ ...g, reachedBy: 'script-after-stall', afterStall: true });
            captureNext = true;
            continue;
          }
        }
      }

      wrapped = true; revisit = { from: lastXpath, to: f.xpath, crossedBoundary: boundaryAt >= 0 }; break;
    }
    segPresses = 0; framePresses = 0; lastXpath = f.xpath;

    stops.push(stalls.length ? { ...f, afterStall: true } : f);
    captureNext = true;
  }
  if (capture && captureNext && stops.length <= CAPTURE_CAP && captureWanted(stops[stops.length - 1].xpath)) await captureIndicator(page, stops[stops.length - 1], vp);

  let ordered = stops;
  if (!entry.boundary && boundaryAt >= 0 && boundaryAt < stops.length - 1) ordered = [...stops.slice(boundaryAt + 1), ...stops.slice(0, boundaryAt + 1)];
  return { stops: ordered.map((s, i) => ({ ...s, index: i })), wrapped, truncated: !wrapped && stops.length > 0 && !emptyStreak, boundaryAt, revisit, stalls };
}

async function captureIndicator(page, stop, vp) {
  try {
    const region = roundRect(clampToView(grow(stop.viewportRect, REGION_MARGIN), vp.width, vp.height));
    const rel = (r) => ({ x: r.x - region.x, y: r.y - region.y, w: r.w, h: r.h });
    await frames(page);
    const focused = await shotRegion(page, region, stop.scroll);
    await page.evaluate(blurActive);
    await frames(page);
    let after = await page.evaluate(styleOf, stop.xpath);

    if (after && (after.scroll.x !== stop.scroll.x || after.scroll.y !== stop.scroll.y)) {
      stop.scrollRestoredAfterBlur = { from: after.scroll, to: stop.scroll };
      await page.evaluate((x, y) => window.scrollTo(x, y), stop.scroll.x, stop.scroll.y);
      await frames(page);
      after = await page.evaluate(styleOf, stop.xpath);
    }

    const comparable = !after || (after.scroll.x === stop.scroll.x && after.scroll.y === stop.scroll.y);
    const unfocused = await shotRegion(page, region, stop.scroll);
    const box = clampToView(grow(stop.viewportRect, 0), vp.width, vp.height);
    const near = clampToView(grow(stop.viewportRect, 12), vp.width, vp.height);
    const inRegion = comparable ? png.diff(focused, unfocused) : null;
    const local = comparable ? png.diffIn(focused, unfocused, rel(near)) : null;

    let whole = null;
    if (inRegion && inRegion.changed === 0) {
      const u = await shot(page);
      stop.refocused = await page.evaluate(refocus, stop.xpath);
      await frames(page);
      let again = await page.evaluate(styleOf, stop.xpath);
      if (again && (again.scroll.x !== stop.scroll.x || again.scroll.y !== stop.scroll.y)) {
        await page.evaluate((x, y) => window.scrollTo(x, y), stop.scroll.x, stop.scroll.y);
        await frames(page);
        again = await page.evaluate(styleOf, stop.xpath);
      }
      const f = await shot(page);
      if (!again || (again.scroll.x === stop.scroll.x && again.scroll.y === stop.scroll.y)) whole = png.diff(f, u);
    } else stop.refocused = await page.evaluate(refocus, stop.xpath);
    const styleDelta = {};
    if (after) for (const [k, v] of Object.entries(stop.style)) if (after.style[k] !== v) styleDelta[k] = { unfocused: after.style[k], focused: v };
    const regionBox = inRegion && inRegion.bbox ? { x: inRegion.bbox.x + region.x, y: inRegion.bbox.y + region.y, w: inRegion.bbox.w, h: inRegion.bbox.h } : null;
    stop.indicator = {
      comparable,
      elementBox: box,
      changedPixelsNear: local ? local.changed : null,
      changedPixelsInRegion: inRegion ? inRegion.changed : null,

      changedPixelsViewport: whole ? whole.changed : null,
      changedBox: whole ? whole.bbox : regionBox,
      meanColourDelta: local ? local.meanDelta : null,
      camouflagedFraction: comparable ? png.camouflage(focused, unfocused, rel(near)) : null,
      perimeter: Math.round(2 * (box.w + box.h)),
      styleDelta,
    };
    const crop = region.w * region.h > 700 * 450 ? rel(roundRect(clampToView(grow(stop.viewportRect, 24), vp.width, vp.height))) : { x: 0, y: 0, w: region.w, h: region.h };
    stop.images = {
      focused: png.cropBase64(focused, crop),
      unfocused: png.cropBase64(unfocused, crop),
      cropBox: { x: crop.x + region.x, y: crop.y + region.y, w: crop.w, h: crop.h },
    };
  } catch (e) {
    stop.indicator = { error: String(e && e.message || e).slice(0, 200) };
  }
}

const MAP_MAX_HEIGHT = 4000;
async function sequenceMap(page, stops, { regional = false } = {}) {
  await page.evaluate((items) => {
    const layer = document.createElement('div');
    layer.id = '__ia_seqmap';
    layer.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';
    for (const s of items) {
      const b = document.createElement('div');
      b.textContent = String(s.n);
      b.style.cssText = `position:absolute;left:${Math.max(0, s.x - 4)}px;top:${Math.max(0, s.y - 4)}px;min-width:16px;height:16px;padding:0 3px;font:bold 11px/16px sans-serif;color:#fff;background:#d00;border:1px solid #fff;border-radius:8px;text-align:center`;
      const box = document.createElement('div');
      box.style.cssText = `position:absolute;left:${s.x}px;top:${s.y}px;width:${s.w}px;height:${s.h}px;outline:2px solid rgba(221,0,0,.7)`;
      layer.appendChild(box); layer.appendChild(b);
    }
    document.body.appendChild(layer);
    if (document.activeElement) document.activeElement.blur();
    window.scrollTo(0, 0);
  }, stops.map((s) => ({ n: s.index, x: s.pageRect.x, y: s.pageRect.y, w: s.pageRect.w, h: s.pageRect.h })));
  const dims = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight }));
  try {
    if (!regional) {
      const img = await page.screenshot({ type: 'png', encoding: 'base64', clip: { x: 0, y: 0, width: Math.min(dims.w, 1280), height: Math.min(dims.h, MAP_MAX_HEIGHT) }, captureBeyondViewport: true });
      return { image: img, coversHeight: Math.min(dims.h, MAP_MAX_HEIGHT), documentHeight: dims.h };
    }

    const bands = new Map();
    for (const s of stops) {
      const y = Math.max(0, Math.floor(s.pageRect.y / 900) * 900);
      if (!bands.has(y)) bands.set(y, { y, score: 0, stops: [] });
      bands.get(y).stops.push(s.index);
    }
    for (let i = 1; i < stops.length; i++) {
      const a = stops[i-1].pageRect, b = stops[i].pageRect;
      if (b.y < a.y - 8 || (Math.abs(a.y-b.y) < Math.max(a.h,b.h) && b.x < a.x)) {
        for (const r of [a,b]) { const band = bands.get(Math.max(0, Math.floor(r.y / 900) * 900)); if (band) band.score += 1; }
      }
    }
    const sorted = [...bands.values()].sort((a,b) => a.y-b.y);
    const selected = new Map();
    for (const b of [sorted[0], sorted[sorted.length-1], ...sorted.slice().sort((a,b) => b.score-a.score || a.y-b.y)]) {
      if (b && selected.size < 8) selected.set(b.y,b);
    }
    const regions = [];
    for (const b of [...selected.values()].sort((a,b) => a.y-b.y)) {
      const y = Math.min(b.y, Math.max(0,dims.h-900));
      const image = await page.screenshot({ type:'png', encoding:'base64', clip:{x:0,y,width:Math.min(dims.w,1280),height:Math.min(900,dims.h-y)}, captureBeyondViewport:true });
      regions.push({ y, height:Math.min(900,dims.h-y), stops:b.stops, image });
    }
    return { regions, documentHeight:dims.h, totalBands:bands.size,
      omittedBands:sorted.filter(b=>!selected.has(b.y)).map(b=>({y:b.y,stops:b.stops})),
      note:'All measured stops remain in sequence facts; images show selected regions, with uncovered regions explicitly listed.' };
  } finally {
    await page.evaluate(() => { const l = document.getElementById('__ia_seqmap'); if (l) l.remove(); });
  }
}

const COMPOSITE = /^(listbox|combobox|grid|treegrid|tree|menu|menubar|tablist|radiogroup|toolbar)$/;

function compositeInfo(xp) {
  const el = window.__ia.resolve(xp);
  if (!el) return null;
  const role = el.getAttribute('role') || (el.tagName === 'SELECT' ? 'listbox' : null);
  let owner = null;
  for (let n = el; n;) {
    if (n.nodeType === 1 && n.matches('[role="listbox"],[role="grid"],[role="treegrid"],[role="tree"],[role="menu"],[role="menubar"],[role="tablist"],[role="radiogroup"],[role="toolbar"],[role="combobox"]')) { owner = n; break; }
    n = n.assignedSlot || n.parentNode || n.host || null;
  }
  const ad = el.getAttribute('aria-activedescendant');
  return { role, ownerRole: owner ? owner.getAttribute('role') : null, owner: owner ? window.__ia.xpathOf(owner) : null, activeDescendant: ad, hasActiveDescendant: el.hasAttribute('aria-activedescendant') };
}

function whereNow(ownerXp) {
  const a = window.__ia.deepActive();
  const owner = ownerXp ? window.__ia.resolve(ownerXp) : null;
  const ad = a && a.getAttribute && a.getAttribute('aria-activedescendant');
  const adEl = ad ? a.getRootNode().getElementById?.(ad) : null;
  return { focus: a && a !== document.body ? window.__ia.xpathOf(a) : null, insideWidget: !!(owner && a && window.__ia.composedContains(owner, a)), activeDescendant: adEl ? window.__ia.xpathOf(adEl) : null, activeDescendantText: adEl ? (adEl.textContent || '').trim().slice(0, 60) : null };
}

async function compositeWalk(session, stops, deadline, out) {
  for (const s of stops) {
    if (deadline.remaining() < 60000 || out.length >= 30) break;
    const info = await session.withFreshPage(async (page) => {
      await page.addStyleTag({ content: NO_TRANSITIONS }).catch(() => {});
      const ok = await page.evaluate((xp) => { const e = window.__ia.resolve(xp); if (!e) return false; e.focus(); return true; }, s.xpath);
      if (!ok) return null;
      const ci = await page.evaluate(compositeInfo, s.xpath);
      const role = ci && (ci.role || ci.ownerRole);
      if (!(ci && (COMPOSITE.test(role || '') || ci.hasActiveDescendant))) return null;
      const keys = /menubar|tablist|toolbar/.test(role) ? ['ArrowRight', 'ArrowRight', 'ArrowLeft'] : ['ArrowDown', 'ArrowDown', 'ArrowUp'];
      const vp = page.viewport();
      const box = await page.evaluate((xp) => { const e = window.__ia.resolve(xp); const r = (e.closest('[role]') || e).getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }, ci.owner || s.xpath);
      const region = clampToView(grow(box, 24), vp.width, vp.height);
      const steps = [];
      const initial = await page.evaluate(whereNow, ci.owner || s.xpath);
      let prev = await shot(page);
      for (const k of keys) {
        await page.keyboard.press(k);
        await frames(page);
        const now = await page.evaluate(whereNow, ci.owner || s.xpath);
        const img = await shot(page);
        const d = png.diffIn(prev, img, region);
        steps.push({ key: k, ...now, changedPixelsInWidget: d ? d.changed : null });
        prev = img;
      }
      return { xpath: s.xpath, role, owner: ci.owner, usesActiveDescendant: ci.hasActiveDescendant, initial, steps, image: png.cropBase64(prev, region) };
    }).catch(() => null);
    if (info) out.push(info);
  }
  return out;
}

const empty = () => ({
  stops: [], wrapped: false, sequenceMap: null, wrapKind: null, revisit: null, stalls: [], backward: null, composites: [], byKey: new Map(),
  traps: { confirmed: [], directional: [], regionsTested: 0, error: 'not run' },
  confinement: [], confinementError: 'not run', retentionTraps: [], retentionError: 'not run', rejections: [], rejectionError: 'not run',
});

const wrapKindOf = (w) => (!w.wrapped ? null : w.revisit && !w.revisit.crossedBoundary ? 'revisit-without-boundary' : 'boundary');
const errorOf = (r) => (r && (r.error || r.skipped)) || null;

async function run({ session, model, deadline, partial, options }) {
  const opts = options ? options.keyboard : {};
  const on = name => opts[name] !== false;

  const phase = (fn) => {
    const ms = deadline.remaining() - 15000;
    if (ms < 15000) return Promise.resolve({ skipped: 'time limit' });
    let timer;
    return Promise.race([
      session.withFreshPage(fn).catch((e) => ({ error: String(e && e.message || e).slice(0, 300) })),
      new Promise((r) => { timer = setTimeout(() => r({ skipped: 'time limit' }), ms); }),
    ]).finally(() => clearTimeout(timer));
  };
  const fix = (x) => fromV3(x);

  const backward = () => phase((p) => walk(p, deadline, { backward: true, capture: false })).then((back) => {
    partial.backward = back.stops ? { stops: back.stops.length, wrapKind: wrapKindOf(back), revisit: back.revisit, sequence: back.stops.map((s) => s.xpath), truncated: back.truncated, stalls: back.stalls || [] } : null;
  });
  const retention = () => phase((p) => v3.detectFocusRetentionTraps(p)).then((r) => {
    partial.retentionTraps = ((r && r.traps) || []).map((t) => ({ ...t, xpath: fix(t.xpath) }));
    partial.retentionError = errorOf(r);
  });
  const rejection = () => phase((p) => v3.detectFocusRejection(p)).then((r) => {
    partial.rejections = ((r && r.rejections) || []).map((x) => ({ ...x, xpath: fix(x.xpath) }));
    partial.rejectionError = errorOf(r);
  });
  const confinement = () => phase((p) => v3.detectFixedSetConfinementTraps(p)).then((r) => {
    partial.confinement = ((r && r.traps) || []).map((t) => ({ ...t, xpath: fix(t.xpath), memberXpaths: (t.memberXpaths || []).map(fix) }));
    partial.confinementError = errorOf(r) || (r && r.undetermined ? 'undetermined' : null);
  });

  let ring;
  const forward = async () => {
    ring = await session.withFreshPage(async (p) => {
      const r = await walk(p, deadline, { capture: on("capture"), captureWanted: options ? options.matches : () => true });
      if (on("sequenceMap") && r.stops.length >= 2) r.sequenceMap = await sequenceMap(p, r.stops, { regional: !!opts.regional }).catch(() => null);
      return r;
    });
    Object.assign(partial, {
      stops: ring.stops, wrapped: ring.wrapped, sequenceMap: ring.sequenceMap || null,

      wrapKind: wrapKindOf(ring), revisit: ring.revisit,

      stalls: ring.stalls || [],
      byKey: new Map(ring.stops.map((s) => [key(s.xpath), s])),
    });

    const traps = () => phase((p) => v3.detectKeyboardTraps(p, { reachableXpaths: ring.stops.map((s) => toV3(s.xpath)) })).then((r) => {
      partial.traps = {
        confirmed: ((r && r.traps) || []).map((t) => ({ ...t, regionXpath: fix(t.regionXpath) })),
        directional: ((r && r.directionalTraps) || []).map((t) => ({ ...t, regionXpath: fix(t.regionXpath) })),
        regionsTested: (r && r.regionCount) || 0,
        error: errorOf(r),
      };
    });

    const compositeRoots = model.elements.filter((e) => e.role && COMPOSITE.test(e.role.split(/\s+/)[0])).map((e) => e.xpath);
    const isComposite = (st) => {
      const e = model.get(st.xpath);
      if (!e) return false;
      return /\saria-activedescendant=/.test(e.openTag) || (e.role && COMPOSITE.test(e.role)) || compositeRoots.some((r) => st.xpath === r || st.xpath.startsWith(r + '/'));
    };
    const seenRoots = new Set();
    const compositeStops = ring.stops.filter(st => !options || options.relates(st.xpath)).filter(isComposite).filter((st) => { const r = compositeRoots.find((x) => st.xpath === x || st.xpath.startsWith(x + '/')) || st.xpath; if (seenRoots.has(r)) return false; seenRoots.add(r); return true; });
    partial.composites = [];
    const composites = () => compositeWalk(session, compositeStops, deadline, partial.composites).catch(() => {});
    await parallel([...(on("traps") ? [traps] : []), ...(on("composites") ? [composites] : [])]);

  };
  await parallel([...(on("backward") ? [backward] : []), ...(on("retention") ? [retention] : []), ...(on("rejection") ? [rejection] : []), ...(on("confinement") ? [confinement] : []), forward]);
  return { ...partial, completeness: ring.truncated ? 'truncated' : 'complete' };
}

module.exports = { run, empty };
