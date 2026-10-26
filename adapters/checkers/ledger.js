"use strict";
const fs = require("fs"), { AsyncLocalStorage } = require("async_hooks");
const storage = new AsyncLocalStorage();
function union(xs) {
  const out = [];
  for (const [a, b] of xs.filter(([a2, b2]) => b2 > a2).sort((x, y) => x[0] - y[0])) {
    if (out.length && a <= out.at(-1)[1]) out.at(-1)[1] = Math.max(out.at(-1)[1], b);
    else out.push([a, b]);
  }
  return out;
}
function subtract(xs, ys) {
  const out = [];
  for (const [a, b] of union(xs)) {
    let c = a;
    for (const [x, y] of union(ys)) {
      if (y <= c) continue;
      if (x >= b) break;
      if (x > c) out.push([c, Math.min(x, b)]);
      c = Math.max(c, y);
      if (c >= b) break;
    }
    if (c < b) out.push([c, b]);
  }
  return out;
}
const size = (xs) => union(xs).reduce((n, [a, b]) => n + b - a, 0);
class Ledger {
  constructor(file) {
    this.file = file;
    this.start = performance.now();
    this.events = [];
    this.counter = 0;
  }
  async span(kind, name, fn, args) {
    const row = { id: ++this.counter, parentId: storage.getStore()?.ledger === this ? storage.getStore().id : null, kind, name, startMs: performance.now() - this.start, startedAt: (/* @__PURE__ */ new Date()).toISOString(), accepted: true, argsPreview: args };
    this.events.push(row);
    try {
      return await storage.run({ ledger: this, id: row.id }, fn);
    } catch (error) {
      row.accepted = false;
      row.error = String(error.message || error);
      throw error;
    } finally {
      row.endMs = performance.now() - this.start;
      row.elapsedMs = row.endMs - row.startMs;
      fs.appendFileSync(this.file, JSON.stringify(row) + "\n");
    }
  }
  summary(failedRules = []) {
    const excluded = this.events.filter((e) => !e.accepted || e.kind === "rule" && failedRules.includes(e.name)).map((e) => [e.startMs, e.endMs || performance.now() - this.start]);
    const productive = this.events.filter((e) => e.accepted && ["tool", "rule", "rpc"].includes(e.kind) && e.endMs).map((e) => [e.startMs, e.endMs]);
    const infra = this.events.filter((e) => e.accepted && e.kind === "infra" && e.endMs).map((e) => [e.startMs, e.endMs]);
    const waits = this.events.filter((e) => e.kind === "wait" && e.endMs).map((e) => [e.startMs, e.endMs]);
    const processing = subtract(productive, [...excluded, ...waits, ...infra]);
    const exclusive = subtract(infra, [...waits, ...excluded]);
    return { version: "start-end-union-v1", successfulProcessingMs: size(processing), exclusiveInfrastructureMs: size(exclusive), accountedMs: size(processing) + size(exclusive), recordedWaitMs: size(waits), excludedAttemptMs: size(excluded), genericCalls: this.events.filter((e) => e.kind === "rpc").length, ruleCalls: this.events.filter((e) => e.kind === "rule").length, failedRules };
  }
}
const SYNC = /* @__PURE__ */ new Set(["locator", "frameLocator", "getByRole", "getByText", "getByLabel", "getByPlaceholder", "getByTitle", "getByTestId", "getByAltText", "first", "last", "nth", "filter", "or", "and"]);
const RPC = /* @__PURE__ */ new Set(["goto", "reload", "evaluate", "evaluateHandle", "content", "screenshot", "addScriptTag", "addStyleTag", "count", "all", "allTextContents", "allInnerTexts", "getAttribute", "textContent", "innerText", "innerHTML", "boundingBox", "isVisible", "isHidden", "isEnabled", "isChecked", "focus", "blur", "click", "dblclick", "hover", "press", "pressSequentially", "fill", "check", "uncheck", "selectOption", "waitFor", "waitForSelector", "waitForFunction", "waitForLoadState", "title", "getProperty", "getProperties", "jsonValue", "scrollIntoViewIfNeeded", "inputValue", "dispatchEvent", "type", "down", "up", "move", "wheel"]);
function instrument(target, ledger, name = "page", cache = /* @__PURE__ */ new WeakMap()) {
  if (!target || typeof target !== "object") return target;
  if (cache.has(target)) return cache.get(target);
  const wrap = (value) => Array.isArray(value) ? value.map(wrap) : value && typeof value === "object" && (typeof value.evaluate === "function" || typeof value.locator === "function" || typeof value.press === "function") ? instrument(value, ledger, "locator", cache) : value;
  const proxy = new Proxy(target, { get(obj, key) {
    const value = Reflect.get(obj, key, obj);
    if (typeof value !== "function") return ["keyboard", "mouse"].includes(key) ? instrument(value, ledger, String(key), cache) : value;
    if (SYNC.has(key)) return (...args) => wrap(value.apply(obj, args));
    if (!RPC.has(key)) return value.bind(obj);
    return (...args) => ledger.span("rpc", `${name}.${String(key)}`, async () => wrap(await value.apply(obj, args)), args.map((a) => typeof a === "function" ? "[function]" : typeof a === "string" ? a.slice(0, 250) : "[value]"));
  } });
  cache.set(target, proxy);
  return proxy;
}
module.exports = { Ledger, instrument };
