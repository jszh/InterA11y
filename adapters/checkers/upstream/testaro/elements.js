/*
  © 2023 CVS Health and/or one of its affiliates. All rights reserved.

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
exports.reporter = async (page, withItems, detailLevel = 0, tagName = null, onlyVisible = false, attribute) => {
  let selector = `body ${tagName ? tagName.toLowerCase() : "*"}`;
  if (attribute) {
    selector += `[${attribute}]`;
  }
  if (onlyVisible) {
    selector += ":visible";
  }
  let data = {};
  try {
    const locator = page.locator(selector);
    data = await locator.evaluateAll((elements, detailLevel2) => {
      const compact = (string) => string.replace(/\s+/g, " ").trim();
      const getSibInfo = (node, nodeType, text) => {
        const sibInfo = {
          type: nodeType
        };
        if (nodeType === 1) {
          sibInfo.tagName = node.tagName;
          sibInfo.attributes = [];
          Array.from(node.attributes).forEach((attribute2) => {
            sibInfo.attributes.push({
              name: attribute2.name,
              value: attribute2.value
            });
          });
        } else if (nodeType === 3) {
          sibInfo.text = compact(text);
        }
        return sibInfo;
      };
      const data2 = {
        total: elements.length
      };
      if (detailLevel2 === 0) {
        return data2;
      } else {
        data2.items = [];
        elements.forEach((element) => {
          const parent = element.parentElement;
          const datum = {
            tagName: element.tagName,
            parentTagName: parent ? parent.tagName : "",
            code: compact(element.outerHTML),
            attributes: [],
            textContent: compact(element.textContent)
          };
          for (const attribute2 of element.attributes) {
            const { name, value } = attribute2;
            datum.attributes.push({
              name,
              value
            });
            if (name === "aria-labelledby") {
              const labelerIDs = value.split(/\s+/);
              const labelers = [];
              labelerIDs.forEach((id) => {
                const labeler = document.getElementById(id);
                if (labeler) {
                  labelers.push(compact(labeler.textContent));
                }
              });
              if (labelers.length) {
                datum.labelers = labelers;
              }
            }
          }
          const { labels, textContent } = element;
          const compactContent = compact(textContent);
          if (compactContent) {
            datum.textContent = compactContent;
          }
          if (labels && labels.length) {
            datum.labels = Array.from(labels).map((label) => compact(label.textContent));
          }
          if (detailLevel2 > 1) {
            datum.parentTextContent = parent ? compact(parent.textContent) : "";
          }
          if (detailLevel2 === 3) {
            datum.siblings = {
              before: [],
              after: []
            };
            let more = element;
            while (more) {
              more = more.previousSibling;
              if (more) {
                const { nodeType, nodeValue } = more;
                if (!(nodeType === 3 && nodeValue === "")) {
                  const sibInfo = getSibInfo(more, nodeType, nodeValue);
                  datum.siblings.before.unshift(sibInfo);
                }
              }
            }
            more = element;
            while (more) {
              more = more.nextSibling;
              if (more) {
                const { nodeType, textContent: textContent2 } = more;
                if (!(nodeType === 3 && textContent2 === "")) {
                  const sibInfo = getSibInfo(more, nodeType, compact(textContent2));
                  datum.siblings.after.push(sibInfo);
                }
              }
            }
          }
          data2.items.push(datum);
        });
        return data2;
      }
    }, detailLevel);
  } catch (error) {
    console.log(`ERROR performing test (${error.message})`);
    data = {
      prevented: true,
      error: "ERROR performing test"
    };
  }
  return {
    data,
    totals: [],
    standardInstances: []
  };
};
