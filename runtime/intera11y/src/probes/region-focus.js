'use strict';

function readRegionFocus(paths, modalExpected) {
  const api = window.__ia;
  const visible = el => !!el && (!el.checkVisibility || el.checkVisibility({ visibilityProperty: true, opacityProperty: true }))
    && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
  const contains = (a, b) => api.composedContains(a, b);
  const regions = paths.map(x => api.resolve(x)).filter(Boolean);
  const modals = new Set();
  for (const region of regions) {
    for (let n = region; n;) {
      if (n.nodeType === 1 && n.matches('dialog,[aria-modal="true"]')) modals.add(n);
      n = n.assignedSlot || n.parentNode || n.host || null;
    }
    for (const m of region.querySelectorAll('dialog,[aria-modal="true"]')) modals.add(m);
  }
  const openModals = [...modals].filter(m => visible(m) && (m.tagName !== 'DIALOG' || m.open));
  let active = api.deepActive();
  while (active?.tagName === 'IFRAME') {
    let doc; try { doc = active.contentDocument; } catch (_) { break; }
    if (!doc?.activeElement || doc.activeElement === doc.body || doc.activeElement === doc.documentElement) break;
    active = doc.activeElement;
    while (active.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  }
  const boundary = !active || active === document.body || active === document.documentElement;
  const modalOpen = modalExpected ? (modals.size ? openModals.length > 0 : null) : false;
  const insideModal = !boundary && openModals.some(m => contains(m, active));
  return { at: boundary ? null : api.xpathOf(active), boundary,
    inside: !boundary && regions.some(r => contains(r, active)),
    modalOpen, insideModal,
    outsideOpenModal: modalOpen === true && !boundary && !insideModal };
}
module.exports = { readRegionFocus };
