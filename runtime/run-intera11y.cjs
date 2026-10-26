'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { CONFIG } = require('./intera11y/src/core/config.js');
const { SCS } = require('./intera11y/src/criteria/index.js');
const { key, within } = require('./intera11y/src/lib/xpath.js');
const { makeOpenRouterClient } = require('./intera11y/src/judge/openrouter.js');
const { timed, infrastructure, resourceWait } = require('./intera11y/src/core/timing.js');
const { addUsage } = require('./intera11y/src/judge/usage.js');

function combineDeterministic(base, full) {
  if (!base || !full) throw new Error('Both the baseline and full InterA11y result are required');
  if (base.sc && full.sc && base.sc !== full.sc) throw new Error('Results must concern the same criterion');
  if (base.url && full.url && base.url !== full.url) throw new Error('Results must concern the same page');
  const candidates = full.candidates || [];
  const deterministic = candidates.filter(c => String(c.source || '').startsWith('rule:'));
  const failures = deterministic.filter(c => c.status === 'FAIL');
  const nonfailure = candidates.length > 0 && deterministic.length === candidates.length
    && deterministic.every(c => ['PASS', 'NOT_APPLICABLE'].includes(c.status))
    && ['PASS', 'NOT_APPLICABLE'].includes(full.verdict);
  const route = failures.length ? 'deterministic-failure' : nonfailure ? 'deterministic-nonfailure' : 'baseline';
  const flagged = failures.length > 0 || (Boolean(base.flagged) && !nonfailure);
  return {
    ...base,
    flagged,
    findings: failures.length ? failures.map(c => ({ sc: full.sc || base.sc, xpath: c.xpath, reason: c.reason, source: c.source })) : nonfailure ? [] : base.findings || [],
    verdict: failures.length ? 'FAIL' : nonfailure ? full.verdict : base.verdict,
    state: route === 'baseline' ? base.state : 'complete',
    usage: null,
    timing: null,
    combination: { method: 'deterministic-first', route },
  };
}

function targetsFor(sc, targets) {
  if (!targets || !targets.length || targets.some(t => t.scope === 'page')) return null;
  if (targets.some(t => typeof t.xpath !== 'string' || !t.xpath)) throw new Error('Every element target requires an XPath');
  return { [sc]: { page: false, keys: new Set(targets.map(t => key(t.xpath))) } };
}

function resolveModel(value) {
  const aliases = { gemini: 'GEMINI', openai: 'OPENAI', claude: 'CLAUDE', glm: 'GLM' };
  if (!value) throw new Error('A model alias or OpenRouter model identifier is required');
  if (aliases[value]) {
    const model = process.env[`OPENROUTER_MODEL_${aliases[value]}`];
    if (!model) throw new Error(`OPENROUTER_MODEL_${aliases[value]} is not set`);
    return model;
  }
  if (!value.includes('/')) throw new Error('Use a configured model alias or a provider/model OpenRouter identifier');
  return value;
}

function makePool(limit) {
  let active = 0;
  const waiting = [];
  return async task => {
    await resourceWait('model-queue', () => new Promise(resolve => {
      if (active < limit) { active++; resolve(); }
      else waiting.push(resolve);
    }));
    try { return await task(); }
    finally {
      if (waiting.length) waiting.shift()();
      else active--;
    }
  };
}

async function run(input, dependencies = {}) {
  if (!input || typeof input.url !== 'string' || !/^(https?:|file:|data:)/.test(input.url)) throw new Error('url must be an HTTP(S), file, or data URL');
  if (!SCS.includes(input.sc)) throw new Error(`Unsupported success criterion: ${input.sc}`);
  const condition = input.condition || 'intera11y';
  if (!['intera11y', 'full', 'ia-2'].includes(condition)) throw new Error('This runtime executes full InterA11y. Use the GenA11y adapter for Rubrics Only and the offline deterministic combiner for the two deterministic ablations.');
  const options = input.options || {};
  const model = dependencies.client ? input.model || 'test-client' : resolveModel(input.model);
  CONFIG.judge.model = model;
  CONFIG.judge.effort = options.effort || CONFIG.judge.effort;
  CONFIG.screen.enabled = options.screen !== false;
  CONFIG.judge.tools = true;
  const records = [];
  const trace = event => records.push(event);
  const pool = makePool(Math.max(1, Number(options.llmConcurrency || CONFIG.judge.concurrency)));
  const client = dependencies.client || makeOpenRouterClient({ model, effort: CONFIG.judge.effort });
  const { evaluatePage } = require('./intera11y/src/core/run-page.js');
  const { launchBrowser } = require('./intera11y/src/core/session.js');
  let browser;
  const execution = await timed(async () => {
    browser = await infrastructure('browser-launch', dependencies.launchBrowser || launchBrowser);
    try {
      return await evaluatePage({ browser, url: input.url, scs: [input.sc], client, llmPool: pool, trace,
        targets: targetsFor(input.sc, input.targets) });
    } finally {
      await infrastructure('browser-teardown', () => browser.close());
    }
  }, { recordTree: true });
  const criterion = execution.value.criteria[input.sc];
  const usage = {};
  addUsage(usage, criterion.judgeUsage);
  addUsage(usage, criterion.screen && criterion.screen.usage);
  const targets = targetsFor(input.sc, input.targets);
  const relevant = (criterion.findings || []).filter(f => !targets || (f.xpath != null && [...targets[input.sc].keys].some(t => within(key(f.xpath), t))));
  const result = { url: input.url, sc: input.sc, condition, model, flagged: relevant.length > 0,
    findings: relevant.map(f => ({ sc: input.sc, ...f })), verdict: criterion.verdict,
    state: criterion.verdict === 'INCOMPLETE' ? 'incomplete' : 'complete',
    candidates: criterion.candidates || [], coverage: criterion.coverage || {}, usage,
    timing: execution.timing, error: criterion.error || null };
  if (input.outputDir) {
    fs.mkdirSync(input.outputDir, { recursive: true });
    fs.writeFileSync(path.join(input.outputDir, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    fs.writeFileSync(path.join(input.outputDir, 'trace.jsonl'), records.map(e => JSON.stringify(e)).join('\n') + '\n');
    fs.writeFileSync(path.join(input.outputDir, 'page.json'), JSON.stringify(execution.value, null, 2) + '\n');
  }
  return result;
}

if (require.main === module) {
  let source = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', data => { source += data; });
  process.stdin.on('end', async () => {
    try { process.stdout.write(JSON.stringify(await run(JSON.parse(source))) + '\n'); }
    catch (error) { process.stdout.write(JSON.stringify({ state: 'error', flagged: false, findings: [], error: String(error.message || error), usage: null, timing: null }) + '\n'); process.exitCode = 1; }
  });
}
module.exports = { run, combineDeterministic, resolveModel, targetsFor, SCS };
