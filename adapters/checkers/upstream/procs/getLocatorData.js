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
exports.getLocatorData = async (loc) => {
  const locCount = await loc.count();
  if (locCount === 1) {
    const data = await loc.evaluate((element) => {
      const tagName = element.tagName;
      const id = element.id || "";
      const { textContent } = element;
      const alts = Array.from(element.querySelectorAll('img[alt]:not([alt=""])'));
      const altTexts = alts.map((alt) => alt.getAttribute("alt"));
      const altsText = altTexts.join(" ");
      const ariaLabelText = element.ariaLabel || "";
      const refLabelID = element.getAttribute("aria-labelledby");
      const refLabel = refLabelID ? document.getElementById(refLabelID) : "";
      const refLabelText = refLabel ? refLabel.textContent : "";
      let labelsText = "";
      if (tagName === "INPUT") {
        const labels = element.labels || [];
        const labelTexts = [];
        labels.forEach((label) => {
          labelTexts.push(label.textContent);
        });
        labelsText = labelTexts.join(" ");
      }
      let text = [textContent, altsText, ariaLabelText, refLabelText, labelsText].join(" ").replace(/\s+/g, " ").trim();
      if (!text) {
        text = element.outerHTML.replace(/\s+/g, " ").trim();
      }
      if (/^<[^<>]+>$/.test(text)) {
        text = element.parentElement.outerHTML.replace(/\s+/g, " ").trim();
      }
      let location = {
        doc: "dom",
        type: "box",
        spec: {}
      };
      if (id) {
        location.type = "selector";
        location.spec = `#${id}`;
      }
      return {
        tagName,
        id,
        location,
        excerpt: text
      };
    });
    if (data.location.type === "box") {
      const rawSpec = await loc.boundingBox();
      if (rawSpec) {
        Object.keys(rawSpec).forEach((specName) => {
          data.location.spec[specName] = Math.round(rawSpec[specName]);
        });
      } else {
        data.location.doc = "";
        data.location.type = "";
        data.location.spec = "";
      }
    }
    if (data.excerpt.length > 400) {
      data.excerpt = `${data.excerpt.slice(0, 200)} \u2026 ${data.excerpt.slice(-200)}`;
    }
    return data;
  } else {
    console.log(`ERROR: Locator count to get data from is ${locCount} instead of 1`);
    return null;
  }
};
