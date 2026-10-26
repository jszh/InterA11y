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
const { getLocatorData } = require("../procs/getLocatorData");
const getAdjacentIndexWithWrap = (groupSize, startIndex, increment) => {
  let newIndex = startIndex + increment;
  if (newIndex < 0) {
    newIndex = groupSize - 1;
  } else if (newIndex > groupSize - 1) {
    newIndex = 0;
  }
  return newIndex;
};
const focusSuccess = async (miLocsDir, priorIndex, key, isPseudo) => {
  const result = {
    isOK: false,
    newFocIndex: null
  };
  for (const miLocDir of miLocsDir) {
    const hasFocus = await miLocDir.evaluate((el, isPseudo2) => {
      if (isPseudo2) {
        const effectiveID = document.activeElement.getAttribute("aria-activeDescendant");
        if (effectiveID) {
          const effectiveEl = document.getElementById(effectiveID);
          return effectiveEl === el;
        } else {
          return false;
        }
      } else {
        return document.activeElement === el;
      }
    }, isPseudo);
    if (hasFocus) {
      const miFocIndex = miLocsDir.indexOf(miLocDir);
      const miCount = miLocsDir.length;
      if (key === "Home" && miFocIndex === 0) {
        result.isOK = true;
        result.newFocIndex = 0;
      } else if (key === "End" && miFocIndex === miCount - 1) {
        result.isOK = true;
        result.newFocIndex = miCount - 1;
      } else if (["ArrowLeft", "ArrowUp"].includes(key)) {
        const expectedIndex = getAdjacentIndexWithWrap(miCount, priorIndex, -1);
        if (miFocIndex === expectedIndex) {
          result.isOK = true;
          result.newFocIndex = expectedIndex;
        }
      } else if (["ArrowRight", "ArrowDown"].includes(key)) {
        const expectedIndex = getAdjacentIndexWithWrap(miCount, priorIndex, 1);
        if (miFocIndex === expectedIndex) {
          result.isOK = true;
          result.newFocIndex = expectedIndex;
        }
      }
      break;
    }
  }
  return result;
};
exports.reporter = async (page, withItems, trialKeySpecs = []) => {
  const data = {};
  const totals = [0, 0, 0, 0];
  const standardInstances = [];
  const mbLocAll = page.locator(
    "button[aria-controls][aria-expanded][aria-haspopup=true], button[aria-controls][aria-expanded][aria-haspopup=menu]"
  );
  const mbLocsAll = await mbLocAll.all();
  for (const mbLoc of mbLocsAll) {
    const menuID = await mbLoc.getAttribute("aria-controls");
    const menuLoc = page.locator(`[id=${menuID}][role=menu], [id=${menuID}][role=menubar]`);
    if (menuLoc && await menuLoc.count() === 1) {
      const elData = await getLocatorData(menuLoc);
      if (elData) {
        const extraData = await menuLoc.evaluate((element) => {
          const extraData2 = {};
          let orientation = element.getAttribute("aria-orientation");
          if (!orientation) {
            const role = element.getAttribute("role");
            if (role === "menubar") {
              orientation = "horizontal";
            } else if (role === "menu") {
              orientation = "vertical";
            } else {
              orientation = null;
            }
          }
          extraData2.orientation = orientation;
          const isPseudo = !!element.getAttribute("aria-activedescendant");
          extraData2.isPseudo = isPseudo;
          return extraData2;
        });
        if (extraData) {
          const miLocAll = menuLoc.locator("[role=menuitem]:not([role=menu], [role=menubar])");
          const areDirect = await miLocAll.evaluateAll((els, menuID2) => {
            return els.map((el) => {
              const itsMenu = el.closest("[role=menu], [role=menubar]");
              return itsMenu.id && itsMenu.id === menuID2;
            });
          }, menuID);
          const miLocsAll = await miLocAll.all();
          const miLocsDir = miLocsAll.filter((loc, index) => areDirect[index]);
          if (miLocsDir.length > 1) {
            await menuLoc.evaluate((element) => {
              element.setAttribute("aria-expanded", false);
            });
            await mbLoc.press(extraData.orientation === "horizontal" ? "ArrowRight" : "ArrowDown");
            const trialKeys = [];
            if (trialKeySpecs.length) {
              trialKeySpecs.forEach((spec) => {
                if (["Home", "End"].includes(spec)) {
                  trialKeys.push(spec);
                } else if (spec === "-") {
                  trialKeys.push(extraData.orientation === "horizontal" ? "ArrowLeft" : "ArrowUp");
                } else if (spec === "+") {
                  trialKeys.push(
                    extraData.orientation === "horizontal" ? "ArrowtRight" : "ArrowDown"
                  );
                }
              });
            } else {
              const keys = ["Home", "End"];
              if (extraData.orientation === "horizontal") {
                keys.push("ArrowLeft", "ArrowRight");
              } else {
                keys.push("ArrowUp", "ArrowDown");
              }
              let trialKeyCount = 0;
              while (trialKeyCount++ < 12) {
                trialKeys.push(keys[Math.floor(4 * Math.random())]);
              }
            }
            data.trialKeys = trialKeys;
            let focIndex = 0;
            for (const key of trialKeys) {
              await page.keyboard.press(key);
              const focData = await focusSuccess(miLocsDir, focIndex, key, extraData.isPseudo);
              if (focData.isOK) {
                focIndex = focData.newFocIndex;
              } else {
                totals[2]++;
                if (withItems) {
                  standardInstances.push({
                    ruleID: "buttonMenu",
                    what: `Menu responds nonstandardly to the ${key} key`,
                    ordinalSeverity: 2,
                    tagName: elData.tagName,
                    id: elData.id,
                    location: elData.location,
                    excerpt: elData.excerpt
                  });
                }
                break;
              }
            }
          }
        } else {
          console.log("ERROR: Menu orientation and focus-management type not obtained");
        }
      } else {
        console.log("ERROR: Menu data not obtained");
      }
    } else {
      totals[2]++;
      if (withItems) {
        const mbData = await getLocatorData(mbLoc);
        standardInstances.push({
          ruleID: "buttonMenu",
          what: `Menu button does not control exactly 1 menu`,
          ordinalSeverity: 2,
          tagName: "BUTTON",
          id: await mbData.id,
          location: mbData.location,
          excerpt: mbData.excerpt
        });
      }
    }
  }
  if (!withItems && totals[2]) {
    standardInstances.push({
      ruleID: "buttonMenu",
      what: "Menu buttons and menus behave nonstandardly",
      count: totals[2],
      ordinalSeverity: 2,
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
  try {
    await page.reload({ timeout: 15e3 });
  } catch (error) {
    console.log("ERROR: page reload timed out");
  }
  return {
    data,
    totals,
    standardInstances
  };
};
