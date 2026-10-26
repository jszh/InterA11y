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
exports.reporter = async (page, withItems, detailLevel, text = "") => {
  let data = {};
  try {
    data = await page.evaluate((args) => {
      const detailLevel2 = args[0];
      const text2 = args[1];
      const matchNodes = [];
      document.body.normalize();
      const extraElements = Array.from(document.body.querySelectorAll("style, script, svg"));
      extraElements.forEach((element) => {
        element.textContent = "";
      });
      const compact = (string) => string.replace(/\s+/g, " ").trim();
      const toStandardString = (string) => compact(string).toLowerCase();
      const getElementData = (element, withText) => {
        const data3 = {
          tagName: element.tagName
        };
        if (!["STYLE", "SCRIPT", "SVG", "svg"].includes(element.tagName)) {
          if (withText) {
            data3.text = compact(element.textContent);
          }
          const { attributes } = element;
          if (attributes) {
            data3.attributes = [];
            for (const attribute of attributes) {
              const { name, value } = attribute;
              data3.attributes.push({
                name,
                value
              });
              if (name === "aria-labelledby") {
                const labelerIDs = value.split(/\s+/);
                data3.refLabels = [];
                labelerIDs.forEach((id) => {
                  const labeler = document.getElementById(id);
                  if (labeler) {
                    data3.refLabels.push(compact(labeler.textContent));
                  }
                });
              }
            }
          }
          const { labels } = element;
          if (labels && labels.length) {
            data3.labels = Array.from(labels).map((label) => compact(label.textContent));
          }
          if (element.childElementCount) {
            const children = Array.from(element.children);
            data3.children = [];
            children.forEach((child) => {
              data3.children.push(getElementData(child, true));
            });
          }
        }
        return data3;
      };
      const stdText = toStandardString(text2);
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const data2 = { nodeCount: 0 };
      let more = true;
      while (more) {
        if (walker.nextNode()) {
          const stdCurrent = toStandardString(walker.currentNode.nodeValue);
          if (stdCurrent.includes(stdText)) {
            data2.nodeCount++;
            matchNodes.push(walker.currentNode);
          }
        } else {
          more = false;
        }
      }
      if (detailLevel2 > 0) {
        data2.items = [];
        matchNodes.forEach((node) => {
          const itemData = { text: compact(node.nodeValue) };
          if (detailLevel2 > 1) {
            itemData.ancestors = [];
            let base = node;
            let currentLevel = 1;
            while (currentLevel++ < detailLevel2) {
              const newBase = base.parentElement;
              itemData.ancestors.push(getElementData(newBase, currentLevel > 2));
              base = newBase;
            }
          }
          data2.items.push(itemData);
        });
      }
      return data2;
    }, [detailLevel, text]);
  } catch (error) {
    console.log(`ERROR performing test (${error.message.replace(/\n.+/s, "")})`);
    data = {
      prevented: true,
      error: "Test failed"
    };
  }
  return {
    data,
    totals: [],
    standardInstances: []
  };
};
