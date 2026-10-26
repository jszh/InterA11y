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
  const all = await init(100, page, "body *:visible");
  all.result.data.focusableCount = 0;
  for (const loc of all.allLocs) {
    const isFocusable = await loc.evaluate((el) => el.tabIndex === 0);
    if (isFocusable) {
      all.result.data.focusableCount++;
      const hasBadIndicator = await loc.evaluate((el) => {
        const styleDec = window.getComputedStyle(el);
        if (styleDec.outlineWidth !== "0px") {
          return "an outline when blurred";
        } else {
          el.focus({ preventScroll: true });
          if (styleDec.outlineWidth === "0px") {
            return "no focus outline";
          } else if (Number.parseFloat(styleDec.outlineWidth) < 2) {
            return "a focus outline thinner than 2 pixels";
          } else if (styleDec.outlineColor === "rgba(0, 0, 0, 0)") {
            return "a transparent focus outline";
          } else if (styleDec.outlineStyle !== "solid") {
            if (styleDec.outlineStyle) {
              if (styleDec.outlineStyle === "auto") {
                return false;
              } else {
                return `a focus outline with the ${styleDec.outlineStyle} instead of solid style`;
              }
            } else {
              return "a focus outline with no style instead of solid style";
            }
          } else {
            return false;
          }
        }
      });
      if (hasBadIndicator) {
        all.locs.push([loc, hasBadIndicator]);
      }
    }
  }
  const whats = ["Element has __param__", "Elements fail to have standard focus indicators"];
  return await report(withItems, all, "focInd", whats, 1);
};
