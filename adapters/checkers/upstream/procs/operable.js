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
exports.isOperable = async (loc) => {
  const operabilities = await loc.evaluate((el) => {
    const opTags = /* @__PURE__ */ new Set(["A", "BUTTON", "IFRAME", "INPUT", "SELECT", "TEXTAREA"]);
    const opRoles = /* @__PURE__ */ new Set([
      "button",
      "checkbox",
      "combobox",
      "composite",
      "grid",
      "gridcell",
      "input",
      "link",
      "listbox",
      "menu",
      "menubar",
      "menuitem",
      "menuitemcheckbox",
      "option",
      "radio",
      "radiogroup",
      "scrollbar",
      "searchbox",
      "select",
      "slider",
      "spinbutton",
      "switch",
      "tab",
      "tablist",
      "textbox",
      "tree",
      "treegrid",
      "treeitem",
      "widget"
    ]);
    const opHow = [];
    let hasPointer = false;
    if (el.tagName !== "LABEL") {
      const styleDec = window.getComputedStyle(el);
      hasPointer = styleDec.cursor === "pointer";
      if (hasPointer) {
        el.parentElement.style.cursor = "default";
        hasPointer = styleDec.cursor === "pointer";
      }
    }
    if (hasPointer) {
      opHow.push("pointer cursor");
    }
    if (el.onclick) {
      opHow.push("click listener");
    }
    const role = el.getAttribute("role");
    if (opRoles.has(role)) {
      opHow.push(`role ${role}`);
    }
    const tagName = el.tagName;
    if (opTags.has(tagName)) {
      opHow.push(`tag name ${tagName}`);
    }
    return opHow;
  });
  return operabilities;
};
