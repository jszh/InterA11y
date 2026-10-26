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
exports.reporter = async (page) => {
  const locAll = await page.locator("body *:visible");
  const focusableCount = await locAll.evaluateAll((elements) => {
    const focusables = elements.filter((element) => element.tabIndex === 0);
    const radios = focusables.filter((el) => el.tagName === "INPUT" && el.type === "radio");
    const radioNames = new Set(radios.map((radio) => radio.name));
    return focusables.length - radios.length + radioNames.size;
  });
  let tabFocused = 0;
  let refocused = 0;
  const keyName = page.browserID === "webkit" ? "Alt+Tab" : "Tab";
  while (refocused < 100 && tabFocused < 2e3) {
    await page.keyboard.press(keyName);
    const isNewFocus = await page.evaluate(() => {
      const focus = document.activeElement;
      if (focus === null || focus.tagName === "BODY" || focus.dataset.testarofocused) {
        return false;
      } else {
        focus.dataset.testarofocused = "true";
        return true;
      }
    });
    if (isNewFocus) {
      tabFocused++;
    } else {
      refocused++;
    }
  }
  const data = {
    focusableCount,
    tabFocused,
    discrepancy: tabFocused - focusableCount
  };
  try {
    await page.reload({ timeout: 15e3 });
  } catch (error) {
    console.log("ERROR: page reload timed out");
  }
  const count = Math.abs(data.discrepancy);
  return {
    data,
    totals: [0, 0, count, 0],
    standardInstances: count ? [{
      ruleID: "focAll",
      what: "Some focusable elements are not Tab-focusable or vice versa",
      count,
      ordinalSeverity: 2,
      tagName: "",
      id: "",
      location: {
        doc: "",
        type: "",
        spec: ""
      },
      excerpt: ""
    }] : []
  };
};
