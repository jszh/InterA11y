'use strict';

const { queuedCallback } = require('./timing.js');

class Deadline {
  constructor(ms) { this.at = ms > 0 ? Date.now() + ms : Infinity; }
  remaining() { return Math.max(0, this.at - Date.now()); }
  expired() { return this.remaining() === 0; }
  async run(promiseOrFn) {
    const p = typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn;
    if (!Number.isFinite(this.at)) {
      try { return { value: await p }; } catch (error) { return { error }; }
    }
    let timer;
    const timeout = new Promise((r) => { timer = setTimeout(() => r({ timedOut: true }), this.remaining()); });
    try {
      const v = await Promise.race([p.then((value) => ({ value }), (error) => ({ error })), timeout]);
      return v;
    } finally { clearTimeout(timer); }
  }
}

async function bounded(p, ms, onTimeout) {
  let timer;
  const t = new Promise((r) => { timer = setTimeout(() => r(onTimeout), Math.max(0, ms)); });
  try { return await Promise.race([p, t]); } finally { clearTimeout(timer); }
}

function makePool(limit, waitKind = 'llm-slot') {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= limit || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn: queuedCallback(waitKind, fn), resolve, reject }); next(); });
}

module.exports = { Deadline, makePool, bounded };
