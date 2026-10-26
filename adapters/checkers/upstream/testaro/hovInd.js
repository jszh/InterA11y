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
const { getLocatorData } = require("../procs/getLocatorData");
const { getSample } = require("../procs/sample");
const standardCursor = {
  A: "pointer",
  INPUT: {
    email: "text",
    image: "pointer",
    number: "text",
    password: "text",
    search: "text",
    tel: "text",
    text: "text",
    url: "text"
  }
};
const getHoverStyles = async (loc) => await loc.evaluate((element) => {
  const {
    cursor,
    borderColor,
    borderStyle,
    borderWidth,
    outlineColor,
    outlineStyle,
    outlineWidth,
    outlineOffset,
    color,
    backgroundColor
  } = window.getComputedStyle(element);
  return {
    tagName: element.tagName,
    inputType: element.tagName === "INPUT" ? element.getAttribute("type") || "text" : null,
    cursor: cursor.replace(/^.+, */, ""),
    border: `${borderColor} ${borderStyle} ${borderWidth}`,
    outline: `${outlineColor} ${outlineStyle} ${outlineWidth} ${outlineOffset}`,
    color,
    backgroundColor
  };
});
const getCursorData = (hovStyles) => {
  const { cursor, tagName } = hovStyles;
  const data = {
    cursor
  };
  if (standardCursor[tagName]) {
    if (tagName === "INPUT") {
      data.ok = [standardCursor.INPUT[hovStyles.inputType], "default", "auto"].includes(cursor);
    } else {
      data.ok = [standardCursor.A, "auto"].includes(cursor);
    }
  } else if (tagName === "BUTTON") {
    data.ok = ["default", "auto"].includes(cursor);
  } else {
    data.ok = true;
  }
  return data;
};
const areAlike = (styles0, styles1) => {
  const areAlike2 = ["backgroundColor", "border", "color", "outline"].every((style) => styles1[style] === styles0[style]);
  return areAlike2;
};
exports.reporter = async (page, withItems, sampleSize = 20) => {
  const data = {
    typeTotals: {
      badCursor: 0,
      hoverLikeDefault: 0,
      hoverLikeFocus: 0
    }
  };
  const totals = [0, 0, 0, 0];
  const standardInstances = [];
  const selectors = ["a", "button", "input", "[onmouseenter]", "[onmouseover]"];
  const selectorString = selectors.map((selector) => `body ${selector}:visible`).join(", ");
  const locAll = page.locator(selectorString);
  const locsAll = await locAll.all();
  const psRatio = Math.max(1, locsAll.length / sampleSize);
  const sampleIndexes = getSample(locsAll, sampleSize);
  const sample = locsAll.filter((loc, index) => sampleIndexes.includes(index));
  for (const loc of sample) {
    const preStyles = await getHoverStyles(loc);
    try {
      await loc.focus({ timeout: 500 });
      const focStyles = await getHoverStyles(loc);
      try {
        await loc.blur({ timeout: 500 });
        try {
          await loc.hover({ timeout: 500 });
          const hovStyles = await getHoverStyles(loc);
          if ([focStyles, hovStyles].every((style) => style.code === preStyles.code)) {
            const elData = withItems ? await getLocatorData(loc) : null;
            const cursorData = getCursorData(hovStyles);
            if (!cursorData.ok) {
              totals[2] += psRatio;
              data.typeTotals.badCursor += psRatio;
              if (withItems) {
                standardInstances.push({
                  ruleID: "hovInd",
                  what: `Element has a nonstandard hover cursor (${cursorData.cursor})`,
                  ordinalSeverity: 2,
                  tagName: elData.tagName,
                  id: elData.id,
                  location: elData.location,
                  excerpt: elData.excerpt
                });
              }
            }
            if (hovStyles.tagName === "BUTTON" && areAlike(preStyles, hovStyles)) {
              totals[1] += psRatio;
              data.typeTotals.hoverLikeDefault += psRatio;
              if (withItems) {
                standardInstances.push({
                  ruleID: "hovInd",
                  what: "Element border, outline, color, and background color do not change when hovered over",
                  ordinalSeverity: 1,
                  tagName: elData.tagName,
                  id: elData.id,
                  location: elData.location,
                  excerpt: elData.excerpt
                });
              }
            }
            if (areAlike(hovStyles, focStyles) && !areAlike(hovStyles, preStyles)) {
              totals[1] += psRatio;
              data.typeTotals.hoverLikeFocus += psRatio;
              if (withItems) {
                standardInstances.push({
                  ruleID: "hovInd",
                  what: "Element border, outline, color, and background color are alike on hover and focus",
                  ordinalSeverity: 1,
                  tagName: elData.tagName,
                  id: elData.id,
                  location: elData.location,
                  excerpt: elData.excerpt
                });
              }
            }
          } else {
            data.prevented = true;
            data.error = "ERROR: Page changes on focus or hover prevent test";
            break;
          }
        } catch (error) {
          data.prevented = true;
          data.error = "ERROR: Hovering failed";
          break;
        }
      } catch (error) {
        data.prevented = true;
        data.error = "ERROR: Blurring failed";
        break;
      }
    } catch (error) {
      data.prevented = true;
      data.error = "ERROR: Focusing failed";
      break;
    }
  }
  Object.keys(data.typeTotals).forEach((rule) => {
    data.typeTotals[rule] = Math.round(data.typeTotals[rule]);
  });
  for (const index in totals) {
    totals[index] = Math.round(totals[index]);
  }
  if (!withItems) {
    if (data.typeTotals.badCursor) {
      standardInstances.push({
        ruleID: "hovInd",
        what: "Elements have nonstandard hover cursors",
        ordinalSeverity: 2,
        count: data.typeTotals.badCursor,
        tagName: "",
        id: "",
        location: {
          doc: "",
          type: "",
          spec: ""
        },
        excerpt: ""
      });
    }
    if (data.typeTotals.hoverLikeDefault) {
      standardInstances.push({
        ruleID: "hovInd",
        what: "Element borders, outlines, and background colors do not change when hovered over",
        ordinalSeverity: 1,
        count: data.typeTotals.hoverLikeDefault,
        tagName: "",
        id: "",
        location: {
          doc: "",
          type: "",
          spec: ""
        },
        excerpt: ""
      });
    }
    if (data.typeTotals.hoverLikeFocus) {
      standardInstances.push({
        ruleID: "hovInd",
        what: "Element borders, outlines, and background colors on focus and on hover do not differ",
        ordinalSeverity: 1,
        count: data.typeTotals.hoverLikeFocus,
        tagName: "",
        id: "",
        location: {
          doc: "",
          type: "",
          spec: ""
        },
        excerpt: ""
      });
    }
  }
  return {
    data,
    totals,
    standardInstances
  };
};
