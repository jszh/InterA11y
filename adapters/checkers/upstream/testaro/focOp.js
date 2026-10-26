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
const { init, report } = require("../procs/testaro");
const { isOperable } = require("../procs/operable");
exports.reporter = async (page, withItems) => {
  const all = await init(100, page, "body *");
  all.result.data.focusableCount = 0;
  for (const loc of all.allLocs) {
    const isFocusable = await loc.evaluate((el) => el.tabIndex === 0);
    if (isFocusable) {
      all.result.data.focusableCount++;
      const howOperable = await isOperable(loc);
      if (!howOperable.length) {
        all.locs.push(loc);
      }
    }
  }
  const whats = [
    "Element is Tab-focusable but not operable",
    "Elements are Tab-focusable but not operable"
  ];
  const result = await report(withItems, all, "focOp", whats, 2);
  try {
    await page.reload({ timeout: 15e3 });
  } catch (error) {
    console.log("ERROR: page reload timed out");
  }
  return result;
};
