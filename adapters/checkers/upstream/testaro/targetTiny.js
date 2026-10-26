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
const { isTooSmall } = require("../procs/target");
exports.reporter = async (page, withItems) => {
  const all = await init(100, page, "a:visible, button:visible, input:visible");
  for (const loc of all.allLocs) {
    const sizeData = await isTooSmall(loc, 24);
    if (sizeData) {
      all.locs.push([loc, `${sizeData.width} wide by ${sizeData.height} high`]);
    }
  }
  const whats = [
    "Interactive element pixel size (__param__) is less than 24 by 24",
    "Interactive elements are smaller than 24 pixels wide and high"
  ];
  return await report(withItems, all, "targetTiny", whats, 1);
};
