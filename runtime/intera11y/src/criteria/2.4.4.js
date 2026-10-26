'use strict';

const { key } = require('../lib/xpath.js');
const S = require('../screen/select.js');
const { toolsOf } = require('../judge/rubric.js');

module.exports = {
  sc: '2.4.4', title: 'Link Purpose (In Context)',
  probes: ['content', 'activation'],
  tools: toolsOf('2.4.4'),

  screen: { select: S.links },

  applies: (e) => e.rendered && !e.inert && !e.ariaHiddenSelf && !e.ariaHiddenAncestor && !(e.ax && e.ax.ignored)
    && (String(e.ax?.role || e.role || '').toLowerCase() === 'link' || (/^(a|area)$/.test(e.tag) && /\shref\s*=/i.test(e.openTag || ''))),
  applicability: 'Not a link exposed to assistive technology. An a/area without href or a link role is a placeholder, not a link; hidden, inert and ignored links are also outside 2.4.4.',

  identify(model, { content, activation }) {

    const links = (content.links || []).map((l) => ({ ...l, el: model.get(l.linkXpath || l.xpath) }))
      .filter((l) => l.el && module.exports.applies(l.el));

    const linkKeys = new Set(links.flatMap((l) => [key(l.xpath), key(l.linkXpath || l.xpath)]));
    const scripted = [];
    for (const c of (activation && activation.controls) || []) {
      const nav = [...((c.keyboard && c.keyboard.navigationBlocked) || []), ...((c.pointer && c.pointer.navigationBlocked) || [])];
      const el = model.get(c.xpath);
      if (!nav.length || !el || linkKeys.has(key(c.xpath)) || c.native || el.role || /^(a|area|button|input|select|summary|textarea)$/.test(el.tag)) continue;
      scripted.push({ xpath: c.xpath, kind: 'scripted-link', el, destinations: [...new Set(nav)].slice(0, 3), byKeyboard: !!(c.keyboard && c.keyboard.navigationBlocked && c.keyboard.navigationBlocked.length) });
    }

    const byName = new Map();
    for (const l of links) {
      const n = String((l.el.ax && l.el.ax.name) || '').trim().toLowerCase();
      if (!n) continue;
      if (!byName.has(n)) byName.set(n, []);
      byName.get(n).push(l);
    }
    return links.map((l) => {
      const n = String((l.el.ax && l.el.ax.name) || '').trim().toLowerCase();
      const peers = n ? byName.get(n).filter((p) => p !== l) : [];
      return { xpath: l.xpath, kind: 'link', l, peers: peers.map((p) => ({ path: p.xpath, href: p.href, context: p.context })) };
    }).concat(scripted);
  },

  assess(c) {

    if (c.kind === 'scripted-link') return { status: 'OPEN', rule: 'scripted-link-purpose' };
    const ax = c.l.el.ax || {};
    const name = String(ax.name || '').trim();
    if (!name) return { status: 'FAIL', rule: 'no-link-text', reason: 'The link has an empty accessible name, so its purpose cannot be determined at all (ACT c487ae).' };
    return { status: 'OPEN', rule: 'purpose-to-judge' };
  },

  evidence(c) {
    if (c.kind === 'scripted-link') {
      const ax = c.el.ax || {};
      return { facts: { actsAsLink: 'activating this element navigates, but it is not exposed as a link', computedRole: ax.role, accessibleName: ax.name, visibleText: c.el.text, destinations: c.destinations, navigatesFromKeyboard: c.byKeyboard } };
    }
    const l = c.l, ax = l.el.ax || {};
    return {

      element: l.el,
      facts: {
        measuredLinkXpath: l.linkXpath || l.el.xpath || c.xpath,
        accessibleName: ax.name, nameFrom: ax.nameFrom, visibleText: l.text, href: l.href,
        programmaticContext: { sameSentenceOrParagraphOrListItemOrCell: l.context, contextElement: l.contextKind, tableHeaders: l.tableHeaders.length ? l.tableHeaders : undefined, describedBy: l.describedBy.length ? l.describedBy : undefined },
        nearbyButNotProgrammaticallyRelated: { precedingHeading: l.precedingHeading, precedingBlock: l.precedingBlock },
        title: l.title || undefined,
        otherLinksWithTheSameName: c.peers.length ? c.peers.slice(0, 8) : undefined,
      },
    };
  },
};
