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
const linksByType = async (page) => await page.evaluateHandle(() => {
  const despace = (text) => text.replace(/\s/g, "");
  const isLinkList = (list) => {
    const listItems = Array.from(list.children);
    if (listItems.length > 1) {
      return listItems.length > 1 && listItems.every((item) => {
        if (item.tagName === "LI") {
          const { children } = item;
          if (children.length === 1) {
            const link = children[0];
            if (link.tagName === "A") {
              const itemText = despace(item.textContent);
              const linkText = despace(link.textContent);
              return itemText.length === linkText.length;
            } else {
              return false;
            }
          } else {
            return false;
          }
        } else {
          return false;
        }
      });
    } else {
      return false;
    }
  };
  const lists = Array.from(document.body.querySelectorAll("ul, ol"));
  const listLinks = [];
  lists.forEach((list) => {
    if (isLinkList(list)) {
      listLinks.push(...Array.from(list.querySelectorAll("a")));
    }
  });
  const allLinks = Array.from(document.body.querySelectorAll("a"));
  const inlineLinks = allLinks.filter((link) => !listLinks.includes(link));
  return {
    adjacent: inlineLinks,
    list: listLinks
  };
});
exports.reporter = async (page, withItems) => {
  const linkTypes = await linksByType(page);
  return await page.evaluate((args) => {
    const linkTypes2 = args[0];
    const withItems2 = args[1];
    const { body } = document;
    const mainStyles = [
      "fontStyle",
      "fontWeight",
      "opacity",
      "textDecorationLine",
      "textDecorationStyle",
      "textDecorationThickness"
    ];
    const buttonStyles = [
      "borderStyle",
      "borderWidth",
      "height",
      "lineHeight",
      "maxHeight",
      "maxWidth",
      "minHeight",
      "minWidth",
      "outlineOffset",
      "outlineStyle",
      "outlineWidth"
    ];
    const headingStyles = [
      "color",
      "fontSize"
    ];
    const listLinkStyles = [
      "color",
      "fontSize",
      "lineHeight"
    ];
    const data = {
      mainStyles,
      buttonStyles,
      headingStyles,
      listLinkStyles,
      totals: {}
    };
    if (withItems2) {
      data.items = {};
    }
    const elements = {
      buttons: [],
      headings: {
        h1: [],
        h2: [],
        h3: [],
        h4: [],
        h5: [],
        h6: []
      },
      links: {
        adjacent: linkTypes2.adjacent,
        list: linkTypes2.list
      }
    };
    const headingNames = Object.keys(elements.headings);
    elements.buttons = Array.from(body.querySelectorAll("button, input[type=button]"));
    headingNames.forEach((tagName) => {
      elements.headings[tagName] = Array.from(body.getElementsByTagName(tagName));
    });
    const tallyStyles = (typeName, elements2, typeStyles, withItems3) => {
      const elementCount = elements2.length;
      if (elementCount) {
        const styleProps = {};
        const styleTexts = {};
        elements2.forEach((element) => {
          const styleDec = window.getComputedStyle(element);
          const style = {};
          const styles = mainStyles.concat(typeStyles);
          styles.forEach((styleName) => {
            style[styleName] = styleDec[styleName];
          });
          const styleText = JSON.stringify(style);
          styleTexts[styleText] = ++styleTexts[styleText] || 1;
          if (withItems3) {
            if (!styleProps[typeName]) {
              styleProps[typeName] = {};
            }
            const elementText = (element.textContent.trim() || element.outerHTML.trim()).replace(/\s+/g, " ").slice(0, 100);
            styles.forEach((styleName) => {
              if (!styleProps[typeName][styleName]) {
                styleProps[typeName][styleName] = {};
              }
              if (!styleProps[typeName][styleName][style[styleName]]) {
                styleProps[typeName][styleName][style[styleName]] = [];
              }
              styleProps[typeName][styleName][style[styleName]].push(elementText);
            });
          }
        });
        data.totals[typeName] = { total: elementCount };
        const styleCounts = Object.values(styleTexts);
        if (styleCounts.length > 1) {
          data.totals[typeName].subtotals = styleCounts.sort((a, b) => b - a);
          if (withItems3) {
            Object.keys(styleProps[typeName]).forEach((styleName) => {
              if (Object.keys(styleProps[typeName][styleName]).length === 1) {
                delete styleProps[typeName][styleName];
              }
            });
            data.items[typeName] = styleProps[typeName];
          }
        }
      }
    };
    tallyStyles("button", elements.buttons, buttonStyles, withItems2);
    tallyStyles("adjacentLink", elements.links.adjacent, [], withItems2);
    tallyStyles("listLink", elements.links.list, listLinkStyles, withItems2);
    headingNames.forEach((headingName) => {
      tallyStyles(headingName, elements.headings[headingName], headingStyles, withItems2);
    });
    const totals = [0, 0, 0, 0];
    const standardInstances = [];
    const elementData = {
      adjacentLink: [0, "In-line links", "A"],
      listLink: [1, "Links in columns", "A"],
      button: [2, "Buttons", "BUTTON"],
      h1: [3, "Level-1 headings", "H1"],
      h2: [3, "Level-2 headings", "H2"],
      h3: [3, "Level-3 headings", "H3"],
      h4: [3, "Level-4 headings", "H4"],
      h5: [3, "Level-5 headings", "H5"],
      h6: [3, "Level-6 headings", "H6"]
    };
    Object.keys(elementData).forEach((elementName) => {
      const elementTotal = data.totals[elementName];
      if (elementTotal && elementTotal.subtotals) {
        const currentData = elementData[elementName];
        const severity = currentData[0];
        const elementSubtotals = elementTotal.subtotals;
        const extraCount = elementSubtotals.length - 1;
        totals[severity] += extraCount;
        standardInstances.push({
          ruleID: "styleDiff",
          what: `${currentData[1]} have ${elementSubtotals.length} different styles`,
          count: extraCount,
          ordinalSeverity: severity,
          tagName: currentData[2],
          id: "",
          location: {
            doc: "",
            type: "",
            spec: ""
          },
          excerpt: ""
        });
      }
    });
    return {
      data,
      totals,
      standardInstances
    };
  }, [linkTypes, withItems]);
};
