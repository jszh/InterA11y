/*
  © 2023–2024 CVS Health and/or one of its affiliates. All rights reserved.

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
const { getSample } = require("../procs/sample");
const { getLocatorData } = require("../procs/getLocatorData");
const { boxOf, boxToString } = require("./identify");
const { xPath } = require("playwright-dompath");
const init = exports.init = async (sampleMax, page, locAllSelector, options = {}) => {
  const locPop = page.locator(locAllSelector, options);
  const locPops = await locPop.all();
  const populationSize = locPops.length;
  const sampleSize = Math.min(sampleMax, populationSize);
  const locIndexes = getSample(locPops, sampleSize);
  const allLocs = locIndexes.map((index) => locPops[index]);
  const result = {
    data: {
      populationSize,
      sampleSize,
      populationRatio: sampleSize ? populationSize / sampleSize : null
    },
    totals: [0, 0, 0, 0],
    standardInstances: []
  };
  return {
    allLocs,
    locs: [],
    result
  };
};
const report = exports.report = async (withItems, all, ruleID, whats, ordinalSeverity, tagName = "") => {
  const { locs, result } = all;
  const { data, totals, standardInstances } = result;
  for (const locItem of locs) {
    let loc, whatParam;
    if (Array.isArray(locItem)) {
      loc = locItem[0];
      whatParam = locItem[1];
    } else {
      loc = locItem;
    }
    const elData = await getLocatorData(loc);
    totals[ordinalSeverity] += data.populationRatio;
    if (withItems) {
      const { location } = elData;
      const box = location.type === "box" ? location.spec : await boxOf(loc);
      standardInstances.push({
        ruleID,
        what: whatParam ? whats[0].replace("__param__", whatParam) : whats[0],
        ordinalSeverity,
        tagName: elData.tagName,
        id: elData.id,
        location: elData.location,
        excerpt: elData.excerpt,
        boxID: boxToString(box),
        pathID: await xPath(loc)
      });
    }
  }
  if (!withItems && locs.length) {
    standardInstances.push({
      ruleID,
      what: whats[1],
      ordinalSeverity,
      count: Math.round(totals[ordinalSeverity]),
      tagName,
      id: "",
      location: {
        doc: "",
        type: "",
        spec: ""
      },
      excerpt: "",
      boxID: "",
      pathID: ""
    });
  }
  return result;
};
exports.simplify = async (page, withItems, ruleData) => {
  const {
    ruleID,
    selector,
    pruner,
    isDestructive,
    complaints,
    ordinalSeverity,
    summaryTagName
  } = ruleData;
  const all = await init(100, page, selector);
  for (const loc of all.allLocs) {
    const isBad = await pruner(loc);
    if (isBad) {
      all.locs.push(loc);
    }
  }
  const whats = [
    complaints.instance,
    complaints.summary
  ];
  const result = await report(withItems, all, ruleID, whats, ordinalSeverity, summaryTagName);
  if (isDestructive) {
    try {
      await page.reload({ timeout: 15e3 });
    } catch (error) {
      console.log("ERROR: page reload timed out");
    }
  }
  return result;
};
