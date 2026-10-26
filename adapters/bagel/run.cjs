#!/usr/bin/env node
"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { evaluateGraph } = require("./core.cjs");
const { acquire, ALL_KEYS } = require("./browser.cjs");
async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
    const i = arg.indexOf("=");
    return i < 0 ? [arg.replace(/^--/, ""), true] : [arg.slice(0, i).replace(/^--/, ""), arg.slice(i + 1)];
  }));
  if (!args.url && !args.input) throw new Error("Use --url=<saved page URL> or --input=<acquisition.json>; --output=<directory> is optional.");
  const outputDir = path.resolve(args.output || "./bagel-prototype-output");
  await fs.mkdir(outputDir, { recursive: true });
  const started = Date.now();
  const acquisition = args.input ? JSON.parse(await fs.readFile(args.input, "utf8")) : await acquire(args.url, {
    outputDir,
    keys: args.keys ? args.keys.split(",") : ALL_KEYS,
    width: Number(args.width || 1920),
    height: Number(args.height || 1080),
    timeout: Number(args.timeout || 3e4),
    settleMs: Number(args["settle-ms"] || 150),
    padding: Number(args.padding || 8),
    colorDifference: Number(args["color-difference"] || 10),
    minContrast: Number(args["min-contrast"] || 3),
    maxNodes: args["max-nodes"] ? Number(args["max-nodes"]) : void 0,
    executablePath: args.chrome || process.env.A11Y_CHROME,
    focus: args["skip-focus"] !== true,
    onProgress: args.progress ? (event) => process.stderr.write(JSON.stringify(event) + "\n") : void 0
  });
  if (args.funcsets) {
    const groups = JSON.parse(await fs.readFile(args.funcsets, "utf8"));
    acquisition.nodes = acquisition.nodes.map((node) => ({ ...node, funcSet: groups[node.xpath] }));
    acquisition.funcSetSource = path.resolve(args.funcsets);
  }
  const graph = evaluateGraph(acquisition);
  const report = {
    name: "BAGEL paper-based prototype",
    originalImplementation: false,
    source: { doi: "10.1145/3544548.3580749", originalCodeStatus: "Original project page says full implementation withheld during patenting." },
    limitations: [
      "Automatic FuncSet clustering is blocked: original DBSCAN distance weights/epsilon/minPts are unpublished.",
      "Focus image processing approximates original PID with an explicit RGB threshold, and MMCQ with deterministic median cut.",
      "Minimum-area calibration uses geometry rather than original dummy-element screenshots.",
      "Occlusion uses five hit-test samples, not a complete CSS painting-order solver.",
      "Uses current Chromium; original evaluated Firefox 92 at 1920x1080.",
      "Checks original paper draft focus requirements; these are stricter than WCAG 2.4.7 alone.",
      "Only initial-state, same-document light DOM is acquired; shadow DOM, frames, and deeper interactive states are not covered."
    ],
    elapsedMs: Date.now() - started,
    graph,
    focus: acquisition.focus || [],
    acquisitionComplete: acquisition.complete,
    errors: acquisition.errors || []
  };
  await fs.writeFile(path.join(outputDir, "acquisition.json"), JSON.stringify(acquisition, null, 2) + "\n");
  await fs.writeFile(path.join(outputDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({
    outputDir,
    nodes: graph.nodeCount,
    edges: graph.edgeCount,
    focusChecks: report.focus.length,
    focusFailures: report.focus.filter((row) => row.result === "FAIL").length,
    graphFindings: graph.findings.length,
    complete: acquisition.complete,
    errors: report.errors.length,
    coverage: graph.coverage
  }));
}
if (require.main === module) main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
module.exports = { main };
