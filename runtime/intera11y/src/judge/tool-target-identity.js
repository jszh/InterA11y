'use strict';

const PATH_KEYS = new Set(['targetXpath', 'nodeAXpath', 'nodeBXpath', 'triggerXpath',
  'otherXpath', 'linkXpath', 'iframeXpath', 'xpath', 'toXpath']);
function targetPaths(value, key, paths = new Set()) {
  if (typeof value === 'string' && PATH_KEYS.has(key)) paths.add(value);
  else if (Array.isArray(value)) for (const v of value)
    targetPaths(v, ['linkXpaths', 'iframeXpaths'].includes(key) ? 'xpath' : key, paths);
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) targetPaths(v, k, paths);
  return [...paths];
}

async function readIdentities(page, paths) {
  return page.evaluate(paths => paths.map(xpath => {

    let element;
    if (window.__ia?.resolveAll) {
      const found = window.__ia.resolveAll(xpath);
      if (found.length !== 1) return { xpath, error: `selector matched ${found.length} nodes` };
      element = found[0];
    } else {
      const segments = xpath.split('>>');
      {
        const result = document.evaluate(segments[0], document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        if (result.snapshotLength !== 1) return { xpath, error: `selector matched ${result.snapshotLength} nodes` };
        element = result.snapshotItem(0);
      }
      for (const segment of segments.slice(1)) {
        if (segment.startsWith('frame/')) {
          const doc = element?.contentDocument;
          if (!doc) return { xpath, error: 'frame unavailable' };
          const result = doc.evaluate(segment.slice(5), doc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          if (result.snapshotLength !== 1) return { xpath, error: `frame selector matched ${result.snapshotLength} nodes` };
          element = result.snapshotItem(0);
        } else {
          let current = element?.shadowRoot;
          for (const part of segment.split('/').filter(Boolean)) {
            const match = /^([\w-]+)\[(\d+)\]$/.exec(part);
            if (!match || !current) return { xpath, error: 'unsupported or ambiguous frame/shadow selector' };
            current = [...current.children].filter(x => x.localName === match[1])[Number(match[2]) - 1];
          }
          element = current;
        }
      }
    }
    if (!element || element.nodeType !== 1) return { xpath, error: 'target element not found' };
    const attributes = {};
    for (const key of ['id', 'href', 'type', 'role', 'name', 'aria-label', 'title', 'alt'])
      if (element.hasAttribute(key)) attributes[key] = element.getAttribute(key);

    const semanticAttributes = {};
    for (const key of ['aria-labelledby', 'aria-describedby', 'aria-checked', 'aria-pressed',
      'aria-selected', 'aria-expanded', 'aria-current', 'aria-hidden', 'aria-disabled',
      'aria-valuenow', 'aria-valuetext'])
      if (element.hasAttribute(key)) semanticAttributes[key] = element.getAttribute(key);
    const text = [];
    const visit = node => {
      if (node.nodeType === 1 && ['SCRIPT', 'STYLE'].includes(node.tagName)) return;
      if (node.nodeType === 3) text.push(node.nodeValue);
      for (const child of node.childNodes) visit(child);
    };
    visit(element);
    return { xpath, tag: element.tagName.toLowerCase(), attributes, semanticAttributes,
      text: text.join('').replace(/\s+/g, ' ').trim().slice(0, 240) };
  }), paths);
}

function assertIdentities(expected, actual, stage) {
  for (const target of expected) {
    const found = actual.find(x => x.xpath === target.xpath);
    const same = found && !found.error && found.tag === target.tag && found.text === target.text
      && JSON.stringify(Object.entries(found.attributes).sort()) === JSON.stringify(Object.entries(target.attributes).sort());
    if (!same) {
      const error = new Error(`Tool target identity mismatch on ${stage}: ${target.xpath}. No measurement performed. Reinspect the current element; isolated tools do not reproduce native browser mutations.`);
      error.targetIdentity = { stage, expected: target, actual: found || null };
      throw error;
    }
  }
}

async function guardToolSession(session, paths, nativeTargets) {
  const expected = await readIdentities(session.page, paths);
  const invalid = expected.find(x => x.error);
  if (invalid) throw new Error(`Tool target ${invalid.xpath}: ${invalid.error}. No measurement performed.`);
  if (nativeTargets !== undefined) {
    if (!Array.isArray(nativeTargets) || paths.some(xp => !nativeTargets.some(t => t.xpath === xp)))
      throw new Error('Every tool target requires identity from the current native browser observation.');
    assertIdentities(nativeTargets, expected, 'tool base page');
  }
  return {
    expected,
    session: { ...session, freshPage: async () => {
      const clone = await session.freshPage();
      try { assertIdentities(expected, await readIdentities(clone, paths), 'fresh clone'); }
      catch (error) { await clone.close(); throw error; }
      return clone;
    } },
  };
}

module.exports = { targetPaths, readIdentities, assertIdentities, guardToolSession };
