'use strict';
const fs = require('node:fs');
const path = require('node:path');
function terminalCode(value) {
  const code = value && (value.status_code || value.code || value.error && value.error.code);
  if ([401, 402, 403].includes(Number(code))) return Number(code);
  const match = String(value && value.message || value).match(/(?:http[- :]|error code:)\s*(401|402|403)\b/i);
  return match ? Number(match[1]) : null;
}
function blocked() {
  try { return JSON.parse(fs.readFileSync(process.env.A11Y_PROVIDER_HEALTH_PATH, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT' || !process.env.A11Y_PROVIDER_HEALTH_PATH) return null; throw e; }
}
function recordTerminal(value) {
  const code = terminalCode(value), target = process.env.A11Y_PROVIDER_HEALTH_PATH;
  if (!code) return false;
  if (target) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ state: 'blocked', statusCode: code, atEpoch: Date.now() / 1000,
      reason: `OpenRouter HTTP ${code}: provider admission blocked; inspect credits or credentials`, pid: process.pid }));
    fs.renameSync(tmp, target);
  }
  return true;
}
module.exports = { blocked, recordTerminal, terminalCode };
