'use strict';

const { Deadline } = require('../core/deadline.js');
const { CONFIG } = require('../core/config.js');
const { startTimed, depend, parallel } = require('../core/timing.js');
const { makeProfile } = require('./profile.js');

const PROBES = ['keyboard', 'pointer', 'activation', 'forms', 'styles', 'content'];
const load = (name) => require(`./${name}.js`);

function makeProbeRunner(session, model, { scs = [], targets = null, profile = CONFIG.probeProfile } = {}) {
  const options = makeProfile(profile, scs, targets);
  const memo = new Map();
  const run = (name) => {
    if (!memo.has(name)) {
      if (!PROBES.includes(name)) throw new Error(`unknown probe ${name}`);
      const probe = load(name);
      const deadline = new Deadline(CONFIG.probeDeadlineMs);
      const t0 = Date.now();
      const partial = probe.empty();
      memo.set(name, startTimed(() => deadline.run(() => probe.run({ session, model, deadline, partial, options })).then((r) => {
        const ms = Date.now() - t0;
        if (r.timedOut) return { ...probe.empty(), ...partial, completeness: 'truncated', reason: 'time limit', ms };
        if (r.error) return { ...probe.empty(), ...partial, completeness: 'failed', reason: String((r.error && r.error.stack) || r.error).slice(0, 500), ms };
        return { ...probe.empty(), completeness: 'complete', ...r.value, ms };
      }), { kind: 'probe', name, accept: (r) => r.completeness === 'complete' }));
    }
    const handle = memo.get(name);
    return depend(handle).then((r) => {
      const elapsed = handle.timer.snapshot();
      if (elapsed.accepted) {

        handle.timer.processingOverrideMs = elapsed.wallMs - elapsed.excludedWaitMs - elapsed.exclusiveInfrastructureMs;
      }
      return { ...r, timing: { ...handle.timer.snapshot({ includeTree: true }),
        probeDurationPolicy: 'start-end-minus-recorded-exclusions-and-exclusive-infrastructure' },
        acquisition: { profile, scs, options: options[name] || {}, targetKeys: options.targetKeys } };
    });
  };
  const get = async (names) => Object.fromEntries(await parallel(names.map((n) => async () => [n, await run(n)])));
  return { get };
}

module.exports = { makeProbeRunner, PROBES };
