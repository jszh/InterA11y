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
const { init, report } = require("../procs/testaro");
const { isOperable } = require("../procs/operable");
exports.reporter = async (page, withItems) => {
  const all = await init(100, page, "body *");
  all.result.data.operableCount = 0;
  for (const loc of all.allLocs) {
    const operabilities = await isOperable(loc);
    if (operabilities.length) {
      all.result.data.operableCount++;
      const isFocusable = await loc.evaluate((el) => el.tabIndex === 0);
      if (!isFocusable) {
        all.locs.push([loc, operabilities.join(", ")]);
      }
    }
  }
  const whats = [
    "Element is operable (__param__) but not Tab-focusable",
    "Elements are operable but not Tab-focusable"
  ];
  const result = await report(withItems, all, "opFoc", whats, 3);
  try {
    await page.reload({ timeout: 15e3 });
  } catch (error) {
    console.log("ERROR: page reload timed out");
  }
  return result;
};
