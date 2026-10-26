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
exports.reporter = async (page, withItems) => {
  const allTrigger = await init(
    20,
    page,
    "[aria-controls], [aria-expanded], [aria-haspopup], [onmouseenter], [onmouseover]"
  );
  const allNonTrigger = await init(
    30 - allTrigger.result.data.sampleSize,
    page,
    "body *:not([aria-controls], [aria-expanded], [aria-haspopup], [onmouseenter], [onmouseover])"
  );
  const populationSize = allTrigger.result.data.populationSize + allNonTrigger.result.data.populationSize;
  const sampleSize = allTrigger.result.data.sampleSize + allNonTrigger.result.data.sampleSize;
  const all = {
    allLocs: allTrigger.allLocs.concat(allNonTrigger.allLocs),
    locs: [],
    result: {
      data: {
        populationSize,
        sampleSize,
        populationRatio: sampleSize ? populationSize / sampleSize : null
      },
      totals: [0, 0, 0, 0],
      standardInstances: []
    }
  };
  for (const loc of all.allLocs) {
    await page.mouse.move(0, 0);
    const loc0 = page.locator("body *:visible");
    const elementCount0 = await loc0.count();
    try {
      await loc.hover({
        force: true,
        timeout: 100
      });
      const loc1 = page.locator("body *:visible");
      const elementCount1 = await loc1.count();
      const additions = elementCount1 - elementCount0;
      if (additions !== 0) {
        const impact = additions > 0 ? `added ${additions} elements to the page` : `subtracted ${-additions} from the page`;
        all.locs.push([loc, impact]);
      }
    } catch (error) {
      const { data } = all.result;
      data.prevented = true;
      data.error = "ERROR hovering over an element";
      break;
    }
  }
  const whats = [
    "Hovering over the element __param__",
    "Hovering over elements adds elements to or subtracts elements from the page"
  ];
  try {
    await page.reload({ timeout: 15e3 });
  } catch (error) {
    console.log("ERROR: page reload timed out");
  }
  return await report(withItems, all, "hover", whats, 0);
};
