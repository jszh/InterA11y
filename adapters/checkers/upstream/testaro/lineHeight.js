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
exports.reporter = async (page, withItems) => {
  const all = await init(100, page, "body *", { hasText: /[^\s]/ });
  for (const loc of all.allLocs) {
    const data = await loc.evaluate((el) => {
      const styleDec = window.getComputedStyle(el);
      const { fontSize, lineHeight } = styleDec;
      return {
        fontSize: Number.parseFloat(fontSize),
        lineHeight: Number.parseFloat(lineHeight)
      };
    });
    const isBad = data.lineHeight < 1.49 * data.fontSize;
    if (isBad) {
      all.locs.push([loc, `font size ${data.fontSize} px, line height ${data.lineHeight} px`]);
    }
  }
  const whats = [
    "Element line height is less than 1.5 times its font size (__param__)",
    "Elements have line heights less than 1.5 times their font sizes"
  ];
  return await report(withItems, all, "lineHeight", whats, 1);
};
