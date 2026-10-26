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
const { getLocatorData } = require("../procs/getLocatorData");
exports.reporter = async (page, withItems) => {
  const all = await init(100, page, "a[href]:visible");
  const linksData = [];
  for (const loc of all.allLocs) {
    const elData = await getLocatorData(loc);
    const linkText = elData.excerpt.toLowerCase();
    const linkTo = await loc.getAttribute("href");
    if (linkText && linkTo) {
      if (linksData.some((linkData) => linkData.text === linkText && linkData.to !== linkTo)) {
        all.locs.push(loc);
      } else {
        linksData.push({
          text: linkText,
          to: linkTo
        });
      }
    }
  }
  const whats = [
    "Link has the same text as, but a different destination from, another",
    "Links have the same texts but different destinations"
  ];
  return await report(withItems, all, "linkAmb", whats, 2);
};
