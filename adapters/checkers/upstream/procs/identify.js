/*
  © 2024 CVS Health and/or one of its affiliates. All rights reserved.

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
const getPath = {
  xPath: require("playwright-dompath").xPath
};
const boxOf = exports.boxOf = async (locator) => {
  try {
    const isVisible = await locator.isVisible();
    if (isVisible) {
      const box = await locator.boundingBox({
        timeout: 50
      });
      if (box) {
        Object.keys(box).forEach((dim) => {
          box[dim] = Math.round(box[dim], 0);
        });
        return box;
      } else {
        return null;
      }
    } else {
      return null;
    }
  } catch (error) {
    return null;
  }
};
const boxToString = exports.boxToString = (box) => {
  if (box) {
    return ["x", "y", "width", "height"].map((dim) => box[dim]).join(":");
  } else {
    return "";
  }
};
const addIDs = async (locators, recipient) => {
  const locatorCount = await locators.count();
  if (locatorCount === 1) {
    if (!recipient.boxID) {
      const box = await boxOf(locators);
      recipient.boxID = boxToString(box);
    }
    if (!recipient.pathID) {
      const pathIDPromise = getPath.xPath(locators);
      const timeoutPromise = setTimeout(() => true, 1e3);
      const pathID = Promise.race([pathIDPromise, timeoutPromise]);
      if (typeof pathID === "string") {
        recipient.pathID = pathID;
      }
    }
  }
};
const tagify = (tagName) => {
  if (tagName) {
    const lcTagName = tagName.toLowerCase();
    const safeTagName = lcTagName.replace(/[^a-z0-9]/g, "");
    if (safeTagName !== lcTagName) {
      console.log(`ERROR on page: Tag name ${tagName} invalid; treating it as ${safeTagName}`);
    }
    return safeTagName;
  } else {
    return "";
  }
};
exports.identify = async (instance, page) => {
  if (["boxID", "pathID"].some((key) => instance[key] === void 0)) {
    const elementID = {
      boxID: "",
      pathID: ""
    };
    const { excerpt, id, location } = instance;
    const tagName = tagify(instance.tagName);
    const { type, spec } = location;
    if (["selector", "xpath"].includes(type)) {
      let specifier = spec;
      if (type === "xpath") {
        specifier = spec.replace(/\/text\(\)\[\d+\]$/, "");
      }
      if (specifier) {
        if (type === "xpath") {
          specifier = `xpath=${specifier}`;
        }
        try {
          const locators = page.locator(specifier);
          const locatorCount = await locators.count();
          if (locatorCount === 1) {
            await addIDs(locators, elementID);
          } else if (type === "xpath") {
            elementID.pathID = spec;
          }
        } catch (error) {
          instance.invalidity = {
            badProperty: "location",
            validityError: error.message
          };
        }
      }
    }
    if (id && !(elementID.boxID && elementID.pathID)) {
      try {
        let locator = page.locator(`#${id.replace(/([-&;/]|^\d)/g, "\\$1")}`).first();
        await addIDs(locator, elementID);
      } catch (error) {
        instance.invalidity = {
          badProperty: "id",
          validityError: error.message
        };
      }
    }
    if (tagName && !(elementID.boxID && elementID.pathID)) {
      try {
        let locators = page.locator(tagName);
        let locatorCount = await locators.count();
        if (locatorCount === 1) {
          await addIDs(locators, elementID);
        }
        if (excerpt && !(elementID.boxID && elementID.pathID)) {
          const minTagExcerpt = excerpt.replace(/<[^>]+>/g, "<>");
          const plainParts = (minTagExcerpt.match(/[^<>]+/g) || []).map((part) => part === "..." ? "" : part);
          const sortedPlainParts = plainParts.sort((a, b) => b.length - a.length);
          const mainPart = sortedPlainParts.length ? sortedPlainParts[0] : "";
          if (mainPart.trim().replace(/\s+/g, "").length) {
            const locators2 = page.locator(tagName.toLowerCase(), { hasText: mainPart });
            const locatorCount2 = await locators2.count();
            if (locatorCount2 === 1) {
              await addIDs(locators2, elementID);
            }
          }
        }
      } catch (error) {
        instance.invalidity = {
          badProperty: "tagName",
          validityError: error.message
        };
      }
    }
    return elementID;
  }
};
