'use strict';

const { SYSTEM, ANSWER_SCHEMA, buildBatchMessage } = require('./prompt.js');
const { bindTools } = require('./tools.js');
const { CONFIG } = require('../core/config.js');
const { Deadline } = require('../core/deadline.js');
const { parallel, timed, currentTimer, finalCallTime } = require('../core/timing.js');
const { evidenceProblem, terminalProviderError } = require('./evidence.js');

const VERDICTS = new Set(['FAIL', 'PASS', 'NOT_APPLICABLE', 'UNDETERMINED']);

function estimateTokens(c) {
  const t = JSON.stringify(c.facts || {}).length + ((c.element && c.element.openTag) || '').length + 200;
  return Math.ceil(t / 4) + (c.images || []).filter((x) => x && x.data).length * 700;
}

function batches(cands, maxPerBatch = CONFIG.judge.maxCandidatesPerBatch, context = []) {
  const out = [];
  const contextTokens = context.reduce((n,c)=>n+estimateTokens(c),0);
  const contextImages = context.reduce((n,c)=>n+(c.images||[]).filter(x=>x?.data).length,0);
  let cur = [], tok = contextTokens, imgs = contextImages;
  for (const c of cands) {
    const t = estimateTokens(c);
    const n = (c.images || []).filter((x) => x && x.data).length;
    if (cur.length && (tok + t > CONFIG.judge.batchTokenBudget || imgs + n > CONFIG.judge.maxImagesPerBatch || cur.length >= maxPerBatch)) { out.push(cur); cur = []; tok = contextTokens; imgs = contextImages; }
    cur.push(c); tok += t; imgs += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

function parseAnswer(text) {
  const sources = [...String(text).matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1]).reverse();
  sources.push(String(text));
  const salvaged = new Map();
  for (const s of sources) {
    for (let start = s.indexOf('{'); start >= 0; start = s.indexOf('{', start + 1)) {
      let depth = 0, inStr = false, esc = false;
      const opens = [];
      let end = -1;
      for (let i = start; i < s.length; i++) {
        const ch = s[i];
        if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
        if (ch === '"') inStr = true;
        else if (ch === '{') { depth++; opens.push(i); }
        else if (ch === '}') {
          const o = opens.pop();
          try { const v = JSON.parse(s.slice(o, i + 1)); if (v && (typeof v.path === 'string' || typeof v.id === 'string') && typeof v.verdict === 'string' && !salvaged.has(v.id || v.path)) salvaged.set(v.id || v.path, v); } catch (e) {                            }
          if (--depth === 0) { end = i; break; }
        }
      }
      if (end < 0) break;
      try { const v = JSON.parse(s.slice(start, end + 1)); if (v && Array.isArray(v.candidates)) return v; } catch (e) {                           }
      start = end;
    }
  }
  return salvaged.size ? { candidates: [...salvaged.values()], partial: true } : null;
}

const norm = (p) => String(p || '').trim();

const budgetFor = (n) => Math.max(CONFIG.judge.toolCalls.min, Math.min(CONFIG.judge.toolCalls.max, CONFIG.judge.toolCalls.perCandidate * n));

const REJUDGE_ROUNDS = Math.max(0, Number(process.env.INTERA11Y_REJUDGE_ROUNDS ?? 1));

async function judgeCandidates(args) {
  const call = await timed(() => judgeWork(args), { name: 'judge-stage' });
  return { ...call.value, timing: call.timing };
}

async function judgeWork({ criterion, page, session, candidates, client, llmPool, trace, context = [] }) {
  candidates = candidates.map((c,i)=>({...c,id:`c${String(i+1).padStart(4,'0')}`}));
  const stageTimer = currentTimer(), callNodes = [], previousCalls = new Map();
  const results = new Map();
  const pageFindings = [];
  const usage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: 0, batches: 0, rejudged: 0 };
  const tools = CONFIG.judge.tools ? bindTools(session, criterion.tools || []) : null;
  let terminalError = null, transportError = null;
  const rejectedAnswers = new Map();
  let bi = 0;
  const judgeBatch = async (batch, round) => {
    const b = bi++;
    const timer = currentTimer();
    const startedAt = timer.clock();
    timer.name = `judge-batch-${b}`;
    const parentIds = [...new Set(batch.map((c) => previousCalls.get(c.path)).filter(Boolean))];
    for (const c of batch) previousCalls.set(c.path, timer.id);
    const deadline = client.usesActivityTimeout ? null : new Deadline(CONFIG.unitDeadlineMs * batch.length);
    const blocks = buildBatchMessage(criterion, page, batch, context);
    const corrections = batch.map(c => rejectedAnswers.get(c.path)).filter(Boolean);
    if (corrections.length) blocks.push({ type: 'text', text: `Previous answers were rejected: ${[...new Set(corrections)].join('; ')}. Gather the missing evidence with actual tools or return UNDETERMINED.` });
    const observations = [];
    const recordedTools = tools && { declarations: tools.declarations, call: async (name, args) => {
      const value = await tools.call(name, args);
      if (value) observations.push({ name, args, result: value });
      return value;
    } };
    const validation = answer => {
      const parsed = parseAnswer(answer);
      if (!parsed) return null;
      for (const v of [...(parsed.candidates || []), ...(parsed.pageFindings || [])]) {
        const c = batch.find(c => c.id === v.id || (!v.id && norm(c.path) === norm(v.path)));
        const problem = evidenceProblem(v, criterion.tools, observations, c);
        if (problem) return problem;
      }
      if ((parsed.pageFindings || []).some(f => !VERDICTS.has(f.verdict))) return 'pageFindings entries require an explicit verdict; passing observations are not failures';
      return null;
    };
    const toolTrace = [];
    const log = trace && ((ev) => trace({ kind: 'turn', sc: criterion.sc, stage: 'judge', batch: b, round, ...(ev.turn === 'prompt' ? { candidates: batch.map((c) => c.path) } : {}), ...ev }));
    const res = await client.converse({ system: SYSTEM,
      blocks, tools: recordedTools, toolBudget: tools ? budgetFor(batch.length) : 0, deadline,
      trace: (t) => toolTrace.push(t), log, validateAnswer: validation,
      responseSchema: ANSWER_SCHEMA });
    if (terminalProviderError(res.error)) terminalError = res.error;
    if (res.error) transportError = res.error;
    const parsed = res.text ? parseAnswer(res.text) : null;
    usage.batches++; usage.toolCalls += res.toolCalls || 0;
    if (round) usage.rejudged += batch.length;
    require('./usage.js').addUsage(usage, res.usage);
    if (trace) trace({ sc: criterion.sc, batch: b, round, size: batch.length, toolCalls: res.toolCalls, tools: toolTrace, error: res.error || (parsed ? (parsed.partial ? 'partial-answer' : null) : 'unparseable'), answer: res.text ? res.text.slice(0, 20000) : null });
    const why = res.error || (parsed ? 'candidate missing from answer' : 'unparseable answer');
    const byPath = new Map(((parsed && parsed.candidates) || []).filter((v) => v && VERDICTS.has(v.verdict)).map((v) => [norm(v.path), v]));
    const byId = new Map(((parsed && parsed.candidates) || []).filter(v=>v && VERDICTS.has(v.verdict) && typeof v.id==='string').map(v=>[v.id,v]));

    for (const c of batch) {
      const v=byId.get(c.id);
      if (v) byPath.set(norm(c.path),v);
      else if (byPath.get(norm(c.path))?.id) byPath.delete(norm(c.path));
      const answer = byPath.get(norm(c.path));
      const problem = answer && evidenceProblem(answer, criterion.tools, observations, c);
      if (problem) {
        byPath.delete(norm(c.path)); rejectedAnswers.set(c.path, problem);
        if (trace) trace({ kind: 'evidence-rejected', sc: criterion.sc, batch: b, round, path: c.path, reason: problem });
      }
    }
    const finalLeaf = !res.error && batch.every((c) => byPath.has(norm(c.path)));
    if (!finalLeaf) timer.exclude(round < REJUDGE_ROUNDS ? 'failed-or-superseded-judge-batch' : 'failed-final-judge-batch');
    callNodes.push({ timer, startedAt, finishedAt: timer.clock(), batch: b, round, parentIds, finalLeaf });
    for (const c of batch) {
      const v = byPath.get(norm(c.path));
      results.set(c.path, v && !res.error ? { verdict: v.verdict, evidence: v.evidence || '', reason: v.reason || '', toolCalls: res.toolCalls, ...(round ? { round } : {}) } : { verdict: 'NO_VERDICT', reason: res.error || rejectedAnswers.get(c.path) || why });
    }

    if (finalLeaf) for (const f of (parsed && parsed.pageFindings) || []) if (f && (f.reason || f.evidence)) {
      const problem = evidenceProblem(f, criterion.tools, observations);
      pageFindings.push({ xpath: f.path || null, verdict: !problem && VERDICTS.has(f.verdict) ? f.verdict : 'UNDETERMINED', reason: problem || f.reason || '', evidence: f.evidence || '' });
    }
  };
  let pending = candidates;
  let max = CONFIG.judge.maxCandidatesPerBatch;
  for (let round = 0; round <= REJUDGE_ROUNDS && pending.length; round++) {
    await parallel(batches(pending, max, context).map((batch) => () => llmPool(() => judgeBatch(batch, round))));
    if (terminalError || transportError) break;
    pending = candidates.filter((c) => results.get(c.path) && results.get(c.path).verdict === 'NO_VERDICT');
    max = Math.max(1, Math.ceil(max / 2));
  }
  usage.failedCalls = candidates.filter(c => results.get(c.path)?.verdict === 'NO_VERDICT').length;
  stageTimer.processingOverrideMs = finalCallTime(callNodes);
  const callTimings = callNodes.map((c) => ({ batch: c.batch, round: c.round, id: c.timer.id, parentIds: c.parentIds, finalLeaf: c.finalLeaf, timing: c.timer.snapshot() }));
  if (trace) trace({ kind: 'timing', sc: criterion.sc, stage: 'judge-calls', reduction: 'sum-of-max-concurrent-final-leaves', calls: callTimings });
  return { results, pageFindings, usage, callTimings };
}

module.exports = { judgeCandidates, parseAnswer };
