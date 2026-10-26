'use strict';

const { openSession, loadLazyContent } = require('./session.js');
const { CONFIG } = require('./config.js');
const { buildPageModel } = require('../model/page-model.js');
const { makeProbeRunner } = require('../probes/index.js');
const { CRITERIA } = require('../criteria/index.js');
const { judgeCandidates } = require('../judge/judge.js');
const { resolveCriterion } = require('./resolve.js');
const { sweep } = require('../screen/sweep.js');
const screened = require('../screen/screened.js');
const { key, within } = require('../lib/xpath.js');
const { PAGE } = require('../criteria/common.js');
const { timed, parallel } = require('./timing.js');

async function evaluateCriterion(args) {
  const { value, timing } = await timed(() => evaluateDesigned(args));
  if (args.trace) args.trace({ kind: 'timing', sc: args.criterion.sc, stage: 'criterion', timing });
  return { ...value, timing };
}

async function evaluateDesigned({ criterion, session, model, probes, client, llmPool, trace, targets = null }) {
  const t0 = Date.now();

  const [obs, screen] = await parallel([
    () => probes.get(criterion.probes),
    () => CONFIG.screen.enabled ? sweep({ criterion, model, client, llmPool, trace }) : null,
  ]);
  const coverage = Object.fromEntries(Object.entries(obs).map(([k, v]) => [k, { completeness: v.completeness, reason: v.reason, ms: v.ms, timing: v.timing }]));
  if (screen) coverage.screen = { completeness: screen.failedCalls ? 'truncated' : 'complete', reason: screen.failedCalls ? `${screen.failedCalls} of ${screen.calls} sweep calls gave no answer` : undefined };

  const proposals = new Map([...((screen && screen.proposals) || new Map())].map(([x, aspect]) => [key(x), { xpath: x, aspect }]));
  const seen = new Set();
  const native = criterion.identify(model, obs).filter((c) => { const k = `${c.xpath}|${c.kind}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .map((c) => ({ ...c, origin: proposals.has(key(c.xpath)) ? 'rules+screen' : 'rules' }));
  const nativeKeys = new Set(native.map((c) => key(c.xpath)));
  const selectedOnly = [...proposals.values()].filter((p) => !nativeKeys.has(key(p.xpath)));

  const pageCands = criterion.screen && criterion.screen.scope === 'page' ? native.filter((c) => c.xpath === PAGE) : [];
  for (const c of pageCands) { c.screenNotes = selectedOnly; if (selectedOnly.length) c.origin = 'rules+screen'; }
  const screenedOnly = pageCands.length ? [] : selectedOnly.map((p) => ({ xpath: p.xpath, kind: 'screened', aspect: p.aspect, origin: 'screen' }));
  let raw = [...native, ...screenedOnly];

  if (targets && !targets.page) raw = raw.filter((c) => { const k = key(c.xpath); return [...targets.keys].some((t) => within(k, t)); });
  const counts = new Map();
  for (const c of raw) counts.set(c.xpath, (counts.get(c.xpath) || 0) + 1);

  const candidates = raw.map((c) => ({ ...c, key: c.xpath == null ? `page#${c.kind}` : counts.get(c.xpath) > 1 ? `${c.xpath}#${c.kind}` : c.xpath }));
  const assessed = candidates.map((c) => ({ ...c, assessment: c.kind === 'screened' ? screened.assess(c, criterion, obs, model) : criterion.assess(c, obs, model) }));
  const open = assessed.filter((c) => c.assessment.status === 'OPEN');
  if (CONFIG.probeProfile !== 'baseline' || process.env.INTERA11Y_PROBE_AUDIT === '1') {
    if (trace) trace({ kind: 'probe-audit', sc: criterion.sc, profile: CONFIG.probeProfile,
      native: native.map(c => ({ xpath: c.xpath, kind: c.kind })),
      assessed: assessed.map(c => ({ xpath: c.xpath, kind: c.kind, origin: c.origin, assessment: c.assessment })),
      acquisition: Object.fromEntries(Object.entries(obs).map(([n, p]) => [n, p.acquisition])) });
  }
  let judged = { results: new Map(), pageFindings: [], usage: null };
  if (open.length) {
    const cards = open.map((c) => {
      const ev = c.kind === 'screened' ? screened.evidence(c, obs, model) : criterion.evidence(c, obs, model);
      if (c.screenNotes && c.screenNotes.length) ev.facts = { ...ev.facts, elementsAScreeningPassSelectedForTesting: { note: 'selected for testing, not findings', elements: c.screenNotes.map((p) => ({ path: p.xpath, aspect: p.aspect })) } };
      return { path: c.key, element: model.get(c.xpath), ...ev };
    });

    const context = criterion.sc === '2.4.3' ? native.filter(c=>c.kind==='tab-sequence').map(c=>({
      path:'page#tab-sequence', ...criterion.evidence(c,obs,model),
    })) : [];
    judged = await judgeCandidates({ criterion, page: model, session, candidates: cards, client, llmPool, trace, context });
  }
  const screenCost = screen ? screen.usage.costUsd : 0;
  return resolveCriterion({
    criterion, assessed, judged, coverage, ms: Date.now() - t0,
    costUsd: (judged.usage ? judged.usage.costUsd : 0) + screenCost, usage: judged.usage,
    screen: screen && { pool: screen.pool, calls: screen.calls, failedCalls: screen.failedCalls, selected: screen.selected, unknownPaths: screen.unknownPaths, screenedOnly: screenedOnly.length, usage: screen.usage },
  });
}

async function evaluatePage({ browser, url, scs, client, llmPool, trace, targets = null }) {
  let session;
  try {
    const { value, timing } = await timed(async () => {
      const t0 = Date.now();
      session = await openSession(browser, url);
      try {
        await loadLazyContent(session.page);
        const model = await buildPageModel(session.page);
        const probes = makeProbeRunner(session, model, { scs, targets });
        const criteria = {};
        await parallel(scs.filter((sc) => CRITERIA[sc]).map((sc) => async () => {
          try {
            criteria[sc] = await evaluateCriterion({ criterion: CRITERIA[sc], session, model, probes, client, llmPool, trace: trace && ((ev) => trace({ url, ...ev })), targets: targets ? targets[sc] || { page: false, keys: new Set() } : null });
          } catch (e) {
            criteria[sc] = { verdict: 'INCOMPLETE', error: String((e && e.stack) || e).slice(0, 800), findings: [], candidates: [], timing: e && e.timing || null };
            if (trace) trace({ kind: 'timing', sc, stage: 'failed-criterion', timing: e && e.timing || null });
          }
        }));
        return { url, doc: model.doc, elements: model.elements.length, modelTruncated: model.truncated, criteria, ms: Date.now() - t0 };
      } finally { await session.close(); session = null; }
    }, { recordTree: true });
    if (trace) trace({ kind: 'timing', stage: 'page', timing });
    return { ...value, timing };
  } finally { if (session) await session.close(); }
}

module.exports = { evaluatePage };
