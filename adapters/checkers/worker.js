"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { chromium } = require("playwright");
const { Ledger, instrument } = require("./ledger"), { mapRule } = require("./mappings");
const { standardize } = require("./upstream/procs/standardize");
const ROOT = __dirname;
let OUTPUT = process.env.INTERA11Y_OUTPUT_DIR || path.join(ROOT, "output");
let browser = null, active = null;
const rawFetch = global.fetch;
global.fetch = (url, opts) => rawFetch(String(url).startsWith("https://validator.w3.org/nu/") ? `${process.env.NU_BASE}/?parser=html&out=json` : url, opts);
const xpathOf = function(el) {
  if (!el || el.nodeType !== 1) return null;
  const parts = [];
  while (el && el.nodeType === 1) {
    let n = 1;
    for (let p = el.previousElementSibling; p; p = p.previousElementSibling) if (p.localName === el.localName) n++;
    const tag = el.namespaceURI === "http://www.w3.org/1999/xhtml" ? el.localName.toLowerCase() : `*[local-name()='${el.localName}']`;
    parts.unshift(tag + `[${n}]`);
    el = el.parentElement;
  }
  return "/" + parts.join("/");
};
function resultName(task) {
  return task.tool + "-" + crypto.createHash("sha1").update(task.case.key).digest("hex").slice(0, 20);
}
function seedRandom(seed) {
  let n = parseInt(crypto.createHash("sha256").update(seed).digest("hex").slice(0, 8), 16);
  return () => {
    n = n + 1831565813 | 0;
    let t = Math.imul(n ^ n >>> 15, 1 | n);
    t ^= t + Math.imul(t ^ t >>> 7, 61 | t);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function wireOwnRules() {
  for (const name of fs.readdirSync(path.join(ROOT, "upstream/testaro")).filter((n) => n.endsWith(".js"))) {
    const mod = require(path.join(ROOT, "upstream/testaro", name));
    if (typeof mod.reporter === "function" && !mod.reporter.__timed) {
      const original = mod.reporter;
      const rule = name.slice(0, -3);
      const fn = (...args) => active.span("rule", rule, () => original(...args));
      fn.__timed = true;
      mod.reporter = fn;
    }
  }
}
wireOwnRules();
async function aslint(page) {
  const bundle = require.resolve("@essentialaccessibility/aslint/dist/aslint.bundle.js");
  if (!fs.existsSync(bundle)) throw Error("Latest ASLint browser bundle is not built");
  await page.addScriptTag({ path: bundle });
  await page.addScriptTag({ content: fs.readFileSync(path.join(ROOT, "upstream/procs/aslint.js"), "utf8") });
  const loc = page.locator("#aslintResult");
  await loc.waitFor({ state: "attached", timeout: 65e3 });
  const result = JSON.parse(await loc.textContent());
  for (const [id, r] of Object.entries(result.rules || {})) if (["passed", "skipped"].includes(r.status?.type)) delete result.rules[id];
  return { data: {}, result };
}
async function editoria(page, cssURL) {
  for (const file of ["ed11y.umd.min.js", "lang/en.umd.js"]) await page.addScriptTag({ content: "(function(){var define,module,exports;" + fs.readFileSync(path.join(process.env.EDITORIA11Y_HOME || path.join(ROOT, "editoria11y"), "dist/js", file), "utf8") + "\n}).call(window);" });
  const report = await page.evaluate(({ cssURL: cssURL2, xpathCode }) => new Promise((resolve, reject) => {
    const xpath = (0, eval)("(" + xpathCode + ")");
    const timer = setTimeout(() => reject(Error("Editoria11y did not emit results in 65 seconds")), 65e3);
    document.addEventListener("ed11yResults", (event) => {
      clearTimeout(timer);
      const list = event.detail?.results || window.Ed11y.State.results;
      resolve({ version: window.Ed11y.version, results: list.map((r) => ({ test: r.test, type: r.type, content: r.content || r.tipContent || "", xpath: xpath(r.element), html: r.element?.outerHTML?.slice(0, 1200) || "", dismissalStatus: r.dismissalStatus || null })) });
    }, { once: true });
    try {
      new window.Ed11y.Ed11y({ alertMode: "headless", lang: window.Ed11yLangEn.lang, cssUrls: [cssURL2], watchForChanges: false, contrastPlugin: true, formLabelsPlugin: true, linksAdvancedPlugin: true, embeddedContentPlugin: true });
    } catch (e) {
      clearTimeout(timer);
      reject(e);
    }
  }), { cssURL, xpathCode: xpathOf.toString() });
  return { data: {}, result: report };
}
function mapped(engine, id, outcome, xpath, extra = {}) {
  const m = mapRule(engine, id);
  return { ruleId: id, sc: m.sc, outcome: m.review ? "review" : outcome, xpath: xpath || null, ruleMapping: m.metadata, ...extra };
}
async function nuLocations(result, page, caseFile) {
  const { parse } = await import("parse5");
  const output = [];
  for (const [docType, report] of Object.entries(result)) {
    let visit = function(n, prefix) {
      let own = prefix;
      if (n.tagName) {
        let index = 1;
        for (const sib of n.parentNode?.childNodes || []) {
          if (sib === n) break;
          if (sib.tagName === n.tagName) index++;
        }
        own = prefix + "/" + n.tagName + `[${index}]`;
        if (n.sourceCodeLocation) elements.push({ node: n, xpath: own });
      }
      for (const child of n.childNodes || []) visit(child, own);
    };
    if (!report?.messages) continue;
    const html = docType === "rawPage" ? fs.readFileSync(caseFile, "utf8") : await page.content();
    const lines = [0];
    for (let i = 0; i < html.length; i++) if (html[i] === "\n") lines.push(i + 1);
    const tree = parse(html, { sourceCodeLocationInfo: true }), elements = [];
    visit(tree, "");
    for (const message of report.messages) {
      const row = (message.firstLine || message.lastLine || 1) - 1, col = (message.firstColumn || message.lastColumn || 1) - 1;
      const offset = (lines[row] ?? 0) + col;
      const candidates = elements.filter((e) => {
        const l = e.node.sourceCodeLocation.startTag || e.node.sourceCodeLocation;
        return offset >= l.startOffset && offset <= l.endOffset;
      });
      candidates.sort((a, b) => a.node.sourceCodeLocation.endOffset - a.node.sourceCodeLocation.startOffset - (b.node.sourceCodeLocation.endOffset - b.node.sourceCodeLocation.startOffset));
      const xp = candidates[0]?.xpath || null;
      output.push(mapped("nuVal", message.message, message.type === "error" ? "violation" : "review", xp, { docType, native: message }));
    }
  }
  return output;
}
async function normalize(tool, act, page, caseFile) {
  let rows = [];
  if (tool === "ed11y") rows = (act.result.results || []).map((r) => mapped(tool, r.test, r.type === "error" ? "violation" : "review", r.xpath, { native: r }));
  else if (tool === "nuVal") rows = await nuLocations(act.result, page, caseFile);
  else {
    act.standardResult = { totals: [0, 0, 0, 0], instances: [] };
    standardize(act);
    rows = act.standardResult.instances.map((r) => mapped(tool, r.ruleID, r.ordinalSeverity === 0 ? "review" : "violation", r.pathID || (r.location?.type === "xpath" ? r.location.spec : null), { native: r }));
  }
  for (const r of rows) if (r.xpath) {
    r.nativeXpath = r.xpath;
    r.xpath = r.xpath.replace(/^\.\/\/html(?=\/|\[|$)/, "/html").replace(/\*[[]name\(\)='([^']+)'\]/g, "*[local-name()='$1']");
    if (!r.xpath.startsWith("//")) r.xpath = r.xpath.split("/").map((s) => s && !/\[\d+\]$/.test(s) ? s + "[1]" : s).join("/");
  }
  const xps = [...new Set(rows.map((r) => r.xpath).filter(Boolean))];
  const verified = await page.evaluate((list) => list.map((xp) => {
    try {
      const r = document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      return r.snapshotLength === 1 && r.snapshotItem(0).nodeType === 1;
    } catch {
      return false;
    }
  }), xps);
  const good = new Set(xps.filter((x, i) => verified[i]));
  for (const r of rows) if (r.xpath && !good.has(r.xpath)) {
    r.nativeXpath = r.xpath;
    r.xpath = null;
    r.locationUnresolved = true;
  }
  return rows;
}
async function run(task) {
  const name = resultName(task), dir = path.join(OUTPUT, "cases");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name + ".json"), trace = path.join(dir, name + `.attempt-${task.attempt}.trace.jsonl`);
  const ledger = new Ledger(trace);
  active = ledger;
  let context, page, act, findings = [], error = null, cleanupError = null;
  const oldRandom = Math.random;
  if (task.tool === "testaro") Math.random = seedRandom(task.case.key + "|testaro");
  try {
    if (!browser) browser = await ledger.span("infra", "browser-setup", () => chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || void 0, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--font-render-hinting=none", "--hide-scrollbars", "--mute-audio", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"] }));
    context = await ledger.span("infra", "browser-context-setup", () => browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, bypassCSP: true }));
    await context.route("**/*", (route) => ["GET", "HEAD", "OPTIONS"].includes(route.request().method()) || new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
    const native = await ledger.span("infra", "browser-tab-setup", () => context.newPage());
    await ledger.span("infra", "focus-emulation", async () => {
      const cdp = await context.newCDPSession(native);
      await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    });
    native.on("dialog", (d) => d.dismiss().catch(() => {
    }));
    page = instrument(native, ledger);
    page.setDefaultTimeout(15e3);
    let lastNav = Date.now();
    native.on("framenavigated", (f) => {
      if (f === native.mainFrame()) lastNav = Date.now();
    });
    const navigation = await ledger.span("wait", "navigation-resource-wait", async () => {
      try {
        return await page.goto(task.url, { waitUntil: "load", timeout: 3e4 });
      } catch (error2) {
        if (!/Timeout/.test(error2.message) || !await page.evaluate(() => !!document.body).catch(() => false)) throw error2;
        return null;
      }
    });
    if (navigation?.status() >= 400) throw Error("Snapshot navigation HTTP " + navigation.status());
    await ledger.span("wait", "initial-resource-settle", async () => {
      const deadline = Date.now() + 15e3;
      while (Date.now() < deadline) {
        if (Date.now() - lastNav >= 2e3 && await page.evaluate(() => document.readyState === "complete" && !!document.body)) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      await new Promise((r) => setTimeout(r, 150));
      await page.evaluate(async () => {
        const lazy = document.querySelectorAll('img[loading="lazy"],iframe[loading="lazy"]');
        for (const el of lazy) el.loading = "eager";
        if (lazy.length) await Promise.race([new Promise((r) => setTimeout(r, 8e3)), Promise.all([...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => {
          i.addEventListener("load", r, { once: true });
          i.addEventListener("error", r, { once: true });
        })))]);
      });
    });
    if (page.url().split("#")[0] !== task.url.split("#")[0]) throw Error("Page left the saved snapshot before testing: " + page.url());
    act = { which: task.tool, withItems: true };
    const report = { acts: [act], observe: false, jobData: {}, target: { url: task.url } };
    const result = await ledger.span("tool", task.tool, () => task.tool === "aslint" ? aslint(page) : task.tool === "ed11y" ? editoria(page, task.cssURL) : require("./upstream/tests/" + task.tool).reporter(page, report, 0, 65));
    Object.assign(act, result);
    if (act.data?.prevented) throw Error(act.data.error || "Tool prevented");
    if (page.url().split("#")[0] !== task.url.split("#")[0]) throw Error("Page left the saved snapshot during testing: " + page.url());
    findings = await ledger.span("tool", "normalize-findings", () => normalize(task.tool, act, page, task.case.file));
  } catch (e) {
    error = String(e.stack || e);
  } finally {
    Math.random = oldRandom;
    if (context) try {
      await ledger.span("infra", "browser-context-teardown", () => context.close());
    } catch (e) {
      cleanupError = String(e.message);
    }
  }
  const failedRules = act?.data?.rulePreventions || [];
  const row = {
    id: task.case.id,
    corpus: task.case.corpus,
    tool: task.tool,
    scs: task.case.scs,
    attempt: task.attempt,
    caseKey: task.case.key,
    sourceFile: task.case.file,
    error,
    cleanupError,
    partial: failedRules.length > 0,
    failedRules,
    findings,
    nativeReport: act,
    timing: { ...ledger.summary(failedRules), queueWaitMs: task.dispatchedAt - task.queuedAt },
    trace: path.relative(ROOT, trace),
    versions: { testaro: "58.0.6", aslint: "0.0.58", ed11y: "3.0.2", nuVal: "26.10.12" },
    samplePolicy: task.tool === "testaro" ? "Upstream index-weighted random sampling; deterministic per-page seed; upstream sample limits and rule limits preserved" : null
  };
  const partial = file + ".tmp";
  fs.writeFileSync(partial, JSON.stringify(row));
  fs.renameSync(partial, file);
  return { file, error, partial: row.partial, tool: task.tool, key: task.case.key, attempt: task.attempt };
}
module.exports = { run, close: async () => {
  if (browser) await browser.close();
  browser = null;
} };
