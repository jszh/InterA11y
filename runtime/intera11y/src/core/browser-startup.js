'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const { resourceWait } = require('./timing.js');
async function acquire() {
  const slots = Number(process.env.A11Y_BROWSER_STARTUP_SLOTS || 0);
  if (slots <= 0 || process.platform !== 'linux') return () => {};
  const directory = process.env.A11Y_BROWSER_STARTUP_DIR || `/tmp/a11y-browser-startup-${process.getuid()}`;
  fs.mkdirSync(directory, { recursive: true });
  for (;;) {
    for (let i = 0; i < slots; i++) {
      const child = spawn('/usr/bin/flock', ['-n', `${directory}/${i}.lock`, 'sh', '-c', 'printf ready; cat >/dev/null'],
        { stdio: ['pipe', 'pipe', 'pipe'] });
      const held = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', code => code === 1 ? resolve(false) : reject(new Error(`startup flock exited ${code}`)));
        child.stdout.once('data', () => resolve(true));
      });
      if (held) {
        const cleanup = () => child.stdin.destroy();
        process.once('exit', cleanup);
        return () => { process.removeListener('exit', cleanup); child.stdin.end(); };
      }
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
async function withBrowserStartup(fn) {
  const release = await resourceWait('browser-startup-slot', acquire);
  try { return await fn(); } finally { release(); }
}
module.exports = { withBrowserStartup };
