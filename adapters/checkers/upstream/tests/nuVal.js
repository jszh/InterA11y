/*
  © 2022–2024 CVS Health and/or one of its affiliates. All rights reserved.

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
const fs = require("fs/promises");
const { getSource } = require("../procs/getSource");
exports.reporter = async (page, report, actIndex) => {
  const act = report.acts[actIndex];
  const { rules } = act;
  const pageContent = await page.content();
  const sourceData = await getSource(page);
  const data = {
    docTypes: {
      pageContent: {},
      rawPage: {}
    }
  };
  const result = {};
  if (sourceData.prevented) {
    data.prevented = true;
    data.error = sourceData.error;
  } else {
    const fetchOptions = {
      method: "post",
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Content-Type": "text/html; charset=utf-8"
      }
    };
    const nuURL = "https://validator.w3.org/nu/?parser=html&out=json";
    const pageTypes = [["pageContent", pageContent], ["rawPage", sourceData.source]];
    for (const page2 of pageTypes) {
      try {
        fetchOptions.body = page2[1];
        const nuResult = await fetch(nuURL, fetchOptions);
        const nuData = await nuResult.json();
        const nuDataClean = JSON.parse(JSON.stringify(nuData).replace(/[\u{fffd}“”]/ug, ""));
        result[page2[0]] = nuDataClean;
        if (!result[page2[0]].error && rules && Array.isArray(rules) && rules.length) {
          result[page2[0]].messages = result[page2[0]].messages.filter((message) => rules.some((rule) => {
            if (rule[0] === "=") {
              return message.message === rule.slice(1);
            } else if (rule[0] === "~") {
              return new RegExp(rule.slice(1)).test(message.message);
            } else {
              console.log(`ERROR: Invalid nuVal rule ${rule}`);
              return false;
            }
          }));
        }
      } catch (error) {
        const message = `ERROR getting results for ${page2[0]} (${error.message})`;
        console.log(message);
        data.docTypes[page2[0]].prevented = true;
        data.docTypes[page2[0]].error = message;
      }
      ;
    }
    ;
    if (pageTypes.every((pageType) => data.docTypes[pageType[0]].prevented)) {
      data.prevented = true;
      data.error = "Both doc types prevented";
    }
  }
  return {
    data,
    result
  };
};
