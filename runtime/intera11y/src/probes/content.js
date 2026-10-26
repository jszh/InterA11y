'use strict';

const png = require('../lib/png.js');
const { contrastRatio } = require('../lib/v3.js');
const { loadLazyContent } = require('../core/session.js');

const STEP_LIMIT = 400;

function inventory(options = {}) {
  const enabled = name => options[name] !== false;
  const targets = options.targetKeys;
  const wanted = el => !targets || targets.some(t => { const x = window.__ia.xpathOf(el).normalize("NFC").replace(/\[1\]/g, "").replace(/\s+/g, " ").trim(); return x === t || x.startsWith(t + "/") || x.startsWith(t + ">>"); });

  const CAP = { links: 5000, texts: 20000, images: 3000 };
  let capped = false;
  const X = window.__ia.xpathOf;
  const vis = (el) => { try { const r = el.getBoundingClientRect(); return el.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && r.width > 0 && r.height > 0; } catch (e) { return false; } };
  const txt = (el) => (el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) }; };

  const deepAll = (sel) => {
    const out = [];
    const walk = (root) => { for (const el of root.querySelectorAll(sel)) out.push(el); for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot); };
    walk(document);
    return out;
  };
  const up = (el) => el.parentElement || (el.parentNode && el.parentNode.host) || null;

  const linkXpath = (a) => {
    const host = a.getRootNode() && a.getRootNode().host;
    if (host && host.tagName.includes('-') && host.shadowRoot.querySelectorAll('a[href],[role="link"]').length === 1) return X(host);
    return X(a);
  };

  const links = [];
  for (const a of enabled('links') ? deepAll('a[href],[role="link"]') : []) {

    if (!vis(a) && !a.getClientRects().length) continue;
    const p = a.closest('p,li,td,th,dd,dt,blockquote,figcaption');
    let context = p ? txt(p) : '';

    let sentence = null;
    if (!p) {
      const blk = a.closest('div,section,article,header,footer,main,aside,nav,form,figure,span,label,body');
      if (blk) {
        const norm = (t) => t.replace(/\s+/g, ' ');
        const before = document.createRange(); before.setStart(blk, 0); before.setEndBefore(a);
        const pre = norm(before.toString()), self = norm(a.textContent || ''), post = norm(blk.textContent || '').slice(pre.length + self.length);
        const start = Math.max(pre.search(/[.!?](?=\s)[^.!?]*$/) + 1, 0);
        const endM = post.search(/[.!?](\s|$)/);
        const s0 = (pre.slice(start) + self + (endM >= 0 ? post.slice(0, endM + 1) : post)).trim();
        let rest = s0;
        for (const l of blk.querySelectorAll('a[href],[role="link"]')) { const lt = norm(l.textContent || '').trim(); if (lt) rest = rest.split(lt).join(' '); }
        if (rest.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length >= 2) sentence = s0.slice(0, 300);
      }
      if (sentence) context = sentence;
    }
    let headers = [];
    const cell = a.closest('td,th');
    if (cell) {
      const row = cell.parentElement, table = cell.closest('table');
      const idx = [...row.children].indexOf(cell);
      const th = table && table.querySelector('thead tr, tr');
      if (th && th.children[idx]?.tagName === 'TH' && th !== row) headers.push(txt(th.children[idx]));
      const rh = row.querySelector('th'); if (rh && rh !== cell) headers.push(txt(rh));
      for (const id of (cell.getAttribute('headers') || '').split(/\s+/).filter(Boolean)) { const h = document.getElementById(id); if (h) headers.push(txt(h)); }
    }
    const described = (a.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean).map((id) => txt(document.getElementById(id))).filter(Boolean);

    let heading = null;
    const all = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')];
    for (const h of all) if (h.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING) heading = h;
    const block = a.closest('p,li,td,dd,div,section,article') || a.parentElement;
    const prevBlock = block && block.previousElementSibling;
    links.push({

      xpath: linkXpath(a), linkXpath: X(a), href: a.href || a.getAttribute('href') || null, text: txt(a).slice(0, 120),
      context: context && context !== txt(a) ? context.slice(0, 300) : null,
      contextKind: p ? p.tagName.toLowerCase() : sentence ? 'sentence' : null,
      tableHeaders: headers.filter(Boolean).slice(0, 3), describedBy: described,
      precedingHeading: heading ? txt(heading).slice(0, 120) : null,
      precedingBlock: prevBlock ? txt(prevBlock).slice(0, 160) : null,
      title: a.getAttribute('title'),
      box: box(a),
    });
    if (links.length >= CAP.links) { capped = true; break; }
  }

  const parse = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c || ''); if (!m) return null; const v = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: v[0], g: v[1], b: v[2], a: v.length > 3 ? v[3] : 1 }; };
  const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
  const texts = [];
  for (const el of enabled('texts') ? deepAll('*') : []) {
    if (!wanted(el)) continue;
    let own = '';
    for (const c of el.childNodes) if (c.nodeType === 3) own += c.textContent;
    own = own.replace(/\s+/g, ' ').trim();
    if (!own || !/[\p{L}\p{N}]/u.test(own) || !vis(el)) continue;
    const cs = getComputedStyle(el);
    if (el.closest('[disabled],[aria-disabled="true"]')) continue;
    let complex = [];
    const layers = [];
    for (let a = el; a; a = up(a)) {
      const s = getComputedStyle(a);
      if (s.backgroundImage && s.backgroundImage !== 'none') complex.push(`background-image on ${a.tagName.toLowerCase()}`);
      if (parseFloat(s.opacity) < 1) complex.push('opacity');
      if (s.filter !== 'none' || s.mixBlendMode !== 'normal') complex.push('filter/blend');
      const bg = parse(s.backgroundColor);
      if (bg && bg.a > 0) { layers.push(bg); if (bg.a >= 1) break; }
    }
    let bg = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg);
    const fg0 = parse(cs.color);
    if (!fg0) continue;
    const fg = over(fg0, bg);
    if (cs.textShadow && cs.textShadow !== 'none') complex.push('text-shadow');
    const size = parseFloat(cs.fontSize), weight = Number(cs.fontWeight) || (cs.fontWeight === 'bold' ? 700 : 400);
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    texts.push({ xpath: X(el), text: own.slice(0, 80), fg: [fg.r, fg.g, fg.b].map(Math.round), bg: [bg.r, bg.g, bg.b].map(Math.round), size, weight, large, complex: [...new Set(complex)], box: box(el) });
    if (texts.length >= CAP.texts) { capped = true; break; }
  }

  const images = [];
  const controlOf = el => {
    for (let p = el; p; p = up(p))
      if (p.matches('a[href],button,input[type="image"],[role="button"],[role="link"],[role="radio"],[role="checkbox"],[role="switch"],[role="tab"],[role="option"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"]')) return p;
    return null;
  };
  const controlFacts = el => {
    if (!el) return null;
    const attributes = {};
    for (const name of ['role', 'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-checked',
      'aria-pressed', 'aria-selected', 'aria-expanded', 'aria-current', 'aria-hidden', 'aria-disabled',
      'aria-valuenow', 'aria-valuetext', 'title'])
      if (el.hasAttribute(name)) attributes[name] = el.getAttribute(name);
    return { xpath: X(el), tag: el.tagName.toLowerCase(), text: txt(el).slice(0, 160), attributes };
  };

  const textStyles = new WeakMap();
  const textStyle = el => {
    if (!textStyles.has(el)) {
      const s = getComputedStyle(el);
      textStyles.set(el, { display: s.display, visibility: s.visibility, contentVisibility: s.contentVisibility });
    }
    return textStyles.get(el);
  };
  const imageContext = subject => {
    const records = [];
    for (let p = up(subject), depth = 0; p && depth < 6; p = up(p), depth++) {
      if (p.matches('body,html,main,nav,footer')) break;
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      const parts = []; let inspected = 0, truncated = false;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (++inspected > 300) { truncated = true; break; }
        const owner = node.parentElement;
        if (!owner || subject.contains(owner) || owner.closest('script,style,[aria-hidden="true"],[hidden],[inert]')) continue;
        const ownStyle = textStyle(owner);
        let hidden = ownStyle.visibility === 'hidden' || ownStyle.visibility === 'collapse';
        for (let a = owner; a; a = up(a)) {
          const style = textStyle(a);
          if (style.display === 'none' || style.contentVisibility === 'hidden' || a.getAttribute('aria-hidden') === 'true' || a.hasAttribute('hidden') || a.hasAttribute('inert')) { hidden = true; break; }
        }
        if (hidden) continue;
        const text = node.nodeValue.replace(/\s+/g, ' ').trim();
        if (text) parts.push(text);
        if (parts.join(' ').length > 320) { truncated = true; break; }
      }
      const text = parts.join(' ').slice(0, 320);
      if (text && !records.some(r => r.text === text)) records.push({ xpath: X(p), tag: p.tagName.toLowerCase(), text, truncated });
      if (records.length >= 2 || p.matches('article,li,p,td,th,figure,figcaption,fieldset,[role="group"],[role="listitem"]')) break;
    }
    return records;
  };

  const unrenderedEmbed = (el) => el.tagName === 'OBJECT' && !!el.getAttribute('data') && el.checkVisibility({ visibilityProperty: true }) && !el.getBoundingClientRect().width && !el.getBoundingClientRect().height;

  const canvasBlank = (el) => {
    try {
      if (!el.width || !el.height || el.width * el.height > 4e6) return null;

      const cr = el.getBoundingClientRect();
      if (cr.left >= innerWidth || cr.right <= 0) return null;
      const ctx = el.getContext('2d');
      if (!ctx) return null;
      const d = ctx.getImageData(0, 0, el.width, el.height).data;
      for (let i = 3; i < d.length; i += 4) if (d[i]) return false;
      return true;
    } catch (e) { return null; }
  };
  const addImg = (el, kind) => {
    if (!wanted(el)) return;
    const r = el.getBoundingClientRect();
    if ((!vis(el) || r.width < 3 || r.height < 3) && !unrenderedEmbed(el)) return;
    const alt = el.hasAttribute('alt') ? el.getAttribute('alt') : null;
    const fig = el.closest('figure');
    const link = controlOf(el);
    const textContext = imageContext(el);
    images.push({
      xpath: X(el), kind, tag: el.tagName.toLowerCase(), alt, role: el.getAttribute('role'),
      ariaHidden: !!el.closest('[aria-hidden="true"]'), presentational: /^(presentation|none)$/.test(el.getAttribute('role') || ''),
      src: (el.currentSrc || el.getAttribute('src') || el.getAttribute('data') || (kind === 'css-background' ? getComputedStyle(el).backgroundImage : '') || '').slice(0, 200),
      title: el.getAttribute('title'), svgTitle: el.tagName.toLowerCase() === 'svg' && el.querySelector('title') ? txt(el.querySelector('title')) : null,
      caption: fig && fig.querySelector('figcaption') ? txt(fig.querySelector('figcaption')).slice(0, 200) : null,
      inControl: controlFacts(link),
      nearbyText: textContext[0]?.text || '', textContext,
      box: box(el),
      blankCanvas: el.tagName === 'CANVAS' ? canvasBlank(el) : undefined,
    });
  };
  for (const el of enabled('images') ? deepAll('img,input[type="image"],[role="img"],object,area,canvas') : []) addImg(el, el.tagName.toLowerCase() === 'input' ? 'image-button' : 'image');
  for (const el of enabled('images') ? deepAll('svg') : []) { if (el.parentElement && el.parentElement.closest('svg')) continue; if (el.getAttribute('role') === 'img' || el.getBoundingClientRect().width >= 16) addImg(el, 'svg'); }

  for (const el of enabled('images') ? deepAll('video,audio') : []) addImg(el, 'media');

  for (const el of enabled('images') ? deepAll('*') : []) {
    if (!wanted(el)) continue;
    const s = getComputedStyle(el);
    if (!/url\(/.test(s.backgroundImage) || txt(el) || el.querySelector('img,svg')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    addImg(el, 'css-background');
    if (images.length >= CAP.images) { capped = true; break; }
  }

  for (const ar of enabled('images') ? document.querySelectorAll('map area[href]') : []) {
    if (!wanted(ar)) continue;
    const mapName = ar.parentElement && ar.parentElement.getAttribute('name');
    const img = mapName ? document.querySelector(`img[usemap="#${CSS.escape(mapName)}"]`) : null;
    if (!img || !vis(img)) continue;
    const b = box(img);
    images.push({ xpath: X(ar), kind: 'image-map-area', tag: 'area', alt: ar.getAttribute('alt'), role: null, ariaHidden: false, presentational: false, src: ar.getAttribute('href'), title: ar.getAttribute('title'), svgTitle: null, caption: null, inControl: null, nearbyText: `shape=${ar.getAttribute('shape') || 'rect'} coords=${ar.getAttribute('coords') || ''}`, box: b });
  }

  const lookalikes = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let t = enabled('lookalikes') ? walker.nextNode() : null; t && lookalikes.length < 20; t = walker.nextNode()) {
    for (const w of t.textContent.split(/\s+/)) {
      if (w.length < 2 || !/\p{Script=Latin}/u.test(w)) continue;
      if (/[\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Armenian}\p{Script=Cherokee}]/u.test(w) && t.parentElement && wanted(t.parentElement) && vis(t.parentElement)) {
        lookalikes.push({ xpath: X(t.parentElement), word: w, codepoints: [...w].map((ch) => 'U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' ') });
        break;
      }
    }
  }
  return { links, texts, images: images.slice(0, CAP.images), lookalikes, docHeight: document.documentElement.scrollHeight, capped };
}

function colours(img, r) {
  const c = png.crop(img, r);
  const counts = new Map();
  for (let i = 0; i < c.data.length; i += 4) { const k = ((c.data[i] >> 3) << 10) | ((c.data[i + 1] >> 3) << 5) | (c.data[i + 2] >> 3); counts.set(k, (counts.get(k) || 0) + 1); }
  let top = 0, n = 0;
  for (const [k, v] of counts) if (v > n) { n = v; top = k; }
  const mode = [((top >> 10) & 31) * 8 + 4, ((top >> 5) & 31) * 8 + 4, (top & 31) * 8 + 4];
  return { mode, dominance: +(n / (c.data.length / 4)).toFixed(2), distinct: counts.size };
}

const empty = () => ({ links: [], texts: [], images: [], lookalikes: [], stepsTaken: 0 });

async function run({ session, deadline, partial, options }) {
  return session.withFreshPage(async (page) => {
    await loadLazyContent(page);
    const inv = await page.evaluate(inventory, options ? options.content : {});
    Object.assign(partial, { links: inv.links, texts: inv.texts, images: inv.images, lookalikes: inv.lookalikes });
    const vp = page.viewport();
    const pixelWork = inv.texts.length || inv.images.length;
    const steps = (!options || !options.flags.relevant || pixelWork) ? Math.min(STEP_LIMIT, Math.ceil(inv.docHeight / vp.height)) : 0;
    const inViewport = b => b && b.w > 0 && b.h > 0 && b.x >= 0 && b.y >= 0 && b.x + b.w <= vp.width && b.y + Math.min(b.h, vp.height) <= vp.height;

    let truncated = ((!options || !options.flags.relevant || pixelWork) && inv.docHeight > STEP_LIMIT * vp.height) || !!inv.capped;

    const measureAt = async (y) => {
      await page.evaluate((yy) => window.scrollTo(0, yy), y);
      await new Promise((r) => setTimeout(r, 150));

      const sy=await page.evaluate(()=>scrollY);
      const near=[...inv.texts.filter(x=>!x.pixels),...inv.images.filter(x=>!x.image)]
        .filter(x=>x.box && x.box.y<sy+vp.height+100 && x.box.y+x.box.h>sy-100);
      const boxes = await page.evaluate(paths => paths.map(xp => {
        const el = window.__ia.resolve(xp);
        if (!el || !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return null;
        const r = el.getBoundingClientRect();
        return { x:r.x, y:r.y, w:r.width, h:r.height };
      }), near.map(x => x.xpath));
      const bounds = new Map(near.map((x,i) => [x,boxes[i]]));
      const padded = (b,pad,maxW,maxH) => {
        const x=Math.max(0,Math.floor(b.x-pad)), y=Math.max(0,Math.floor(b.y-pad));
        return { x,y,w:Math.min(maxW,vp.width-x,Math.ceil(b.x+b.w+pad)-x),
          h:Math.min(maxH,vp.height-y,Math.ceil(b.y+b.h+pad)-y) };
      };
      const img = png.decode(await page.screenshot({ type: 'png', encoding: 'base64', captureBeyondViewport: false }));
      for (const t of inv.texts) {
        const b = bounds.get(t);
        if (t.pixels || !inViewport(b)) continue;
        const c = colours(img, b);
        t.pixels = c;
        const d = Math.hypot(c.mode[0] - t.bg[0], c.mode[1] - t.bg[1], c.mode[2] - t.bg[2]);
        t.renderedBackgroundAgrees = d <= 40;
        t.ratio = +contrastRatio(t.fg, t.bg).toFixed(2);
        t.threshold = t.large ? 3 : 4.5;

        if (t.complex.length || !t.renderedBackgroundAgrees || t.ratio < t.threshold + 0.5) {
          t.image = png.cropBase64(img, padded(b,6,700,240));
        }
      }
      for (const im of inv.images) {
        const b = bounds.get(im);
        if (im.image || !inViewport(b)) continue;
        const crop = padded(b,4,600,420);
        im.image = png.cropBase64(img, crop);
        im.captureBounds = { target:b, crop, partial:b.w+8>crop.w || b.h+8>crop.h };
      }
    };
    for (let i = 0; i < steps; i++) {
      if (deadline.remaining() < 30000) { truncated = true; break; }
      const y = i * vp.height;
      if (options && options.targetKeys && ![...inv.texts, ...inv.images].some(x => x.box.y < y + vp.height && x.box.y + x.box.h > y)) continue;
      await measureAt(y);
    }

    const gaveUp = new Set();
    const pending = () => [...inv.texts.filter((t) => !t.pixels), ...inv.images.filter((im) => !im.image)].filter((x) => !gaveUp.has(x) && x.box && x.box.h > 0 && x.box.x < vp.width && x.box.x + x.box.w > 0 && x.box.y + x.box.h > 0).sort((a, b) => a.box.y - b.box.y);
    for (let left = pending(), guard = 0; left.length && guard < 400; left = pending(), guard++) {
      if (truncated || deadline.remaining() < 30000) { truncated = true; break; }
      const before = left.length;
      await measureAt(Math.max(0, left[0].box.y - 100));

      if (pending().length === before) { left[0].unmeasured = 'not wholly inside the viewport at its own scroll position'; gaveUp.add(left[0]); }
    }
    for (const x of [...inv.texts.filter(t=>!t.pixels), ...inv.images.filter(im=>!im.image)])
      x.unmeasured ||= 'target not fully visible in the measured viewport; no target pixels captured';
    return { completeness: truncated ? 'truncated' : 'complete', links: inv.links, texts: inv.texts, images: inv.images, lookalikes: inv.lookalikes, stepsTaken: steps };
  });
}

module.exports = { run, empty };
