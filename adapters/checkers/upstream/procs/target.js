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
const { isInlineLink } = require("./isInlineLink");
exports.isTooSmall = async (loc, min) => {
  let sizeData = null;
  if (!await isInlineLink(loc)) {
    sizeData = await loc.evaluate((el, min2) => {
      const styleDec = window.getComputedStyle(el);
      const displayStyle = styleDec.display;
      if (displayStyle === "none") {
        return null;
      } else {
        const getDims = (el2) => {
          const rect = el2.getBoundingClientRect();
          const widthR = rect && rect.width || 0;
          const heightR = rect && rect.height || 0;
          const widthP = el2.offsetWidth || 0;
          const width = Math.max(widthP, Math.round(widthR));
          const heightP = el2.offsetHeight || 0;
          const height = Math.max(heightP, Math.round(heightR));
          return [width, height];
        };
        const tagName = el.tagName;
        const elDims = getDims(el);
        if (elDims.some((dim) => dim < min2)) {
          const elParent = el.parentElement;
          if (elParent) {
            const elGeneration = Array.from(elParent.children);
            if (elGeneration.filter((peer) => peer.tagName === tagName).length === 1) {
              const parentDims = getDims(elParent);
              elDims.forEach((elDim, index) => {
                if (elDim < min2 && parentDims[index] > elDim) {
                  elDims[index] = parentDims[index];
                }
              });
            }
          } else {
            console.log(`WARNING: Target ${tagName} (${el.innerHTML}) has no parent element`);
          }
        }
        const isSmall = elDims.some((dim) => dim < min2);
        return isSmall ? { tagName, width: elDims[0], height: elDims[1] } : null;
      }
    }, min);
  }
  return sizeData;
};
