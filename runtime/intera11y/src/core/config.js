'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '../../../..');
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}
const installedChrome = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => fs.existsSync(p));
const CONFIG = {
  root: ROOT,
  chromePath: process.env.CHROME_PATH || installedChrome,
  viewport: { width: 1280, height: 900, deviceScaleFactor: 1 },
  navTimeoutMs: 30000,
  lazyLoadMaxMs: 8000,
  navQuietMs: 2000,
  navQuietMaxMs: 15000,
  settleFloorMs: 150,
  unitDeadlineMs: Number(process.env.INTERA11Y_UNIT_DEADLINE_MS || 600000),
  probeDeadlineMs: Number(process.env.INTERA11Y_PROBE_DEADLINE_MS || 1800000),
  probeProfile: 'combined',
  pageDeadlineMs: 0,
  screen: { enabled: true },
  judge: {
    provider: 'openrouter',
    model: process.env.INTERA11Y_MODEL,
    effort: process.env.INTERA11Y_EFFORT || 'high',
    rubric: 'v2',
    tools: true,
    toolCalls: { perCandidate: 2, min: 4, max: 24 },
    batchTokenBudget: 24000,
    maxImagesPerBatch: 24,
    maxCandidatesPerBatch: 12,
    concurrency: Number(process.env.INTERA11Y_LLM_CONC || 16),
  },
};
module.exports = { CONFIG };
