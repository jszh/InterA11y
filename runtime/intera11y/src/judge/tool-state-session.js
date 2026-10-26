'use strict';

const { randomUUID } = require('crypto');
function leasePage(page) {
  const overrides = new Map([['close', async () => {}]]);
  return new Proxy(page, {
    get(target, key) {
      if (overrides.has(key)) return overrides.get(key);
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target, key, value) { overrides.set(key, value); return true; },
  });
}
function stateSession(page) {
  return { page, freshPage: async () => leasePage(page) };
}
function workflowStates(session) {
  const states = new Map();
  return {
    async acquire(id) {
      if (id === 'new') {
        const page = await session.freshPage();
        id = randomUUID(); states.set(id, page);
      }
      const page = states.get(id);
      if (!page || page.isClosed()) throw new Error('Unknown or closed stateId; no actions executed.');
      return { id, session: stateSession(page) };
    },
    async close() { await Promise.all([...states.values()].map(p => p.close())); states.clear(); },
  };
}
module.exports = { leasePage, stateSession, workflowStates };
