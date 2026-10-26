'use strict';

const { key } = require('../lib/xpath.js');

const PAGE = '/html[1]';

function expectedTabbable(model) {
  return model.elements.filter((e) => e.rendered && !e.inert && !e.disabled
    && (e.tabindex !== null ? e.tabindex >= 0 : e.nativeFocusable));
}

function stopByKey(kb) {
  const m = new Map();

  const back = new Set(((kb && kb.backward && kb.backward.sequence) || []).map(key));
  for (const s of (kb && kb.stops) || []) if (!s.afterStall || back.has(key(s.xpath))) m.set(key(s.xpath), s);
  return m;
}

function stopFacts(s) {
  if (!s) return null;
  const i = s.indicator || {};
  return {
    tabIndex: s.index,
    ...(s.reachedBy ? { reachedBy: s.reachedBy } : {}),
    ...(s.afterStall ? { afterTabStall: 'reached only after the walk continued past an element on which Tab left focus in place' } : {}),
    visibleWhenFocused: s.visibleWhenFocused,
    occludedBy: s.occludedBy,
    modalOpen: s.modalOpen, insideModal: s.insideModal,
    indicator: i.error ? { error: i.error } : {
      comparable: i.comparable,
      changedPixelsNearElement: i.changedPixelsNear,
      changedPixelsInViewport: i.changedPixelsViewport,
      elementPerimeterPx: i.perimeter,
      meanColourDeltaNear: i.meanColourDelta,
      fractionOfChangeMatchingAdjacentExistingColour: i.camouflagedFraction,
      changedRegion: i.changedBox,
      elementBox: i.elementBox,
      computedStyleChangesOnFocus: i.styleDelta,
    },
  };
}

function stopImages(s) {
  if (!s || !s.images) return [];
  return [
    { label: 'focused (after Tab), crop around the element', data: s.images.focused },
    { label: 'same crop with focus removed', data: s.images.unfocused },
  ];
}

function labelOf(model, xpath) {
  const e = model.get(xpath);
  if (!e) return '';
  return ((e.ax && e.ax.name) || e.text || '').slice(0, 60);
}

module.exports = { PAGE, expectedTabbable, stopByKey, stopFacts, stopImages, labelOf };
