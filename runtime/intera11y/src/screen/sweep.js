'use strict';

const { key } = require('../lib/xpath.js');
const { load } = require('../judge/rubric.js');
const { isRendered } = require('../model/page-model.js');
const { Deadline } = require('../core/deadline.js');
const { CONFIG } = require('../core/config.js');
const { parallel, timed, currentTimer, finalCallTime } = require('../core/timing.js');
const { terminalProviderError } = require('../judge/evidence.js');

const SYSTEM = `You are an accessibility tester planning a WCAG 2.2 evaluation of one web page.

You receive one success criterion with its test rules, a screenshot of the page's first viewport (1280×900 CSS px), and elements of the page. Each element is prefixed with a [path: …] label giving its XPath, followed by its opening tag, its own text, its computed accessibility role and name, and its box on the page (width×height at x,y in CSS px).

Select the elements that should be tested against this criterion: elements the criterion applies to whose conformance the information here does not already settle — both those that look like failures and those you cannot decide. Leave out elements the criterion does not apply to and elements the information here already shows to conform. Selecting an element is not a verdict: every selected element is tested afterwards on the running page, where it can pass or fail.

Respond with ONLY a JSON object (no markdown, no prose):
{"elements":[{"path":"<XPath copied verbatim from a [path: …] label>","aspect":"<what about this element needs testing, one sentence>"}]}
Return {"elements":[]} if no element needs testing.`;

const CHUNK_TOKENS = 18000;

const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

function line(e) {
  const ax = e.ax || {};
  const flags = [];
  if (e.tabindex !== null && e.tabindex !== undefined) flags.push(`tabindex=${e.tabindex}`);
  else if (e.nativeFocusable) flags.push('focusable');
  if (e.listeners) flags.push(`listeners=${e.listeners}`);
  if (e.inlineHandlers && e.inlineHandlers.length) flags.push(`handlers=${e.inlineHandlers.join(',')}`);
  if (e.cursorPointer) flags.push('pointer-cursor');
  if (e.disabled) flags.push('disabled');
  if (e.ariaHiddenSelf || e.ariaHiddenAncestor) flags.push('aria-hidden');
  if (e.visuallyHidden) flags.push('visually-hidden');
  if (e.inShadow) flags.push('in-shadow-root');
  const r = e.rect || {};
  return `[path: ${e.xpath}] ${clip(e.openTag, 220)}${e.text ? ` text="${clip(e.text, 120)}"` : ''} | role=${ax.role || '—'} name="${clip(ax.name, 100)}"${ax.ignored ? ' (ignored by AT)' : ''} | box=${r.w}×${r.h}@${r.x},${r.y}${flags.length ? ' | ' + flags.join(' ') : ''}`;
}

function chunks(lines) {
  const out = [];
  let cur = [], tok = 0;
  for (const l of lines) {
    const t = Math.ceil(l.length / 4);
    if (cur.length && tok + t > CHUNK_TOKENS) { out.push(cur); cur = []; tok = 0; }
    cur.push(l); tok += t;
  }
  if (cur.length) out.push(cur);
  return out;
}

const SELECTION_SCHEMA = {
  type: 'object',
  properties: { elements: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, aspect: { type: 'string' } }, required: ['path', 'aspect'], additionalProperties: false } } },
  required: ['elements'],
  additionalProperties: false,
};

function parse(text) {
  const s = String(text || '').replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch (e) {                     } }
  const elements = [];
  for (const m of s.matchAll(/\{\s*"path"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"aspect"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g)) {
    try { elements.push({ path: JSON.parse(`"${m[1]}"`), aspect: JSON.parse(`"${m[2]}"`) }); } catch (e) {            }
  }
  return elements.length ? { elements, partial: true } : null;
}

const SPLIT_MIN = 10;

async function sweep(args) {
  const call = await timed(() => sweepWork(args), { name: 'screen-stage' });
  return { ...call.value, timing: call.timing };
}

async function sweepWork({ criterion, model, client, llmPool, trace }) {
  const stageTimer = currentTimer();
  const callNodes = [], parents = new WeakMap(), formatRepairs = new WeakMap();
  const usage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const proposals = new Map();
  const spec = criterion.screen;
  if (!spec) return { proposals, selected: 0, unknownPaths: 0, calls: 0, failedCalls: 0, usage };

  const pool = model.elements.filter((e) => isRendered(e) && spec.select(e, model));
  const byKey = new Map(model.elements.map((e) => [key(e.xpath), e]));
  const head = `Success criterion: SC ${criterion.sc} ${criterion.title}\nTest rules:\n${load(criterion.sc).rules.map((r, i) => `${i + 1}. ${r.text}`).join('\n')}\n\nPage: ${model.doc.url} — title ${JSON.stringify(model.doc.title || '')}\n------------------\nElements (${pool.length} on the page of the kinds this criterion concerns${'{N}'}):\n`;
  const parts = chunks(pool.map(line));
  let unknownPaths = 0, failedCalls = 0, calls = 0, ci = 0, terminalError = null;
  const run = async (part) => {
    const i = ci++;
    const timer = currentTimer();
    const startedAt = timer.clock();
    timer.name = `screen-chunk-${i}`;
    calls++;
    const deadline = client.usesActivityTimeout ? null : new Deadline(CONFIG.unitDeadlineMs);
    const blocks = [{ type: 'text', text: head.replace('{N}', parts.length > 1 ? `; part ${i + 1}` : '') + part.join('\n') }];
    if (model.screenshot) blocks.push({ type: 'image', data: model.screenshot, mime: 'image/png' });
    if (formatRepairs.has(part)) blocks.push({ type: 'text', text:
      'Your previous response was not valid JSON. Return the same selection in the prescribed JSON schema, '
      + 'escaping quotation marks inside strings as \\". Do not add prose. Previous response:\n'
      + formatRepairs.get(part).slice(0, 8000) });
    const res = await client.converse({ system: SYSTEM, blocks, deadline, responseSchema: SELECTION_SCHEMA, log: trace && ((ev) => trace({ kind: 'turn', sc: criterion.sc, stage: 'screen', chunk: i, ...ev })) });
    if (terminalProviderError(res.error)) terminalError = res.error;
    require('../judge/usage.js').addUsage(usage, res.usage);
    const parsed = res.text ? parse(res.text) : null;
    const got = [];
    for (const x of (!res.error && parsed && parsed.elements) || []) {

      let p = String((x && x.path) || '').trim();
      const label = /^\[path:\s*(.*)\]$/.exec(p);
      if (label) p = label[1].trim();
      const e = byKey.get(key(p));
      if (!e) { unknownPaths++; continue; }
      if (!proposals.has(e.xpath)) proposals.set(e.xpath, clip(x.aspect, 300));
      got.push(e.xpath);
    }
    const incomplete = !!res.error || !parsed || !Array.isArray(parsed.elements) || parsed.partial;

    const split = incomplete && !res.error && part.length >= 2 * SPLIT_MIN;
    const repair = incomplete && !res.error && !split && !formatRepairs.has(part);
    const finalLeaf = !split && !incomplete && !res.error;
    if (!finalLeaf) timer.exclude(split ? 'superseded-by-split' : repair ? 'superseded-by-format-repair' : 'failed-screen-call');
    callNodes.push({ timer, startedAt, finishedAt: timer.clock(), chunk: i, parentId: parents.get(part) || null, finalLeaf });
    if (trace) trace({ sc: criterion.sc, stage: 'screen', chunk: i, elements: part.length, selected: got.length, error: res.error || (!parsed ? 'unparseable' : parsed.partial ? 'partial-answer' : null), resent: split || undefined, answer: res.text ? res.text.slice(0, 8000) : null });
    if (split) {
      const h = Math.ceil(part.length / 2), children = [part.slice(0, h), part.slice(h)];
      for (const child of children) parents.set(child, timer.id);
      return children;
    }
    if (repair) {
      formatRepairs.set(part, res.text || 'Empty answer');
      parents.set(part, timer.id);
      return [part];
    }
    if (incomplete) failedCalls++;
    return [];
  };

  for (let queue = parts; queue.length && !terminalError;) queue = (await parallel(queue.map((part) => () => llmPool(() => run(part))))).flat();
  stageTimer.processingOverrideMs = finalCallTime(callNodes);
  const callTimings = callNodes.map((c) => ({ chunk: c.chunk, id: c.timer.id, parentId: c.parentId, finalLeaf: c.finalLeaf, timing: c.timer.snapshot() }));
  if (trace) trace({ kind: 'timing', sc: criterion.sc, stage: 'screen-calls', reduction: 'sum-of-max-concurrent-final-leaves', calls: callTimings });
  return { proposals, pool: pool.length, selected: proposals.size, unknownPaths, calls, failedCalls, usage, callTimings };
}

module.exports = { sweep, SYSTEM, parse };
