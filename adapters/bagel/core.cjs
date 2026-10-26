"use strict";
const DEFAULTS = Object.freeze({ minContrast: 3, colorDifference: 10, paletteSize: 2 });
function luminance(rgb) {
  const c = rgb.map((v) => v / 255).map((v) => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a, b) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
function dominantColors(colors, size = 2) {
  if (!colors.length) return [];
  const boxes = [colors];
  function channelRange(box) {
    let channel = 0, range = -1;
    for (let c = 0; c < 3; c++) {
      let min = 255, max = 0;
      for (const pixel of box) {
        min = Math.min(min, pixel[c]);
        max = Math.max(max, pixel[c]);
      }
      if (max - min > range) {
        channel = c;
        range = max - min;
      }
    }
    return { channel, range };
  }
  while (boxes.length < size) {
    const choices = boxes.map((box2, i2) => ({ i: i2, ...channelRange(box2), score: box2.length * channelRange(box2).range })).filter((x) => boxes[x.i].length > 1 && x.range > 0).sort((a, b) => b.score - a.score);
    if (!choices.length) break;
    const { i, channel } = choices[0], box = boxes.splice(i, 1)[0];
    box.sort((a, b) => a[channel] - b[channel]);
    const middle = Math.floor(box.length / 2);
    boxes.push(box.slice(0, middle), box.slice(middle));
  }
  return boxes.map((box) => [0, 1, 2].map((c) => Math.round(box.reduce((sum, p) => sum + p[c], 0) / box.length)));
}
function analyzePixels(before, after, width, height, geometry = {}, settings = {}) {
  const config = { ...DEFAULTS, ...settings }, n = width * height;
  if (before.length !== n * 4 || after.length !== n * 4 || n < 1) throw new Error("RGBA images must have matching, nonempty dimensions");
  const changed = [], adjacent = [];
  let contrastingPixels = 0;
  for (let i = 0; i < n; i++) {
    const k = i * 4, a = before.slice(k, k + 3), b = after.slice(k, k + 3);
    const difference = Math.max(...a.map((v, j) => Math.abs(v - b[j])));
    if (difference >= config.colorDifference) {
      changed.push(b);
      if (contrast(a, b) >= config.minContrast) contrastingPixels++;
    } else adjacent.push(b);
  }
  const foreground = dominantColors(changed, config.paletteSize), background = dominantColors(adjacent, config.paletteSize);
  const pairs = foreground.flatMap((a) => background.map((b) => ({ foreground: a, background: b, contrast: contrast(a, b) })));
  const maxAdjacentContrast = pairs.length ? Math.max(...pairs.map((x) => x.contrast)) : null;
  const elementWidth = geometry.width, elementHeight = geometry.height;
  if (!(elementWidth > 0 && elementHeight > 0)) throw new Error("Positive element width and height are required");
  const minArea1 = geometry.minArea1 ?? 2 * (elementWidth + elementHeight) + 4;
  const minArea2 = geometry.minArea2 ?? 4 * Math.min(elementWidth, elementHeight);
  const predicates = {
    contrastingArea: contrastingPixels > 0,
    minimumArea: contrastingPixels >= minArea1 || contrastingPixels >= minArea2,
    adjacentContrast: maxAdjacentContrast !== null && maxAdjacentContrast >= config.minContrast,
    unobscured: geometry.unobscured !== false
  };
  const reasons = Object.entries(predicates).filter(([, value]) => !value).map(([name]) => name);
  return {
    result: reasons.length ? "FAIL" : "PASS",
    predicates,
    reasons,
    changedPixels: changed.length,
    contrastingPixels,
    minArea1,
    minArea2,
    maxAdjacentContrast,
    foreground,
    background,
    implementation: "paper-based approximation: RGB difference, median cut, geometric area calibration",
    settings: config
  };
}
function canonicalKey(key) {
  const compact = String(key).toUpperCase().replace(/\s+/g, "").replace(/-/g, "+");
  return { ARROWUP: "UP", ARROWDOWN: "DOWN", ARROWLEFT: "LEFT", ARROWRIGHT: "RIGHT", "SHIFT+TAB": "SHIFT+TAB" }[compact] || compact;
}
function evaluateGraph(acquisition) {
  const nodes = acquisition.nodes || [], edges = acquisition.edges || [];
  const findings = [], groups = /* @__PURE__ */ new Map(), nodeById = new Map(nodes.map((node) => [node.xpath || node.id, node]));
  for (const node of nodes) {
    if (node.funcSet === void 0 || node.funcSet === null) continue;
    if (!groups.has(String(node.funcSet))) groups.set(String(node.funcSet), /* @__PURE__ */ new Set());
    groups.get(String(node.funcSet)).add(node.xpath || node.id);
  }
  for (const edge of edges) {
    const key = canonicalKey(edge.key), navigation = edge.navigationAttempt === true || edge.target === "v_ext";
    if (navigation && ["TAB", "SHIFT+TAB", "UP", "DOWN", "LEFT", "RIGHT"].includes(key)) {
      findings.push({
        type: "unintuitive-change-of-context",
        sc: ["3.2.1", "3.2.2"],
        source: edge.source,
        target: edge.target,
        key,
        reason: "A non-activation key attempted navigation away from the page.",
        edge
      });
    }
  }
  for (const [funcSet, members] of groups) {
    for (const direction of ["TAB", "SHIFT+TAB"]) {
      const incoming = edges.filter((edge) => canonicalKey(edge.key) === direction && members.has(edge.target) && !members.has(edge.source) && nodeById.has(edge.source));
      const distinct = [...new Map(incoming.map((edge) => [`${edge.source}\0${edge.target}`, edge])).values()];
      if (distinct.length > 1) findings.push({
        type: "unintuitive-navigation-order",
        sc: ["2.4.3"],
        funcSet,
        direction,
        incoming: distinct,
        reason: "More than one entry edge in the same direction enters this FuncSet."
      });
    }
  }
  const completeGroups = nodes.length > 0 && nodes.every((node) => node.funcSet !== void 0 && node.funcSet !== null);
  const acquisitionComplete = acquisition.complete === true && acquisition.truncated !== true && !(acquisition.errors || []).length && !(acquisition.initialNodeCount > nodes.length);
  function allNodesHaveKeys(keys) {
    return nodes.length > 0 && nodes.every((node) => {
      const attempted = new Set(edges.filter((edge) => edge.source === (node.xpath || node.id)).map((edge) => canonicalKey(edge.key)));
      return keys.every((key) => attempted.has(key));
    });
  }
  const contextKeysComplete = allNodesHaveKeys(["TAB", "SHIFT+TAB", "UP", "DOWN", "LEFT", "RIGHT"]);
  const orderKeysComplete = allNodesHaveKeys(["TAB", "SHIFT+TAB"]);
  const orderStatus = !groups.size ? "BLOCKED_MISSING_FUNCSETS" : !completeGroups ? "PARTIAL_SUPPLIED_FUNCSETS" : !acquisitionComplete ? "PARTIAL_INCOMPLETE_ACQUISITION" : !orderKeysComplete ? "PARTIAL_KEY_COVERAGE" : "EVALUATED_WITH_SUPPLIED_FUNCSETS";
  return {
    findings,
    coverage: {
      changeOfContext: acquisitionComplete && contextKeysComplete ? "EVALUATED" : "PARTIAL",
      navigationOrder: orderStatus
    },
    acquisitionComplete,
    attemptedCoverage: { contextKeysComplete, orderKeysComplete },
    nodeCount: nodes.length,
    edgeCount: edges.length,
    funcSetCount: groups.size
  };
}
module.exports = { DEFAULTS, luminance, contrast, dominantColors, analyzePixels, evaluateGraph, canonicalKey };
