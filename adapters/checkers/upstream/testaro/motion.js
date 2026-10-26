/*
  © 2021–2024 CVS Health and/or one of its affiliates. All rights reserved.

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
const { visChange } = require("../procs/visChange");
exports.reporter = async (page) => {
  const totals = [0, 0, 0, 0];
  const standardInstances = [];
  const data = await visChange(page, {
    delayBefore: 2e3,
    delayBetween: 3e3
  });
  if (data.success) {
    if (data.pixelChanges) {
      const ordinalSeverity = Math.floor(Math.min(3, 0.4 * Math.sqrt(data.changePercent)));
      totals[ordinalSeverity] = 1;
      standardInstances.push({
        ruleID: "motion",
        what: "Content moves or changes without user request",
        count: 1,
        ordinalSeverity,
        tagName: "HTML",
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
