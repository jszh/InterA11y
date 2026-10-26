"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm");
const latest = require("testaro-issues");
const older = require("./metadata/testilo-issues").issues;
const engineAlias = { nuVal: "nuVnu", ed11y: "ed11y", aslint: "aslint", testaro: "testaro" };
function matches(pattern, value) {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return false;
  }
}
const direct = (sc) => /^\d+\.\d+\.\d+$/.test(sc || "") ? [sc] : [];
const edFile = path.join(process.env.EDITORIA11Y_HOME || path.join(__dirname, "editoria11y"), "conformance/mapping/act-rule-mapping.js");
const edSource = fs.existsSync(edFile) ? fs.readFileSync(edFile, "utf8").replace(/^export /gm, "") + "\nactRuleMapping;" : "({});";
const edMapping = vm.runInNewContext(edSource, {}, { timeout: 2e3 });
function mapRule(engine, ruleID) {
  const result = [];
  const table = latest.rules[engineAlias[engine]];
  if (table) for (const type of ["invariant", "variable"]) for (const [id, entry] of Object.entries(table[type] || {})) {
    if (type === "invariant" ? id === ruleID : matches(id, ruleID)) {
      const issue = latest.issues[entry.issueID];
      result.push({ sc: direct(issue?.wcag), outcome: entry.outcome || "failed", whyIgnore: entry.whyIgnore || null, source: "testaro-issues@1.1.6", issueID: entry.issueID });
    }
  }
  if (!result.length) for (const [issueID, issue] of Object.entries(older)) {
    for (const [id, spec] of Object.entries(issue.tools?.[engine] || {})) if (spec.variable ? matches(id, ruleID) : id === ruleID) result.push({ sc: direct(issue.wcag), outcome: issue.weight === 0 ? "cantTell" : "failed", source: "CVS Testilo tic metadata", issueID });
  }
  if (engine === "ed11y") for (const [actID, spec] of Object.entries(edMapping)) {
    if (["full", "partial"].includes(spec.coverage) && spec.checkKeys.includes(ruleID)) result.push({ sc: spec.wcag, outcome: "failed", source: "Editoria11y official ACT mappings", actID });
  }
  return { sc: [...new Set(result.flatMap((r) => r.sc))], review: result.length > 0 && result.every((r) => r.outcome === "cantTell" || r.whyIgnore), metadata: result };
}
module.exports = { mapRule };
