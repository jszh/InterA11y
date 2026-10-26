/*
  © 2021–2023 CVS Health and/or one of its affiliates. All rights reserved.

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
exports.reporter = async (page, withItems) => {
  const all = await init(100, page, "button, input:not([type=hidden]), select, textarea");
  for (const loc of all.allLocs) {
    const labelTypes = await loc.evaluate((el) => {
      const labelTypes2 = [];
      ["aria-label", "aria-labelledby"].forEach((type) => {
        if (el.hasAttribute(type)) {
          labelTypes2.push(type);
        }
      });
      const labels = Array.from(el.labels);
      if (labels.length) {
        labelTypes2.push("label");
      }
      return labelTypes2;
    });
    if (labelTypes.length > 1) {
      all.locs.push([loc, labelTypes.join(", ")]);
    }
  }
  const whats = [
    "Element has inconsistent label types (__param__)",
    "Elements have inconsistent label types"
  ];
  return await report(withItems, all, "labClash", whats, 2);
};
