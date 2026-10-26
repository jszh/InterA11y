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
  const all = await init(100, page, "input[type=radio]");
  const params = {
    nameLeak: "shares a name with others outside its field set",
    fsMixed: "shares a field set with others having different names",
    only1RB: "is the only one with its name in its field set",
    legendBad: "is in a field set without a valid legend",
    noFS: "is not in a field set",
    noName: "has no name attribute"
  };
  for (const loc of all.allLocs) {
    const howBad = await loc.evaluate((el) => {
      const elName = el.name;
      if (elName) {
        const elFS = el.closest("fieldset");
        if (elFS) {
          const fsChild1 = elFS.firstElementChild;
          const legendOK = fsChild1.tagName === "LEGEND" && fsChild1.textContent.replace(/\s/g, "").length;
          if (legendOK) {
            const nameGroupSize = elFS.querySelectorAll(`input[type=radio][name=${elName}]`).length;
            if (nameGroupSize > 1) {
              const groupSize = elFS.querySelectorAll("input[type=radio]").length;
              if (groupSize === nameGroupSize) {
                const nameDocSize = document.querySelectorAll(`input[type=radio][name=${elName}]`).length;
                if (nameDocSize === nameGroupSize) {
                  return false;
                } else {
                  return "nameLeak";
                }
              } else {
                return "fsMixed";
              }
            } else {
              return "only1RB";
            }
          } else {
            return "legendBad";
          }
        } else {
          return "noFS";
        }
      } else {
        return "noName";
      }
    });
    if (howBad) {
      all.locs.push([loc, params[howBad]]);
    }
  }
  const whats = [
    "Radio button __param__",
    "Radio buttons are not validly grouped in fieldsets with legends"
  ];
  return await report(withItems, all, "radioSet", whats, 2, "INPUT");
};
