'use strict';

const puppeteer = require('puppeteer');
const { awaitSettle } = require('../lib/v3.js');
const { CONFIG } = require('./config.js');
const { installHelpers, installListenerLog } = require('../model/inpage.js');
const { bounded } = require('./deadline.js');
const { infrastructure, timed } = require('./timing.js');
const { withBrowserStartup } = require('./browser-startup.js');
const { blocked } = require('./execution-health.js');

const BROWSER_ARGS = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--font-render-hinting=none',
  '--hide-scrollbars', '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows'];

async function launchBrowser() {
  const hold = blocked();
  if (hold) throw new Error(hold.reason);
  return withBrowserStartup(() => puppeteer.launch({ executablePath: CONFIG.chromePath, headless: 'new',
    args: BROWSER_ARGS, timeout: 120000, protocolTimeout: 180000 }));
}

const newWindowPage = (browser) => infrastructure('browser-tab-setup', () => browser.newPage({ type: 'window' }));
const closePage = async (page) => (await timed(() => bounded(
  page.close().then(() => ({ closed: true }), (e) => ({ error: String(e && e.message || e) })),
  15000, { error: 'browser-tab-teardown-timeout' }),
{ kind: 'infra', name: 'browser-tab-teardown', accept: (r) => !r.error })).value;

async function openPage(browser, url, viewport = CONFIG.viewport) {
  const page = await newWindowPage(browser);
  const nativeClose = page.close.bind(page);
  page.close = async (...args) => (await timed(() => nativeClose(...args), { kind: 'infra', name: 'browser-tab-close' })).value;
  await infrastructure('browser-tab-initialization', async () => {
    await page.setViewport(viewport);

    const cdp = await page.createCDPSession();
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});

    page.__dialogs = [];
    page.on('dialog', (d) => { page.__dialogs.push({ type: d.type(), message: d.message() }); d.dismiss().catch(() => {}); });
    await page.evaluateOnNewDocument(installHelpers);
    await page.evaluateOnNewDocument(installListenerLog);
  });
  let lastNav = Date.now();
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) lastNav = Date.now(); });

  const res = (await timed(() => page.goto(url, { waitUntil: 'load', timeout: CONFIG.navTimeoutMs }).catch((e) => ({ failed: e })),
    { kind: 'tool', name: 'navigate', accept: (r) => !(r && (r.failed || (/^https?:/.test(url) && r.status() >= 400))) })).value;
  if (res && res.failed && !/timeout/i.test(String(res.failed.message))) { await closePage(page); throw new Error(`page did not load: ${String(res.failed.message).slice(0, 200)}`); }
  if (res && !res.failed && /^https?:/.test(url) && res.status() >= 400) { await closePage(page); throw new Error(`page did not load: HTTP ${res.status()}`); }
  await awaitSettle(page, { force: true, floorMs: CONFIG.settleFloorMs });

  const until = Date.now() + CONFIG.navQuietMaxMs;
  let navigated = false;
  const loadedAt = lastNav;
  while (Date.now() < until) {
    if (Date.now() - lastNav >= CONFIG.navQuietMs) {
      const ready = await bounded(page.evaluate(() => document.readyState === 'complete' && !!document.body).catch(() => false), 5000, false);
      if (ready) break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (lastNav !== loadedAt) navigated = true;
  if (navigated) await awaitSettle(page, { force: true, floorMs: CONFIG.settleFloorMs });
  return page;
}

async function loadLazyContent(page, { maxMs = CONFIG.lazyLoadMaxMs } = {}) {
  const n = await page.evaluate(() => { let k = 0; for (const el of document.querySelectorAll('img[loading="lazy"],iframe[loading="lazy"]')) { el.loading = 'eager'; k++; } return k; }).catch(() => 0);
  if (!n) return;
  await bounded(page.evaluate(() => Promise.all([...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); })))).catch(() => {}), maxMs, null);
  await awaitSettle(page, { force: true, floorMs: CONFIG.settleFloorMs });
}

async function openSession(browser, url) {
  const page = await openPage(browser, url);
  const open = new Set([page]);
  const freshPage = async (viewport) => {
    const p = await openPage(browser, url, viewport || CONFIG.viewport);
    open.add(p);
    p.once('close', () => open.delete(p));
    return p;
  };

  const withFreshPage = async (fn, viewport) => {
    return (await timed(async () => {
      const p = await freshPage(viewport);
      try { return await fn(p); } finally { await closePage(p); }
    })).value;
  };

  const close = async () => { await infrastructure('session-teardown', () => Promise.all([...open].map(closePage))); };
  return { url, page, freshPage, withFreshPage, close };
}

module.exports = { launchBrowser, openPage, openSession, loadLazyContent };
