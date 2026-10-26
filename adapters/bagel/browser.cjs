"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { analyzePixels } = require("./core.cjs");
const ALL_KEYS = ["Tab", "Shift+Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Space", "Escape"];
function inspectPage() {
  function xpath(el) {
    if (!el || el.nodeType !== 1) return null;
    const parts = [];
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const tag = node.localName;
      let index = 1;
      for (let previous = node.previousElementSibling; previous; previous = previous.previousElementSibling) if (previous.localName === tag) index++;
      parts.unshift(`${tag}[${index}]`);
    }
    return "/" + parts.join("/");
  }
  function visible(el) {
    const r = el.getBoundingClientRect(), style = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }
  const selector = 'a[href],area[href],button,input:not([type="hidden"]),select,textarea,summary,[tabindex],[contenteditable="true"],[onkeydown],[onkeyup],[onkeypress]';
  return [...document.querySelectorAll(selector)].filter((el) => visible(el) && !el.disabled && (!el.hasAttribute("tabindex") || el.tabIndex >= 0 || ["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(el.tagName))).map((el, index) => {
    const r = el.getBoundingClientRect();
    return {
      xpath: xpath(el),
      index,
      tag: el.localName,
      text: (el.innerText || el.value || "").trim().slice(0, 200),
      rect: { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }
    };
  });
}
async function acquire(url, options = {}) {
  const started = Date.now();
  let current = {};
  const progress = (stage, detail = {}) => {
    if (typeof options.onProgress === "function") options.onProgress({
      at: (/* @__PURE__ */ new Date()).toISOString(),
      elapsedMs: Date.now() - started,
      stage,
      ...current,
      ...detail
    });
  };
  const puppeteer = require("puppeteer");
  const viewport = { width: options.width || 1920, height: options.height || 1080, deviceScaleFactor: 1 };
  const timeout = options.timeout || 3e4, settleMs = options.settleMs ?? 150;
  const keys = options.keys || ALL_KEYS, padding = options.padding ?? 8;
  progress("browser-launch:start", { timeoutMs: timeout });
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: options.executablePath || void 0,
    protocolTimeout: timeout,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    defaultViewport: viewport
  });
  progress("browser-launch:complete");
  let page, imagePage;
  try {
    progress("page-create:start", { pageType: "target" });
    page = await browser.newPage();
    progress("page-create:complete", { pageType: "target" });
    progress("page-create:start", { pageType: "image-decoder" });
    imagePage = await browser.newPage();
    progress("page-create:complete", { pageType: "image-decoder" });
  } catch (error) {
    progress("page-create:error", { error: error.message });
    await browser.close();
    throw error;
  }
  const acquisition = {
    schema: "bagel-paper-prototype-v1",
    url,
    viewport,
    keys,
    nodes: [],
    edges: [],
    focus: [],
    errors: [],
    complete: false,
    implementation: "independent BAGEL paper-based prototype",
    acquiredAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  let trial = false, navigationAttempts = [];
  const pause = () => new Promise((resolve) => setTimeout(resolve, settleMs));
  try {
    progress("page-setup:start");
    page.setDefaultTimeout(timeout);
    page.setDefaultNavigationTimeout(timeout);
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (trial && request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        navigationAttempts.push({ url: request.url(), method: request.method() });
        request.abort().catch(() => {
        });
        return;
      }
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
        request.abort().catch(() => {
        });
        return;
      }
      request.continue().catch(() => {
      });
    });
    page.on("dialog", (dialog) => dialog.dismiss().catch(() => {
    }));
    progress("page-setup:complete");
    async function load() {
      trial = false;
      progress("load:start");
      await page.goto(url, { waitUntil: "load", timeout });
      await pause();
      progress("load:complete");
    }
    async function element(xpath) {
      const handle = await page.evaluateHandle((p) => document.evaluate(p, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue, xpath);
      const el = handle.asElement();
      if (!el) {
        await handle.dispose();
        throw new Error(`Element disappeared: ${xpath}`);
      }
      return el;
    }
    await load();
    progress("inspection:start");
    const allNodes = await page.evaluate(inspectPage);
    const limit = options.maxNodes ?? allNodes.length;
    acquisition.nodes = allNodes.slice(0, limit);
    acquisition.initialNodeCount = allNodes.length;
    acquisition.truncated = acquisition.nodes.length !== allNodes.length;
    progress("inspection:complete", { initialNodeCount: allNodes.length, selectedNodeCount: acquisition.nodes.length });
    if (options.outputDir) await fs.mkdir(options.outputDir, { recursive: true });
    for (const node of acquisition.nodes) {
      current = { nodeIndex: node.index, xpath: node.xpath, phase: "focus" };
      if (options.focus !== false) {
        try {
          progress("focus:start");
          await load();
          progress("focus-foreground:start");
          await page.bringToFront();
          progress("focus-foreground:complete");
          const el = await element(node.xpath);
          await page.keyboard.press("Tab");
          await el.evaluate((e) => {
            e.scrollIntoView({ block: "center", inline: "center" });
            e.focus({ preventScroll: true });
          });
          await pause();
          const geometry = await el.evaluate((e) => {
            const r = e.getBoundingClientRect();
            const inset = Math.min(2, r.width / 4, r.height / 4);
            const points = [
              [r.x + inset, r.y + inset],
              [r.right - inset, r.y + inset],
              [r.x + inset, r.bottom - inset],
              [r.right - inset, r.bottom - inset],
              [r.x + r.width / 2, r.y + r.height / 2]
            ];
            const exposed = points.map(([x, y]) => {
              const top = document.elementFromPoint(x, y);
              return Boolean(top && (top === e || e.contains(top)));
            });
            return {
              x: r.x + scrollX,
              y: r.y + scrollY,
              width: r.width,
              height: r.height,
              unobscured: exposed.every(Boolean),
              exposedSamples: exposed,
              focused: document.activeElement === e,
              documentWidth: Math.max(document.documentElement.scrollWidth, innerWidth),
              documentHeight: Math.max(document.documentElement.scrollHeight, innerHeight)
            };
          });
          if (!geometry.focused) throw new Error("Element did not accept focus");
          const clip = { x: Math.max(0, Math.floor(geometry.x - padding)), y: Math.max(0, Math.floor(geometry.y - padding)) };
          clip.width = Math.min(geometry.documentWidth - clip.x, Math.ceil(geometry.width + 2 * padding));
          clip.height = Math.min(geometry.documentHeight - clip.y, Math.ceil(geometry.height + 2 * padding));
          await el.evaluate((e) => e.blur());
          await pause();
          progress("focus-screenshot:start", { imageState: "unfocused" });
          const before = await page.screenshot({ type: "png", clip, captureBeyondViewport: true });
          progress("focus-screenshot:complete", { imageState: "unfocused" });
          await el.evaluate((e) => e.focus({ preventScroll: true }));
          await pause();
          progress("focus-screenshot:start", { imageState: "focused" });
          const after = await page.screenshot({ type: "png", clip, captureBeyondViewport: true });
          progress("focus-screenshot:complete", { imageState: "focused" });
          progress("focus-image-decode:start");
          const pixels = await imagePage.evaluate(async (a, b) => {
            async function decode(base64) {
              const img = new Image();
              img.src = `data:image/png;base64,${base64}`;
              await img.decode();
              const canvas = document.createElement("canvas");
              canvas.width = img.width;
              canvas.height = img.height;
              const context = canvas.getContext("2d");
              context.drawImage(img, 0, 0);
              return { width: img.width, height: img.height, pixels: Array.from(context.getImageData(0, 0, img.width, img.height).data) };
            }
            return [await decode(a), await decode(b)];
          }, Buffer.from(before).toString("base64"), Buffer.from(after).toString("base64"));
          progress("focus-image-decode:complete");
          if (pixels[0].width !== pixels[1].width || pixels[0].height !== pixels[1].height) throw new Error("Focus crops changed dimensions");
          const analysis = analyzePixels(pixels[0].pixels, pixels[1].pixels, pixels[0].width, pixels[0].height, geometry, options);
          const record = { xpath: node.xpath, geometry, clip, ...analysis };
          if (options.outputDir) {
            const stem = `focus-${String(node.index).padStart(4, "0")}`;
            record.beforeScreenshot = `${stem}-before.png`;
            record.afterScreenshot = `${stem}-after.png`;
            await fs.writeFile(path.join(options.outputDir, record.beforeScreenshot), before);
            await fs.writeFile(path.join(options.outputDir, record.afterScreenshot), after);
          }
          acquisition.focus.push(record);
          await el.dispose();
          progress("focus:complete", { result: analysis.result });
        } catch (error) {
          acquisition.errors.push({ stage: "focus", xpath: node.xpath, error: error.message });
          progress("focus:error", { error: error.message });
        }
      }
      for (const key of keys) {
        current = { nodeIndex: node.index, xpath: node.xpath, phase: "keyboard", key };
        try {
          progress("key:start");
          await load();
          const el = await element(node.xpath);
          await page.keyboard.press("Tab");
          await el.evaluate((e) => e.focus({ preventScroll: false }));
          const accepted = await el.evaluate((e) => document.activeElement === e);
          if (!accepted) throw new Error("Element did not accept focus");
          navigationAttempts = [];
          trial = true;
          if (key === "Shift+Tab") {
            await page.keyboard.down("Shift");
            await page.keyboard.press("Tab");
            await page.keyboard.up("Shift");
          } else await page.keyboard.press(key);
          await pause();
          trial = false;
          progress("key-target:start");
          const target = await page.evaluate(() => {
            const parts = [];
            let e = document.activeElement;
            if (!e || ["BODY", "HTML"].includes(e.tagName)) return null;
            for (; e && e.nodeType === 1; e = e.parentElement) {
              let index = 1;
              for (let p = e.previousElementSibling; p; p = p.previousElementSibling) if (p.localName === e.localName) index++;
              parts.unshift(`${e.localName}[${index}]`);
            }
            return "/" + parts.join("/");
          });
          progress("key-target:complete", { target });
          acquisition.edges.push({
            source: node.xpath,
            target: navigationAttempts.length ? "v_ext" : target,
            key,
            navigationAttempt: navigationAttempts.length > 0,
            navigationAttempts: [...navigationAttempts]
          });
          await el.dispose();
          progress("key:complete", { navigationAttempt: navigationAttempts.length > 0 });
        } catch (error) {
          trial = false;
          acquisition.errors.push({ stage: "keyboard", xpath: node.xpath, key, error: error.message });
          progress("key:error", { error: error.message });
        }
      }
    }
    acquisition.complete = !acquisition.truncated && acquisition.errors.length === 0;
    acquisition.termination = acquisition.truncated ? "explicit-max-nodes" : acquisition.errors.length ? "acquisition-errors" : "completed-initial-state";
    current = {};
    progress("acquisition:complete", { complete: acquisition.complete, errorCount: acquisition.errors.length });
    return acquisition;
  } finally {
    progress("browser-close:start");
    await browser.close();
    progress("browser-close:complete");
  }
}
module.exports = { acquire, inspectPage, ALL_KEYS };
