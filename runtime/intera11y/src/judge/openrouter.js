'use strict';

const { bounded } = require('../core/deadline.js');
const { blocked, recordTerminal, terminalCode } = require('../core/execution-health.js');
const { readCompletion } = require('./openrouter-stream.js');

const BASE = 'https://openrouter.ai/api/v1';
const REASONING = { minimal: 'low', low: 'low', medium: 'medium', high: 'high' };
const { resourceWait, timed, currentTimer } = require('../core/timing.js');
const sleep = (ms) => resourceWait('provider-backoff', () => new Promise((r) => setTimeout(r, ms)));
const backoff = (attempt) => Math.min(60000, 2000 * 2 ** attempt) * (1 + Math.random() * 0.3);
const TOOL_CALL_MS = 3 * 60 * 1000;
const MAX_ARG_RETRIES = Math.max(0, Number(process.env.A11Y_ARGUMENT_REPAIRS ?? 1));
const HTTP_ATTEMPTS = Math.max(1, Number(process.env.A11Y_HTTP_MAX_ATTEMPTS || 2));
const ANSWER_REPAIRS = Math.max(0, Number(process.env.A11Y_ANSWER_REPAIRS ?? 1));

function toContent(blocks) {
  return blocks.map((b) => (b.type === 'image'
    ? { type: 'image_url', image_url: { url: `data:${b.mime || 'image/png'};base64,${b.data}` } }
    : { type: 'text', text: b.text }));
}

function splitImages(obj, images, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return obj;
  if (Array.isArray(obj)) return obj.map((v) => splitImages(v, images, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && v.length > 1000 && /^(iVBORw0KGgo|\/9j\/)/.test(v)) {
      images.push({ mime: v.startsWith('/9j/') ? 'image/jpeg' : 'image/png', data: v });
      out[k] = `[image #${images.length} attached]`;
    } else if (typeof v === 'string' && v.startsWith('data:image/') && v.length > 1000) {
      const m = /^data:(image\/[a-z]+);base64,(.*)$/.exec(v);
      if (m) { images.push({ mime: m[1], data: m[2] }); out[k] = `[image #${images.length} attached]`; } else out[k] = v;
    } else out[k] = splitImages(v, images, depth + 1);
  }
  return out;
}

function makeOpenRouterClient({ apiKey = process.env.OPENROUTER_API_KEY, model, effort = 'high', maxOutputTokens,
  requestIdleMs = Number(process.env.A11Y_HTTP_IDLE_TIMEOUT_MS || 600000), onUsage } = {}) {
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');
  const usage = { calls: 0, requestAttempts: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0, cachedTokens: 0, cacheWriteTokens: 0,
    costUsd: 0, apiCostUsd: 0, missingApiCostCalls: 0, missingThinkingCalls: 0, missingCachedTokenCalls: 0,
    outputIncludesThinking: true, costSource: 'openrouter-api-reported', toolCalls: 0 };
  const reasoning = REASONING[effort] || 'high';

  async function post(body, deadline, local) {
    const attempts = [];
    for (let attempt = 0; attempt < HTTP_ATTEMPTS; attempt++) {
      const hold = blocked();
      if (hold) return { error: hold.reason, attempts };
      const left = deadline ? deadline.remaining() : Infinity;
      if (left <= 0) return { error: 'deadline', attempts };
      const ctrl = new AbortController();
      let timer;
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => ctrl.abort(new Error('provider-stream-inactivity-timeout')),
          Math.min(deadline ? deadline.remaining() : Infinity, requestIdleMs));
      };
      arm();
      usage.requestAttempts++; local.requestAttempts++;
      try {
        let requestTimer;
        const call = await timed(async () => {
          requestTimer = currentTimer();
          const r = await fetch(`${BASE}/chat/completions`, {
            method: 'POST', signal: ctrl.signal,
            headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...body, stream: true }),
          });
          arm();
          return r.ok ? { response: r, json: await readCompletion(r, arm) } : { response: r, text: await r.text() };
        }, { kind: 'llm', name: 'openrouter-http-attempt', accept: (r) => r.response.ok && !(r.json && (r.json.error || r.json.choices?.[0]?.finish_reason === 'error')) });
        const r = call.value.response;
        attempts.push({ attempt, status: r.status, timing: call.timing });
        if (r.status === 429 || r.status >= 500) { if (attempt + 1 < HTTP_ATTEMPTS) await sleep(backoff(attempt)); continue; }
        if (!r.ok) {
          recordTerminal({ code: r.status });
          return { error: `http-${r.status}: ${call.value.text.slice(0, 300)}`, attempts };
        }
        const j = call.value.json;
        const finishReason = j.choices?.[0]?.finish_reason;
        Object.assign(attempts[attempts.length - 1], { finishReason, generationId: j.id, provider: j.provider });
        const u = j.usage || {};
        const inTok = u.prompt_tokens || 0;
        const outTok = u.completion_tokens || 0;
        const thought = (u.completion_tokens_details || {}).reasoning_tokens ?? null;
        const cached = (u.prompt_tokens_details || {}).cached_tokens ?? null;
        const writes = (u.prompt_tokens_details || {}).cache_write_tokens ?? null;
        const cost = typeof u.cost === 'number' ? u.cost : null;
        for (const x of [usage, local]) { if (!x) continue; x.calls++; x.inputTokens += inTok; x.outputTokens += outTok;
          for (const [key,value,missing] of [['thinkingTokens',thought,'missingThinkingCalls'],['cachedTokens',cached,'missingCachedTokenCalls'],['apiCostUsd',cost,'missingApiCostCalls']]) {
            if (value === null) x[missing]++; else x[key] += value;
          }
          x.cacheWriteTokens += writes || 0; x.costUsd += cost || 0;
        }
        const perCall = { inputTokens: inTok, outputTokens: outTok, thinkingTokens: thought, thoughtTokens: thought,
          visibleOutputTokens: thought === null || thought > outTok ? null : outTok-thought,
          inconsistentReasoningTokens: thought !== null && thought > outTok, cachedTokens: cached,
          cacheWriteTokens: writes, costUsd: cost, apiCostUsd: cost, generationId: j.id, provider: j.provider,
          model: j.model, rawUsage: u, outputIncludesThinking: true, costSource: 'openrouter-api-reported' };
        if (onUsage) onUsage(perCall);
        attempts[attempts.length - 1].usage = perCall;
        if (j && (j.error || finishReason === 'error')) {
          requestTimer.exclude('upstream-incomplete-response');
          attempts[attempts.length - 1].timing = requestTimer.snapshot();
          attempts[attempts.length - 1].error = j.error || 'provider-finish-error';
          if (recordTerminal(j)) return { error: `http-${terminalCode(j)}: ${JSON.stringify(j.error)}`, attempts };
          if (attempt + 1 < HTTP_ATTEMPTS) await sleep(backoff(attempt)); continue;
        }
        return { json: j, requestTiming: requestTimer.snapshot(), requestTimer, attempts, usage: perCall };
      } catch (e) {
        attempts.push({ attempt, error: String(e && e.message || e), timing: e && e.timing || null });
        if (deadline && deadline.expired()) return { error: 'deadline', attempts };
        if (attempt + 1 < HTTP_ATTEMPTS) await sleep(backoff(attempt));
      } finally { clearTimeout(timer); }
    }
    return { error: 'retries-exhausted', attempts };
  }

  async function converse({ system, blocks, tools, toolBudget = 0, deadline, trace, log, responseSchema, validateAnswer }) {
    const local = { calls: 0, requestAttempts: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0, cachedTokens: 0, cacheWriteTokens: 0,
      costUsd: 0, apiCostUsd: 0, missingApiCostCalls: 0, missingThinkingCalls: 0, missingCachedTokenCalls: 0,
      outputIncludesThinking: true, costSource: 'openrouter-api-reported' };
    const say = (ev) => { if (log) { try { log(ev); } catch (e) {                            } } };
    const done = (r) => {
      const unreported = local.requestAttempts-local.calls;
      const finalUsage = { ...local, calls: local.requestAttempts, unreportedRequestAttempts: unreported,
        reportedApiCostUsd: local.costUsd, apiCostUsd: unreported || local.missingApiCostCalls ? null : local.apiCostUsd,
        missingApiCostCalls: local.missingApiCostCalls+unreported,
        missingThinkingCalls: local.missingThinkingCalls+unreported,
        missingCachedTokenCalls: local.missingCachedTokenCalls+unreported };
      if (finalUsage.missingThinkingCalls) finalUsage.thinkingTokens = null;
      if (finalUsage.missingCachedTokenCalls) finalUsage.cachedTokens = null;
      say({ turn: 'end', error: r.error || null, toolCalls: r.toolCalls, finishReason: r.finishReason || null, usage: finalUsage });
      return { ...r, usage: finalUsage };
    };
    const messages = [{ role: 'system', content: system }, { role: 'user', content: toContent(blocks) }];
    const decls = tools && tools.declarations && tools.declarations.length
      ? tools.declarations.map((d) => ({ type: 'function', function: { name: d.name, description: d.description, parameters: d.parameters } })) : null;
    say({ turn: 'prompt', model, effort, toolBudget, tools: decls ? decls.map((d) => d.function.name) : [], system, blocks });
    let used = 0, lastFinish = null, argRetries = 0, answerRepairs = 0;
    for (let turn = 0; turn < toolBudget + 5; turn++) {
      const allowTools = decls && used < toolBudget;
      const body = { model, messages, temperature: 0, usage: { include: true }, reasoning: { effort: reasoning } };
      if (maxOutputTokens != null) body.max_tokens = maxOutputTokens;

      if (responseSchema && !allowTools) { body.response_format = { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema: responseSchema } }; }
      if (responseSchema || allowTools) body.provider = { require_parameters: true };
      if (allowTools) { body.tools = decls; body.tool_choice = 'auto'; }
      const t0 = Date.now();
      const res = await post(body, deadline, local);
      if (res.error) { say({ turn, error: res.error, ms: 0, elapsedMs: Date.now() - t0, attempts: res.attempts }); return done({ error: res.error, toolCalls: used }); }
      const ch = (res.json.choices || [])[0] || {};
      const m = ch.message || {};
      const calls = m.tool_calls || [];
      const parts = [
        ...(m.reasoning ? [{ thought: m.reasoning }] : []),
        ...(m.content ? [{ text: m.content }] : []),
        ...calls.map((c) => { let args; try { args = JSON.parse((c.function && c.function.arguments) || '{}'); } catch (e) { args = { unparseable: String((c.function && c.function.arguments) || '').slice(0, 2000) }; } return { toolCall: { name: c.function && c.function.name, args } }; }),
      ];
      say({ turn, role: 'model', toolsOffered: !!allowTools, parts, reasoningDetails: m.reasoning_details || null,
        finishReason: ch.finish_reason || 'no-choice', usage: res.usage, ms: res.requestTiming.successfulProcessingMs,
        timing: res.requestTiming, attempts: res.attempts, elapsedMs: Date.now() - t0 });
      if (calls.length && allowTools) {
        const parsed = [];
        let bad = null;
        for (const c of calls) { try { parsed.push({ c, args: JSON.parse((c.function && c.function.arguments) || '{}') }); } catch (e) { bad = (c.function && c.function.name) || '?'; break; } }
        if (bad) {
          if (argRetries++ < MAX_ARG_RETRIES) { say({ turn, role: 'harness', text: `re-asked: the arguments of ${bad} were not valid JSON` }); turn--; continue; }
          return done({ error: 'tool-args-unparseable', toolCalls: used });
        }
        messages.push({ role: 'assistant', content: m.content || null, tool_calls: calls,
          ...(m.reasoning ? { reasoning: m.reasoning } : {}),
          ...(m.reasoning_details ? { reasoning_details: m.reasoning_details } : {}) });
        const images = [];
        for (const { c, args } of parsed) {
          const name = c.function.name;
          const tt = Date.now();
          let result;
          let timing = null;
          if (used >= toolBudget) result = { error: 'tool budget exhausted — answer from the evidence you have' };
          else {
            used++; usage.toolCalls++;
            const ms = Math.min(TOOL_CALL_MS, deadline ? deadline.remaining() : TOOL_CALL_MS);
            try {
              const call = await timed(() => bounded(tools.call(name, args || {}), ms, { error: 'the tool did not finish within its time limit' }),
                { kind: 'tool', name, accept: (r) => !(r && r.error) });
              result = call.value; timing = call.timing;
            } catch (e) { result = { error: String((e && e.message) || e) }; timing = e && e.timing || null; }
          }
          const own = [];
          const clean = splitImages(result && typeof result === 'object' ? result : { result }, own);
          if (trace) trace({ tool: name, args, result: JSON.stringify(clean).slice(0, 4000), images: own.length, timing });
          say({ turn, role: 'tool', name, args: args || {}, result: clean, images: own.map((i) => i.data), ms: timing ? timing.accountedMs : 0, timing, elapsedMs: Date.now() - tt });
          messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(clean) });
          images.push(...own);
        }
        const extra = [];
        if (images.length) extra.push({ type: 'text', text: 'Images returned by the tool calls above, in order:' }, ...images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.data}` } })));
        if (used >= toolBudget) {
          const t = 'The tool budget is used up. Give your final answer now, in the required JSON format, from the evidence you have.';
          extra.push({ type: 'text', text: t });
          say({ turn, role: 'harness', text: t });
        }
        if (extra.length) messages.push({ role: 'user', content: extra });
        continue;
      }
      const text = m.content || '';
      if (text.trim()) {
        const problem = validateAnswer && validateAnswer(text);
        if (problem) res.requestTimer.exclude('unsupported-evidence-answer');
        if (problem && answerRepairs++ < ANSWER_REPAIRS) {
          messages.push({ role: 'assistant', content: text, ...(m.reasoning_details ? { reasoning_details: m.reasoning_details } : {}) });
          const correction = `The harness rejected unsupported evidence: ${problem}. Call the available tools to gather the missing observations. If unavailable, use UNDETERMINED. Return the required JSON.`;
          messages.push({ role: 'user', content: correction });
          say({ turn, role: 'harness', text: correction, because: 'unsupported-evidence', rejectedCallTiming: res.requestTimer.snapshot() });
          continue;
        }
        return done({ text, toolCalls: used, finishReason: ch.finish_reason });
      }
      if (ch.finish_reason === 'length') return done({ error: 'max-tokens', toolCalls: used });
      lastFinish = ch.finish_reason || 'no-choice';
      if (m.content || calls.length) messages.push({ role: 'assistant', content: m.content || '' });
      const t = 'Give your final answer now, in the required JSON format.';
      messages.push({ role: 'user', content: t });
      say({ turn, role: 'harness', text: t, because: lastFinish });
      used = toolBudget;
    }
    return done({ error: `no-answer (${lastFinish})`, toolCalls: used });
  }

  return { converse, usage, usesActivityTimeout: true };
}

module.exports = { makeOpenRouterClient };
