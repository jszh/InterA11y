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
const { getLocatorData } = require("../procs/getLocatorData");
exports.reporter = async (page, withItems) => {
  const data = {};
  const totals = [0, 0, 0, 0];
  const standardInstances = [];
  const headingLevels = [1, 2, 3, 4, 5, 6];
  const locAll = page.locator(headingLevels.map((level) => `body h${level}`).join(", "));
  const locsAll = await locAll.all();
  const ambIndexes = await locAll.evaluateAll((headings) => {
    const badIndexes = [];
    headings.forEach((heading, index) => {
      const level = heading.tagName[1];
      const priorHeadings = headings.slice(0, index);
      const nonInferiors = priorHeadings.filter((priorHeading) => priorHeading.tagName[1] <= level);
      const nonInferiorCount = nonInferiors.length;
      if (nonInferiorCount) {
        const prior = nonInferiors[nonInferiorCount - 1];
        if (["tagName", "textContent"].every((property) => prior[property] === heading[property])) {
          badIndexes.push(index);
        }
      }
    });
    return badIndexes;
  });
  if (ambIndexes.length) {
    totals[1] = ambIndexes.length;
    if (withItems) {
      for (const index of ambIndexes) {
        const loc = locsAll[index];
        if (loc) {
          const elData = await getLocatorData(loc);
          standardInstances.push({
            ruleID: "headingAmb",
            what: "Heading has the same text as the prior same-level sibling heading",
            ordinalSeverity: 1,
            tagName: elData.tagName,
            id: elData.id,
            location: elData.location,
            excerpt: elData.excerpt
          });
        } else {
          console.log("ERROR: Reportedly same-text adjacent sibling heading not found");
        }
      }
    } else {
      standardInstances.push({
        ruleID: "headingAmb",
        what: "Adjacent sibling same-level headings have the same text",
        ordinalSeverity: 1,
        count: totals[1],
        tagName: "",
        id: "",
        location: {
          doc: "",
          type: "",
          spec: ""
        },
        excerpt: ""
      });
    }
  }
  return {
    data,
    totals,
    standardInstances
  };
};
