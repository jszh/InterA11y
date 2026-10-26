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
const { getSource } = require("../procs/getSource");
exports.reporter = async (page, withItems) => {
  const data = { total: 0 };
  if (withItems) {
    data.items = [];
  }
  let totals = [];
  const standardInstances = [];
  const sourceData = await getSource(page);
  if (sourceData.prevented) {
    data.prevented = true;
    data.error = sourceData.error;
  } else {
    let rawPage = sourceData.source;
    rawPage = rawPage.replace(/\s+/g, " ");
    rawPage = rawPage.replace(/ = | =|= /g, "=");
    rawPage = rawPage.replace(/\\"|\\'/g, "");
    rawPage = rawPage.replace(/<script(?: [^<>]+)?>.*?<\/script>/g, "");
    rawPage = rawPage.replace(/<script(?: [^<>]+)?>/g, "");
    rawPage = rawPage.replace(/<\/script>/g, "");
    rawPage = rawPage.replace(/<!--.*?-->/g, "");
    let elements = rawPage.match(/<[a-zA-Z]+(?: [^<>]+)?>/g);
    elements = elements.map((element) => element.replace(/< ?| ?\/?>/g, ""));
    const nvElements = elements.map((element) => element.replace(/="[^"]*"/g, ""));
    nvElements.forEach((element, index) => {
      const terms = element.split(" ");
      if (terms.length > 2) {
        const tagName = terms[0].toUpperCase();
        const attributes = terms.slice(1);
        attributes.sort();
        const duplicatedAttribute = attributes.find(
          (current, attIndex) => attributes[attIndex + 1] === current
        );
        if (duplicatedAttribute) {
          const id = terms.includes("id") ? elements[index].replace(/^.+id="/, "").replace(/".+/, "") : "";
          data.total++;
          if (withItems) {
            data.items.push({
              tagName,
              id,
              duplicatedAttribute
            });
          }
        }
      }
    });
    if (data.items) {
      data.items.forEach((item) => {
        standardInstances.push({
          ruleID: "dupAtt",
          what: "Element has 2 attributes with the same name",
          ordinalSeverity: 2,
          tagName: item.tagName,
          id: item.id,
          location: {
            doc: item.id ? "source" : "",
            type: item.id ? "selector" : "",
            spec: item.id ? `#${item.id}` : ""
          },
          excerpt: item.duplicatedAttribute
        });
      });
    } else if (data.total) {
      standardInstances.push({
        ruleID: "dupAtt",
        what: "In some elements 2 attributes have the same name",
        ordinalSeverity: 2,
        count: data.total,
        location: {
          doc: "",
          type: "",
          spec: ""
        },
        excerpt: ""
      });
    }
    totals = [0, 0, data.total, 0];
  }
  return {
    data,
    totals,
    standardInstances
  };
};
