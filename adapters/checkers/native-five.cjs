"use strict";
const fs = require("fs");
const path = require("path");
const { timed, queuedCallback } = require("../../runtime/intera11y/src/core/timing.js");
const INSTRUMENT = false;
const {CONFIG}=require('../../runtime/intera11y/src/core/config.js');
const AXE = require.resolve("axe-core/axe.min.js");
const HTMLCS = require.resolve("html_codesniffer/build/HTMLCS.js");
const scFromAxeTags = (tags) => [...new Set((tags || []).map((t) => {
  const m = /^wcag(\d)(\d)(\d+)$/.exec(t);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}).filter(Boolean))];
const scFromHtmlcsCode = (code) => {
  const m = /Guideline\d_\d\.(\d+)_(\d+)_(\d+)/.exec(code || "");
  return m ? [`${m[1]}.${m[2]}.${m[3]}`] : [];
};
const scFromQualweb = (sc) => (sc || []).map((s) => s.name).filter(Boolean);
const xpathViaEvaluate = (page, xps) => page.evaluate((list) => list.map((xp) => {
  try {
    const el = document.evaluate(xp, document, null, 9, null).singleNodeValue;
    return el && el.nodeType === 1 ? window.__ia.xpathOf(el) : null;
  } catch (e) {
    return null;
  }
}), xps);
async function runAxe(page) {
  await page.addScriptTag({ path: AXE });
  return page.evaluate(async () => {
    const r = await window.axe.run(document, { resultTypes: ["violations", "incomplete"], elementRef: true });
    const out = [];
    for (const [kind, list] of [["violation", r.violations], ["review", r.incomplete]]) for (const v of list || []) for (const n of v.nodes || []) {
      out.push({ ruleId: v.id, tags: v.tags, outcome: kind, xpath: n.element && n.element.nodeType === 1 ? window.__ia.xpathOf(n.element) : null });
    }
    return out;
  }).then((rows) => rows.map((x) => ({ ruleId: x.ruleId, sc: scFromAxeTags(x.tags), outcome: x.outcome, xpath: x.xpath })));
}
async function runHtmlcs(page) {
  await page.evaluate((source) => {
    const keys = ["define", "module", "exports"];
    const previous = keys.map((key) => ({ key, own: Object.prototype.hasOwnProperty.call(window, key), value: window[key] }));
    try {
      for (const key of keys) window[key] = void 0;
      (0, eval)(source);
    } finally {
      for (const entry of previous) if (entry.own) window[entry.key] = entry.value;
      else delete window[entry.key];
    }
    if (typeof window.HTMLCS?.process !== "function") throw Error("HTML_CodeSniffer bundle did not export its browser API");
  }, fs.readFileSync(HTMLCS, "utf8"));
  const msgs = await page.evaluate(() => new Promise((resolve) => {
    window.HTMLCS.process("WCAG2AA", window.document, () => {
      resolve(window.HTMLCS.getMessages().map((m) => ({ code: m.code, type: m.type, xpath: m.element && m.element.nodeType === 1 ? window.__ia.xpathOf(m.element) : null })));
    });
  }));
  return msgs.map((m) => ({ ruleId: (m.code || "").split(".").pop(), code: m.code, sc: scFromHtmlcsCode(m.code), outcome: { 1: "violation", 2: "review", 3: "review" }[m.type] || "review", xpath: m.xpath }));
}
let IBM_RULE2SC = null;
async function runIbm(page, label) {
  const checker = require("accessibility-checker");
  if (!IBM_RULE2SC) {
    IBM_RULE2SC = {};
    const sets = await checker.getRulesets();
    const rs = sets.find((r) => /IBM_Accessibility/i.test(r.id)) || sets[0];
    for (const cp of rs && rs.checkpoints || []) {
      const m = String(cp.num || "").match(/^\d\.\d+\.\d+/);
      if (m) for (const ru of cp.rules || []) (IBM_RULE2SC[ru.id] = IBM_RULE2SC[ru.id] || []).push(m[0]);
    }
  }
  const res = await checker.getCompliance(page, label);
  const items = (res && res.report && res.report.results || []).filter((it) => it.value && it.value[1] !== "PASS");
  const xps = await xpathViaEvaluate(page, items.map((it) => it.path && it.path.dom || ""));
  return items.map((it, i) => ({ ruleId: it.ruleId, sc: [...new Set(IBM_RULE2SC[it.ruleId] || [])], outcome: it.value[0] === "VIOLATION" && it.value[1] === "FAIL" ? "violation" : "review", level: it.value.join("/"), xpath: xps[i] }));
}
let ALFA_SC = null;
async function runAlfa(page) {
  const { Puppeteer } = require("@siteimprove/alfa-puppeteer");
  const rules = require("@siteimprove/alfa-rules").default;
  const { Audit } = require("@siteimprove/alfa-act");
  if (!ALFA_SC) {
    ALFA_SC = {};
    for (const r of Array.isArray(rules) ? rules : [...rules]) {
      const sc = [];
      for (const q of r.requirements ? [...r.requirements] : []) {
        const j = q.toJSON ? q.toJSON() : q;
        if (j.type === "criterion" && /^\d\.\d+\.\d+$/.test(j.chapter || "")) sc.push(j.chapter);
      }
      ALFA_SC[r.uri] = [...new Set(sc)];
    }
  }
  const handle = await page.evaluateHandle(() => window.document);
  const alfaPage = await Puppeteer.toPage(handle);
  let outcomes = await Audit.of(alfaPage, rules).evaluate();
  if (outcomes && typeof outcomes.get === "function") outcomes = outcomes.get();
  const rows = [];
  for (const o of Array.isArray(outcomes) ? outcomes : [...outcomes]) {
    const j = typeof o.toJSON === "function" ? o.toJSON() : o;
    const verdict = j.outcome || o.outcome && String(o.outcome);
    if (verdict !== "failed" && verdict !== "cantTell") continue;
    const uri = j.rule && (j.rule.uri || j.rule.id) || "";
    let p = null;
    try {
      p = o.target && typeof o.target.path === "function" ? String(o.target.path()) : null;
    } catch (e) {
      p = null;
    }
    rows.push({ ruleId: uri.split("/").pop(), sc: ALFA_SC[uri] || [], outcome: verdict === "failed" ? "violation" : "review", path: p });
  }
  const xps = await xpathViaEvaluate(page, rows.map((r) => (r.path || "").replace(/\/(@[^/]+|text\(\)(\[\d+\])?)$/, "")));
  return rows.map((r, i) => ({ ruleId: r.ruleId, sc: r.sc, outcome: r.outcome, xpath: xps[i], path: xps[i] ? void 0 : r.path }));
}
let QW = null;
let QW_ERRORS = [];
async function startQw() {
  const { QualWeb } = require("@qualweb/core");
  QW = new QualWeb({});
  await QW.start({ maxConcurrency: 1, timeout: 12e4 }, { headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"], executablePath: CONFIG.chromePath });
  const cluster = QW.cluster || QW.pool?.cluster;
  if (!cluster) throw Error("QualWeb driver does not expose a supported worker pool");
  cluster.on("taskerror", (err, data) => QW_ERRORS.push({ url: data?.url, message: String(err.message || err) }));
  if (INSTRUMENT) {
    let invoke, nativeHandle, handleArgs;
    const patchWorkers = () => {
      for (const worker of cluster.workers) {
        worker.__comparisonHandle ||= worker.handle.bind(worker);
        worker.handle = (...args) => {
          nativeHandle = worker.__comparisonHandle;
          handleArgs = args;
          return invoke();
        };
        if (!worker.browser.__comparisonJobInstance) {
          const jobInstance = worker.browser.jobInstance.bind(worker.browser);
          worker.browser.__comparisonJobInstance = true;
          worker.browser.jobInstance = async (...args) => (await timed(async () => {
            const job = await jobInstance(...args);
            instrumentPage(job.resources.page);
            const close = job.close.bind(job);
            job.close = async (...values) => (await timed(() => close(...values), { kind: "infra", name: "qualweb-context-teardown" })).value;
            return job;
          }, { kind: "infra", name: "qualweb-context-setup" })).value;
        }
      }
    };
    const launchWorker = cluster.launchWorker.bind(cluster);
    cluster.launchWorker = async (...args) => {
      const result = await launchWorker(...args);
      patchWorkers();
      return result;
    };
    const queue = cluster.queue.bind(cluster);
    cluster.queue = (...args) => {
      invoke = queuedCallback("qualweb-worker", async () => (await timed(
        () => nativeHandle(...handleArgs),
        { kind: "processing", name: "qualweb-worker-operation", recordTree: true }
      )).value);
      patchWorkers();
      return queue(...args);
    };
  }
}
async function runQualweb(page, url) {
  const { ACTRules } = require("@qualweb/act-rules");
  const { WCAGTechniques } = require("@qualweb/wcag-techniques");
  QW_ERRORS = [];
  const ev = await QW.evaluate({ url, viewport: { mobile: false, landscape: true, resolution: { width: CONFIG.viewport.width, height: CONFIG.viewport.height } }, modules: [new ACTRules({}), new WCAGTechniques({})] });
  const rep = ev[url] || Object.values(ev)[0];
  if (!rep || !rep.modules || !rep.modules["act-rules"] && !rep.modules["wcag-techniques"]) {
    throw Error("QualWeb returned no evaluated module report: " + JSON.stringify(QW_ERRORS));
  }
  const rows = [];
  for (const mod of ["act-rules", "wcag-techniques"]) {
    for (const [code, a] of Object.entries(rep && rep.modules && rep.modules[mod] && rep.modules[mod].assertions || {})) {
      const sc = scFromQualweb(a.metadata && a.metadata["success-criteria"]);
      for (const r of a.results || []) {
        if (r.verdict !== "failed" && r.verdict !== "warning") continue;
        const els = r.elements && r.elements.length ? r.elements : [{}];
        for (const e of els) rows.push({ ruleId: code, sc, outcome: r.verdict === "failed" ? "violation" : "review", pointer: e.pointer || null });
      }
    }
  }
  const xps = await page.evaluate((ps) => ps.map((p) => {
    if (!p) return null;
    try {
      const el = document.querySelector(p);
      return el ? window.__ia.xpathOf(el) : null;
    } catch (e) {
      return null;
    }
  }), rows.map((r) => r.pointer));
  return rows.map((r, i) => ({ ruleId: r.ruleId, sc: r.sc, outcome: r.outcome, xpath: xps[i], pointer: xps[i] ? void 0 : r.pointer }));
}
module.exports = {
  runAxe,
  runHtmlcs,
  runIbm,
  runAlfa,
  runQualweb,
  startQw,
  closeQw: async () => {
    if (QW) await QW.stop();
    QW = null;
  }
};
