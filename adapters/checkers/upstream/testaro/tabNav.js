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
const data = {};
const allText = async (page, elementHandle) => await page.evaluate((element) => {
  const el = element || document.activeElement;
  const texts = [];
  const debloat = (text) => text.trim().replace(/\s+/g, " ");
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) {
    const trimmedLabel = debloat(ariaLabel);
    if (trimmedLabel) {
      texts.push(trimmedLabel);
    }
  }
  const labelNodeList = el.labels;
  if (labelNodeList && labelNodeList.length) {
    const labels = Array.from(labelNodeList);
    const labelTexts = labels.map((label) => label.textContent && debloat(label.textContent)).filter((text) => text);
    if (labelTexts.length) {
      texts.push(...labelTexts);
    }
  }
  if (el.hasAttribute("aria-labelledby")) {
    const labelerIDs = el.getAttribute("aria-labelledby").split(/\s+/);
    labelerIDs.forEach((id2) => {
      const labeler = document.getElementById(id2);
      if (labeler) {
        const labelerText = debloat(labeler.textContent);
        if (labelerText) {
          texts.push(labelerText);
        }
      }
    });
  }
  const altTexts = Array.from(element.querySelectorAll('img[alt]:not([alt=""])')).map((img) => debloat(img.alt)).join("; ");
  if (altTexts.length) {
    texts.push(altTexts);
  }
  const ownText = element.textContent;
  if (ownText) {
    const minText = debloat(ownText);
    if (minText) {
      texts.push(minText.slice(0, 100));
    }
  }
  const id = element.id;
  if (id) {
    texts.push(`#${id}`);
  }
  let textChain = texts.join("; ");
  if (!textChain) {
    textChain = `{${debloat(element.outerHTML)}}`;
    if (textChain === "{}") {
      textChain = "";
    }
  }
  return textChain;
}, elementHandle);
const focusedTab = async (tabs, page) => await page.evaluate((tabs2) => {
  const focus = document.activeElement;
  return tabs2.indexOf(focus);
}, tabs).catch((error) => {
  console.log(`ERROR: could not find focused tab (${error.message})`);
  return -1;
});
const testKey = async (tabs, tabElement, keyName, keyProp, goodIndex, elementIsCorrect, itemData, withItems, page) => {
  let pressed = true;
  await tabElement.click({
    timeout: 500
  }).catch(async (error) => {
    console.log(
      `ERROR clicking tab element ${itemData.text} (${error.message.replace(/\n.+/s, "")})`
    );
    await tabElement.click({
      force: true
    });
  }).catch((error) => {
    console.log(
      `ERROR force-clicking tab element ${itemData.text} (${error.message.replace(/\n.+/s, "")})`
    );
    pressed = false;
  });
  data.totals.navigations.all.total++;
  data.totals.navigations.specific[keyProp].total++;
  const { navigationErrors } = itemData;
  if (pressed) {
    await tabElement.press(keyName, {
      timeout: 1e3
    }).catch((error) => {
      console.log(`ERROR: could not press ${keyName} (${error.message})`);
      pressed = false;
    });
    if (pressed) {
      const focusIndex = await focusedTab(tabs, page);
      if (focusIndex === goodIndex) {
        data.totals.navigations.all.correct++;
        data.totals.navigations.specific[keyProp].correct++;
      } else {
        data.totals.navigations.all.incorrect++;
        data.totals.navigations.specific[keyProp].incorrect++;
        elementIsCorrect = false;
        if (withItems) {
          navigationErrors.push(keyName);
        }
      }
      return elementIsCorrect;
    } else {
      data.totals.navigations.all.incorrect++;
      data.totals.navigations.specific[keyProp].incorrect++;
      if (withItems && !navigationErrors.includes("focus")) {
        navigationErrors.push("focus");
      }
      return false;
    }
  } else {
    data.totals.navigations.all.incorrect++;
    data.totals.navigations.specific[keyProp].incorrect++;
    if (withItems && !navigationErrors.includes("click")) {
      navigationErrors.push("click");
    }
    return false;
  }
};
const arrowTarget = (startIndex, tabCount, orientation, direction) => {
  if (orientation === "horizontal") {
    if (["up", "down"].includes(direction)) {
      return startIndex;
    } else if (direction === "left") {
      return startIndex ? startIndex - 1 : tabCount - 1;
    } else if (direction === "right") {
      return startIndex === tabCount - 1 ? 0 : startIndex + 1;
    }
  } else if (orientation === "vertical") {
    if (["left", "right"].includes(direction)) {
      return startIndex;
    } else if (direction === "up") {
      return startIndex ? startIndex - 1 : tabCount - 1;
    } else if (direction === "down") {
      return startIndex === tabCount - 1 ? 0 : startIndex + 1;
    }
  }
};
const testTabs = async (tabs, index, listOrientation, listIsCorrect, withItems, page) => {
  const tabCount = tabs.length;
  if (index < tabCount) {
    data.totals.tabElements.total++;
    const currentTab = tabs[index];
    let isCorrect = true;
    const itemData = {};
    if (withItems) {
      let found = true;
      const moreItemData = await page.evaluate((element) => ({
        tagName: element.tagName,
        id: element.id
      }), currentTab).catch((error) => {
        console.log(`ERROR: could not get tag name (${error.message})`);
        found = false;
        data.prevented = true;
        return "ERROR: not found";
      });
      if (found) {
        itemData.tagName = moreItemData.tagName;
        itemData.id = moreItemData.id;
        itemData.text = await allText(page, currentTab);
        itemData.navigationErrors = [];
      }
    }
    isCorrect = await testKey(
      tabs,
      currentTab,
      "Tab",
      "tab",
      -1,
      isCorrect,
      itemData,
      withItems,
      page
    );
    isCorrect = await testKey(
      tabs,
      currentTab,
      "ArrowLeft",
      "left",
      arrowTarget(index, tabCount, listOrientation, "left"),
      isCorrect,
      itemData,
      withItems,
      page
    );
    isCorrect = await testKey(
      tabs,
      currentTab,
      "ArrowRight",
      "right",
      arrowTarget(index, tabCount, listOrientation, "right"),
      isCorrect,
      itemData,
      withItems,
      page
    );
    isCorrect = await testKey(
      tabs,
      currentTab,
      "ArrowUp",
      "up",
      arrowTarget(index, tabCount, listOrientation, "up"),
      isCorrect,
      itemData,
      withItems,
      page
    );
    isCorrect = await testKey(
      tabs,
      currentTab,
      "ArrowDown",
      "down",
      arrowTarget(index, tabCount, listOrientation, "down"),
      isCorrect,
      itemData,
      withItems,
      page
    );
    isCorrect = await testKey(
      tabs,
      currentTab,
      "Home",
      "home",
      0,
      isCorrect,
      itemData,
      withItems,
      page
    );
    isCorrect = await testKey(
      tabs,
      currentTab,
      "End",
      "end",
      tabCount - 1,
      isCorrect,
      itemData,
      withItems,
      page
    );
    listIsCorrect = listIsCorrect && isCorrect;
    data.totals.tabElements[isCorrect ? "correct" : "incorrect"]++;
    if (withItems) {
      data.tabElements[isCorrect ? "correct" : "incorrect"].push(itemData);
    }
    return await testTabs(tabs, index + 1, listOrientation, listIsCorrect, withItems, page);
  } else {
    return listIsCorrect;
  }
};
const testTabLists = async (tabLists, withItems, page) => {
  if (tabLists.length) {
    const firstTabList = tabLists[0];
    let orientation = await firstTabList.getAttribute("aria-orientation").catch((error) => {
      console.log(`ERROR: could not get tab-list orientation (${error.message})`);
      return "ERROR";
    });
    if (!orientation) {
      orientation = "horizontal";
    }
    if (orientation === "ERROR") {
      data.prevented = true;
    } else {
      const tabs = await firstTabList.$$("[role=tab]");
      if (tabs.length > 1) {
        const isCorrect = await testTabs(tabs, 0, orientation, true, withItems, page);
        data.totals.tabLists.total++;
        data.totals.tabLists[isCorrect ? "correct" : "incorrect"]++;
        await testTabLists(tabLists.slice(1), withItems, page);
      }
    }
  }
};
exports.reporter = async (page, withItems) => {
  data.totals = {
    navigations: {
      all: {
        total: 0,
        correct: 0,
        incorrect: 0
      },
      specific: {
        tab: {
          total: 0,
          correct: 0,
          incorrect: 0
        },
        left: {
          total: 0,
          correct: 0,
          incorrect: 0
        },
        right: {
          total: 0,
          correct: 0,
          incorrect: 0
        },
        up: {
          total: 0,
          correct: 0,
          incorrect: 0
        },
        down: {
          total: 0,
          correct: 0,
          incorrect: 0
        },
        home: {
          total: 0,
          correct: 0,
          incorrect: 0
        },
        end: {
          total: 0,
          correct: 0,
          incorrect: 0
        }
      }
    },
    tabElements: {
      total: 0,
      correct: 0,
      incorrect: 0
    },
    tabLists: {
      total: 0,
      correct: 0,
      incorrect: 0
    }
  };
  if (withItems) {
    data.tabElements = {
      incorrect: [],
      correct: []
    };
  }
  const tabLists = await page.$$("[role=tablist]:visible");
  if (tabLists.length) {
    await testTabLists(tabLists, withItems, page);
    try {
      await page.reload({ timeout: 15e3 });
    } catch (error) {
      console.log("ERROR: page reload timed out");
    }
  }
  const totals = data.totals ? [
    data.totals.navigations.all.incorrect,
    data.totals.tabElements.incorrect,
    data.totals.tabLists.incorrect,
    0
  ] : [];
  const standardInstances = [];
  if (withItems) {
    data.tabElements.incorrect.forEach((item) => {
      standardInstances.push({
        ruleID: "tabNav",
        what: `Tab responds nonstandardly to ${item.navigationErrors.join(", ")}`,
        ordinalSeverity: 1,
        tagName: item.tagName,
        id: item.id,
        location: {
          doc: "",
          type: "",
          spec: ""
        },
        excerpt: item.text
      });
    });
  } else if (data.totals.navigations.all.incorrect) {
    standardInstances.push({
      ruleID: "tabNav",
      what: "Tab lists have nonstandard navigation",
      ordinalSeverity: 1,
      count: data.totals.navigations.all.incorrect,
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
  return {
    data,
    totals,
    standardInstances
  };
};
