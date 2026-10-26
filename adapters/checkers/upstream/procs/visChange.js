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
const { PNG } = require("pngjs");
const shoot = async (page, exclusion = null) => {
  const options = {
    fullPage: true,
    omitBackground: true,
    timeout: 2e3
  };
  if (exclusion) {
    options.mask = [exclusion];
  }
  return await page.screenshot(options).catch((error) => {
    console.log(`ERROR: Screenshot failed (${error.message})`);
    return "";
  });
};
exports.visChange = async (page, options = {}) => {
  const { delayBefore, delayBetween, exclusion } = options;
  if (delayBefore) {
    await page.waitForTimeout(delayBefore);
  }
  if (exclusion) {
    const docLoc = page.locator("html");
    await docLoc.hover({
      position: {
        x: 0,
        y: 0
      }
    });
  }
  const shot0 = await shoot(page, exclusion);
  if (shot0.length) {
    if (exclusion) {
      try {
        await exclusion.hover({
          timeout: 500,
          noWaitAfter: true
        });
      } catch (error) {
        return {
          success: false,
          error: "Hovering failed"
        };
      }
    }
    await page.waitForTimeout(delayBetween || 3e3);
    const shot1 = await shoot(page, exclusion);
    if (shot1.length) {
      const pngs = [shot0, shot1].map((shot) => PNG.sync.read(shot));
      const { width, height } = pngs[0];
      const pixelmatchModule = await import("pixelmatch");
      const pixelmatch = pixelmatchModule.default;
      const pixelChanges = pixelmatch(pngs[0].data, pngs[1].data, null, width, height);
      const changePercent = 100 * pixelChanges / (width * height);
      return {
        success: true,
        width,
        height,
        pixelChanges,
        changePercent
      };
    } else {
      return {
        success: false,
        prevented: true,
        error: "Second screenshot failed"
      };
    }
  } else {
    return {
      success: false,
      prevented: true,
      error: "First screenshot failed"
    };
  }
};
