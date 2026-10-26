'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { performance } = require('node:perf_hooks');
const context = new AsyncLocalStorage();
let nextId = 0;

function union(intervals) {
  const out = [];
  for (const [start, end] of intervals.filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0])) {
    const last = out[out.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

function difference(left, right) {
  const out = [];
  for (const [start, end] of union(left)) {
    let cursor = start;
    for (const [a, b] of union(right)) {
      if (b <= cursor) continue;
      if (a >= end) break;
      if (a > cursor) out.push([cursor, Math.min(a, end)]);
      cursor = Math.max(cursor, b);
      if (cursor >= end) break;
    }
    if (cursor < end) out.push([cursor, end]);
  }
  return out;
}
const length = (intervals) => intervals.reduce((sum, [a, b]) => sum + b - a, 0);
const round = (ms) => Math.round(ms * 1000) / 1000;
const ACCOUNTING_REVISION = 'parallel-critical-path-v3';

function longestSequence(branches) {
  const ordered = branches.filter((b) => b.value > 0).sort((a, b) => a.end - b.end);
  const best = [0];
  for (let i = 0; i < ordered.length; i++) {
    let previous = i - 1;
    while (previous >= 0 && ordered[previous].end > ordered[i].start) previous--;
    best.push(Math.max(best[i], ordered[i].value + best[previous + 1]));
  }
  return best[best.length - 1];
}

class TaskTimer {
  constructor(clock = () => performance.now(), options = {}) {
    this.id = `${process.pid}-${nextId++}`;
    this.clock = clock;
    this.start = clock();
    this.end = null;
    this.activeSince = this.start;
    this.active = [];
    this.holds = new Set();
    this.waits = [];
    this.children = new Set();
    this.kind = options.kind || 'processing';
    this.name = options.name || null;
    this.accepted = true;
    this.exclusionReason = null;
    this.processingOverrideMs = null;
    this.parallelGroup = options.parallelGroup || null;
  }
  exclude(reason) { this.accepted = false; this.exclusionReason = reason; }
  pause(kind = null) {
    const at = this.clock();
    if (!this.holds.size) {
      this.active.push([this.activeSince, at]);
      this.activeSince = null;
    }
    const hold = { start: at, end: null, kind };
    this.holds.add(hold);
    if (kind) this.waits.push(hold);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      hold.end = this.clock();
      this.holds.delete(hold);
      if (!this.holds.size && this.end === null) this.activeSince = hold.end;
    };
  }
  finish() {
    this.end = this.clock();
    if (this.activeSince !== null) this.active.push([this.activeSince, this.end]);
    this.activeSince = null;
  }
  snapshot({ includeTree = false } = {}) {
    const end = this.end === null ? this.clock() : this.end;
    const busy = [], infrastructure = [], waits = [], discarded = [];
    const ownIntervals = (task, lo, hi) => difference([
      ...task.active, ...(task.activeSince === null ? [] : [[task.activeSince, hi]]),
    ].map(([a, b]) => [Math.max(lo, a), Math.min(hi, b)]),
    [...task.children].map((child) => [Math.max(lo, child.start), Math.min(hi, child.end === null ? end : child.end)]));

    const visit = (task, lower, upper, ancestors = new Set(), eligible = true) => {
      if (ancestors.has(task)) return;
      const start = Math.max(lower, task.start);
      const taskEnd = Math.min(upper, task.end === null ? end : task.end);
      if (taskEnd <= start) return;
      const clip = (a, b) => [Math.max(start, a), Math.min(taskEnd, b)];
      eligible = eligible && task.accepted;
      if (!eligible) discarded.push([start, taskEnd]);
      const work = task.kind === 'infra' ? infrastructure : busy;
      if (eligible) {
        work.push(...ownIntervals(task, start, taskEnd));
      }
      for (const w of task.waits) {
        const [a, b] = clip(w.start, w.end === null ? taskEnd : w.end);
        if (b > a) waits.push({ kind: w.kind, start: a, end: b });
      }
      const path = new Set(ancestors).add(task);
      for (const child of task.children) visit(child, start, taskEnd, path, eligible);
    };
    visit(this, this.start, end);
    const exclusiveInfrastructure = difference(infrastructure, busy);
    const excluded = difference([...waits.map((w) => [w.start, w.end]), ...discarded], [...busy, ...infrastructure]);
    const wallMs = end - this.start;
    const excludedWaitMs = length(excluded);
    const kinds = [...new Set(waits.map((w) => w.kind))];

    const service = (task, lower, upper, path = new Set()) => {
      if (!task.accepted || path.has(task)) return 0;
      const lo = Math.max(lower, task.start), hi = Math.min(upper, task.end === null ? end : task.end);
      if (hi <= lo) return 0;
      if (task.processingOverrideMs !== null) return task.processingOverrideMs;
      const own = task.kind === 'infra' ? 0 : length(ownIntervals(task, lo, hi));
      const nextPath = new Set(path).add(task);
      const groups = new Map();
      for (const child of task.children) {
        const a = Math.max(lo, child.start), b = Math.min(hi, child.end === null ? end : child.end);
        if (b <= a) continue;
        const value = service(child, lo, hi, nextPath);
        if (!value) continue;

        const spans = [];
        const collect = (node, lower, upper, path) => {
          if (!node.accepted || path.has(node)) return;
          const start = Math.max(lower, node.start), finish = Math.min(upper, node.end === null ? end : node.end);
          if (finish <= start) return;
          if (node.kind !== 'infra') spans.push(...ownIntervals(node, start, finish));
          const next = new Set(path).add(node);
          for (const nested of node.children) collect(nested, start, finish, next);
        };
        collect(child, lo, hi, nextPath);
        const productive = union(spans);
        if (!productive.length) continue;
        const group = child.parallelGroup || child.id;
        const entry = groups.get(group);
        const start = productive[0][0], finish = productive[productive.length - 1][1];
        groups.set(group, { start: entry ? Math.min(entry.start, start) : start,
          end: entry ? Math.max(entry.end, finish) : finish,
          value: Math.max(entry ? entry.value : 0, value) });
      }
      return own + longestSequence([...groups.values()]);
    };
    const successfulProcessingMs = service(this, this.start, end);
    const exclusiveInfrastructureMs = length(exclusiveInfrastructure);
    return {
      version: 'successful-service-v2', accountingRevision: ACCOUNTING_REVISION, wallMs: round(wallMs),
      id: this.id, kind: this.kind, name: this.name,
      startedAtMonotonicMs: round(this.start), returnedAtMonotonicMs: round(end),
      activeMs: round(wallMs - excludedWaitMs), excludedWaitMs: round(excludedWaitMs),
      successfulProcessingMs: round(successfulProcessingMs),
      exclusiveInfrastructureMs: round(exclusiveInfrastructureMs),
      accountedMs: round(successfulProcessingMs + exclusiveInfrastructureMs),
      accepted: this.accepted, exclusionReason: this.exclusionReason,
      instrumentationComplete: successfulProcessingMs + exclusiveInfrastructureMs <= wallMs + 0.01,
      ...(includeTree ? { taskTree: this.tree(end) } : {}),

      resourceWaitMsByKind: Object.fromEntries(kinds.map((kind) => [kind,
        round(length(union(waits.filter((w) => w.kind === kind).map((w) => [w.start, w.end]))))])),
      excludedIntervals: excluded.map(([a, b]) => [round(a - this.start), round(b - this.start)]),
      exclusiveInfrastructureIntervals: exclusiveInfrastructure.map(([a, b]) => [round(a - this.start), round(b - this.start)]),
      resourceWaitIntervals: [...new Map(waits.map((w) => {
        const item = { kind: w.kind, startMs: round(w.start - this.start), endMs: round(w.end - this.start) };
        return [JSON.stringify(item), item];
      })).values()],
    };
  }
  tree(end = this.end === null ? this.clock() : this.end) {
    const seen = new Set(), origin = this.start;
    const visit = (task) => {
      if (seen.has(task)) return { ref: task.id };
      seen.add(task);
      return { id: task.id, kind: task.kind, name: task.name, accepted: task.accepted,
        exclusionReason: task.exclusionReason, parallelGroup: task.parallelGroup,
        startMs: task.start - origin, endMs: (task.end === null ? end : task.end) - origin,
        processingOverrideMs: task.processingOverrideMs,
        active: [...task.active, ...(task.activeSince === null ? [] : [[task.activeSince, end]])]
          .map(([a, b]) => [a - origin, b - origin]),
        waits: task.waits.map(w => ({kind: w.kind, startMs: w.start - origin, endMs: (w.end === null ? end : w.end) - origin})),
        children: [...task.children].map(visit) };
    };
    return visit(this);
  }
}

function startTimed(fn, options = {}) {
  const parent = context.getStore();
  const timer = new TaskTimer(options.clock || (parent && parent.clock), options);
  const promise = context.run(timer, async () => {

    await Promise.resolve();
    try {
      const value = await fn();
      if (options.accept && !options.accept(value)) timer.exclude('unsuccessful-result');
      return value;
    } catch (e) { timer.exclude(String((e && e.message) || e)); throw e; }
    finally { timer.finish(); }
  });
  return { timer, promise };
}

async function depend(handle) {
  const parent = context.getStore();
  if (!parent) return handle.promise;
  parent.children.add(handle.timer);
  const resume = parent.pause();
  try { return await handle.promise; } finally { resume(); }
}

async function timed(fn, options) {
  const handle = startTimed(fn, options);
  try {
    const value = await depend(handle);
    return { value, timing: handle.timer.snapshot({ includeTree: options && options.recordTree }), timer: handle.timer };
  } catch (e) {
    if (e && typeof e === 'object') { try { e.timing = handle.timer.snapshot(); } catch (_) {                      } }
    throw e;
  }
}

async function parallel(fns) {
  const parallelGroup = `parallel-${nextId++}`;
  return Promise.all(fns.map(async (fn) => (await timed(fn, { parallelGroup })).value));
}

async function resourceWait(kind, fn) {
  const timer = context.getStore();
  const resume = timer ? timer.pause(kind) : () => {};
  try { return await fn(); } finally { resume(); }
}

function queuedCallback(kind, fn) {
  const timer = context.getStore();
  const resume = timer ? timer.pause(kind) : () => {};
  return () => {
    resume();
    return context.run(timer, fn);
  };
}

const infrastructure = async (name, fn) => (await timed(fn, { kind: 'infra', name })).value;
const currentTimer = () => context.getStore();

function finalCallTime(calls) {
  const groups = [];
  for (const call of calls.filter((c) => c.finalLeaf).sort((a, b) => a.startedAt - b.startedAt)) {
    const ms = call.timer.snapshot().successfulProcessingMs;
    const last = groups[groups.length - 1];
    if (last && call.startedAt < last.end) {
      last.end = Math.max(last.end, call.finishedAt);
      last.ms = Math.max(last.ms, ms);
    } else groups.push({ end: call.finishedAt, ms });
  }
  return groups.reduce((sum, group) => sum + group.ms, 0);
}
module.exports = { timed, startTimed, depend, parallel, resourceWait, queuedCallback, infrastructure, currentTimer, finalCallTime, ACCOUNTING_REVISION };
