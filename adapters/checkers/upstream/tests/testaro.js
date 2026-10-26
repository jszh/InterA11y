/*
  © 2023–2025 CVS Health and/or one of its affiliates. All rights reserved.

  MIT License

  Permission is hereby granted, free of charge, to any person obtaining a copy
  of this software and associated documentation files (the "Software"), to deal
  in the Software without restriction, including without limitation the rights
  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  copies of the Software, and to permit persons to whom the Software is
  furnished to do so, subject to the following conditions:

  The above copyright notice and this permission notice shall be included in all
  copies or substantial portions of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
  SOFTWARE.
*/
const { init, report } = require("../procs/testaro");
const fs = require("fs/promises");
const { tellServer } = require("../procs/tellServer");
const futureRules = /* @__PURE__ */ new Set([]);
const evalRules = {
  altScheme: "img elements with alt attributes having URLs as their entire values",
  captionLoc: "caption elements that are not first children of table elements",
  datalistRef: "elements with ambiguous or missing referenced datalist elements",
  secHeading: "headings that violate the logical level order in their sectioning containers",
  textSem: "semantically vague elements i, b, and/or small",
  adbID: "elements with ambiguous or missing referenced descriptions",
  imageLink: "links with image files as their destinations",
  legendLoc: "legend elements that are not first children of fieldset elements",
  optRoleSel: "Non-option elements with option roles that have no aria-selected attributes",
  phOnly: "input elements with placeholders but no accessible names",
  allCaps: "leaf elements with entirely upper-case text longer than 7 characters",
  allHidden: "page that is entirely or mostly hidden",
  allSlanted: "leaf elements with entirely italic or oblique text longer than 39 characters",
  attVal: "duplicate attribute values",
  autocomplete: "name and email inputs without autocomplete attributes",
  bulk: "large count of visible elements",
  buttonMenu: "nonstandard keyboard navigation between items of button-controlled menus",
  distortion: "distorted text",
  docType: "document without a doctype property",
  dupAtt: "elements with duplicate attributes",
  embAc: "active elements embedded in links or buttons",
  focAll: "discrepancies between focusable and Tab-focused elements",
  focInd: "missing and nonstandard focus indicators",
  focOp: "Tab-focusable elements that are not operable",
  focVis: "links that are not entirely visible when focused",
  headEl: "invalid elements within the head",
  headingAmb: "same-level sibling headings with identical texts",
  hover: "hover-caused content changes",
  hovInd: "hover indication nonstandard",
  hr: "hr element instead of styles used for vertical segmentation",
  labClash: "labeling inconsistencies",
  lineHeight: "text with a line height less than 1.5 times its font size",
  linkAmb: "links with identical texts but different destinations",
  linkExt: "links that automatically open new windows",
  linkOldAtt: "links with deprecated attributes",
  linkTitle: "links with title attributes repeating text content",
  linkTo: "links without destinations",
  linkUl: "missing underlines on inline links",
  miniText: "text smaller than 11 pixels",
  motion: "motion without user request",
  nonTable: "table elements used for layout",
  opFoc: "operable elements that are not Tab-focusable",
  pseudoP: "adjacent br elements suspected of nonsemantically simulating p elements",
  radioSet: "radio buttons not grouped into standard field sets",
  role: "native-replacing explicit roles",
  styleDiff: "style inconsistencies",
  tabNav: "nonstandard keyboard navigation between elements with the tab role",
  targetSmall: "buttons, inputs, and non-inline links smaller than 44 pixels wide and high",
  targetTiny: "buttons, inputs, and non-inline links smaller than 24 pixels wide and high",
  titledEl: "title attributes on inappropriate elements",
  zIndex: "non-default Z indexes"
};
const etcRules = {
  attVal: "elements with attributes having illicit values",
  elements: "data on specified elements",
  textNodes: "data on specified text nodes",
  title: "page title"
};
const jsonTest = async (ruleID, ruleArgs) => {
  const [page, withItems] = ruleArgs;
  const ruleJSON = await fs.readFile(`${__dirname}/../testaro/${ruleID}.json`, "utf8");
  const ruleObj = JSON.parse(ruleJSON);
  const all = await init(100, page, ruleObj.selector);
  all.locs = all.allLocs;
  const whats = [
    ruleObj.complaints.instance,
    ruleObj.complaints.summary
  ];
  return await report(
    withItems,
    all,
    ruleObj.ruleID,
    whats,
    ruleObj.ordinalSeverity,
    ruleObj.summaryTagName
  );
};
const wait = (ms) => {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve("");
    }, ms);
  });
};
exports.reporter = async (page, report2, actIndex) => {
  const act = report2.acts[actIndex];
  const { args, stopOnFail, withItems } = act;
  const argRules = args ? Object.keys(args) : null;
  const rules = act.rules || ["y", ...Object.keys(evalRules)];
  const data = {
    prevented: false,
    error: "",
    rulePreventions: [],
    rulePreventionMessages: {},
    rulesInvalid: [],
    ruleTestTimes: {}
  };
  const result = {};
  if (rules.length > 1 && ["y", "n"].includes(rules[0]) && rules.slice(1).every((rule) => {
    if (evalRules[rule] || etcRules[rule] || futureRules.has(rule)) {
      return true;
    } else {
      console.log(`ERROR: Testaro rule ${rule} invalid`);
      return false;
    }
  })) {
    await wait(1e3);
    const calledRules = rules[0] === "y" ? rules.slice(1) : Object.keys(evalRules).filter((ruleID) => !rules.slice(1).includes(ruleID));
    const testTimes = [];
    for (const rule of calledRules.filter((rule2) => !futureRules.has(rule2))) {
      const ruleArgs = [page, withItems];
      const ruleFileNames = await fs.readdir(`${__dirname}/../testaro`);
      const isJS = ruleFileNames.includes(`${rule}.js`);
      const isJSON = ruleFileNames.includes(`${rule}.json`);
      if ((isJS || isJSON) && !(isJS && isJSON)) {
        if (isJS && argRules && argRules.includes(rule)) {
          ruleArgs.push(...args[rule]);
        }
        const what = evalRules[rule] || etcRules[rule];
        if (report2.observe) {
          tellServer(
            options.report,
            `act=test&which=testaro&rule=${rule}&ruleWhat=${what}`,
            `>>>>>> ${rule} (${what})`
          );
        }
        if (!result[rule]) {
          result[rule] = {};
        }
        result[rule].what = what;
        const startTime = Date.now();
        try {
          let timeout;
          const timer = new Promise((resolve) => {
            timeout = setTimeout(() => {
              const endTime = Date.now();
              testTimes.push([rule, Math.round((endTime - startTime) / 1e3)]);
              data.rulePreventions.push(rule);
              result[rule].totals = [0, 0, 0, 0];
              result[rule].standardInstances = [];
              console.log(`ERROR: Test of testaro rule ${rule} timed out`);
              resolve({ timedOut: true });
            }, 15e3);
          });
          const ruleReport = isJS ? require(`../testaro/${rule}`).reporter(...ruleArgs) : jsonTest(rule, ruleArgs);
          const timeoutReport = await Promise.race([timer, ruleReport]);
          clearTimeout(timeout);
          if (!timeoutReport.timedOut) {
            const endTime = Date.now();
            testTimes.push([rule, Math.round((endTime - startTime) / 1e3)]);
            Object.keys(timeoutReport).forEach((key) => {
              result[rule][key] = timeoutReport[key];
            });
            result[rule].totals = result[rule].totals.map((total) => Math.round(total));
            if (stopOnFail && timeoutReport.totals.some((total) => total)) {
              break;
            }
          }
        } catch (error) {
          data.rulePreventions.push(rule);
          data.rulePreventionMessages[rule] = error.message;
          console.log(`ERROR: Test of testaro rule ${rule} prevented (${error.message})`);
        }
      } else {
        data.rulesInvalid.push(rule);
        console.log(`ERROR: Rule ${rule} not validly defined`);
      }
    }
    testTimes.sort((a, b) => b[1] - a[1]).forEach((pair) => {
      data.ruleTestTimes[pair[0]] = pair[1];
    });
  } else {
    const message = "ERROR: Testaro rule specification invalid";
    console.log(message);
    data.prevented = true;
    data.error = message;
  }
  return {
    data,
    result
  };
};
