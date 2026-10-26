"use strict";
const { NativeToolContext } = require("./native-tool-context.js");
const readline = require("readline");
const { launchBrowser, openSession } = require("../../runtime/intera11y/src/core/session.js");
const { bindTools } = require("../../runtime/intera11y/src/judge/tools.js");
const { toolHandlers } = require("../../runtime/intera11y/src/lib/v3.js");
const { timed } = require("../../runtime/intera11y/src/core/timing.js");
const timingEnabled = process.argv.includes("--timing-v2");
const url = process.argv[2];
if (!url) throw new Error("URL required");
(async () => {
  let browser, session;
  const setup = await timed(async () => {
    browser = await launchBrowser();
    session = await openSession(browser, url);
  }, { kind: "infra", name: "specialist-browser-setup" });
  const native = new NativeToolContext();
  const bound = bindTools(session, Object.keys(toolHandlers));
  process.stdout.write(JSON.stringify({ ready: true, ...timingEnabled ? { timing: setup.timing } : {} }) + "\n");
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    let result;
    let timing = null, startedAtUnixMs = Date.now();
    try {
      const req = JSON.parse(line);
      const call = await timed(() => req.nativeContext && !req.args?.stateId ? native.call(req.nativeContext, req.name, req.args || {}, req.nativeTargets) : bound.call(req.name, req.args || {}, req.nativeTargets ?? void 0), { kind: "tool", name: req.name, accept: (r) => !(r && r.error) });
      result = call.value;
      timing = call.timing;
    } catch (e) {
      result = { error: String(e && e.message || e) };
      timing = e && e.timing || null;
    }
    process.stdout.write(JSON.stringify(timingEnabled ? { bridgeProtocol: 2, result, timing, startedAtUnixMs } : result) + "\n");
  }
  await native.close();
  await bound.close();
  await session.close();
  await browser.close();
})().catch((e) => {
  process.stderr.write(String(e && e.stack || e) + "\n");
  process.exit(1);
});
