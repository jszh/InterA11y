/*
  © 2022–2025 CVS Health and/or one of its affiliates. All rights reserved.

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
  const all = await init(100, page, "a:visible");
  for (const loc of all.allLocs) {
    await loc.focus();
    const box = await loc.boundingBox();
    const isBad = [box.x < 0, box.y < 0];
    if (isBad.some((item) => item)) {
      let param;
      if (isBad.every((item) => item)) {
        param = "above and to the left of";
      } else if (isBad[0]) {
        param = "to the left of";
      } else {
        param = "above";
      }
      all.locs.push([loc, param]);
    }
  }
  const whats = [
    "Visible link is __param__ the display",
    "Visible links are above or to the left of the display"
  ];
  return await report(withItems, all, "focVis", whats, 2);
};
