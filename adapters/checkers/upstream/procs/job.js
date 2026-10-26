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
const { actSpecs } = require("../actSpecs");
const { devices } = require("playwright");
const { dateOf } = require("./dateOf");
const tools = exports.tools = {
  alfa: "alfa",
  aslint: "ASLint",
  axe: "Axe",
  ed11y: "Editoria11y",
  htmlcs: "HTML CodeSniffer WCAG 2.1 AA ruleset",
  ibm: "IBM Accessibility Checker",
  nuVal: "Nu Html Checker",
  qualWeb: "QualWeb",
  testaro: "Testaro",
  wax: "WallyAX",
  wave: "WAVE"
};
const hasType = (variable, type) => {
  if (type === "string") {
    return typeof variable === "string";
  } else if (type === "array") {
    return Array.isArray(variable);
  } else if (type === "boolean") {
    return typeof variable === "boolean";
  } else if (type === "number") {
    return typeof variable === "number";
  } else if (type === "object") {
    return typeof variable === "object" && !Array.isArray(variable);
  } else {
    return false;
  }
};
const hasSubtype = (variable, subtype) => {
  if (subtype) {
    if (subtype === "hasLength") {
      return variable.length > 0;
    } else if (subtype === "isURL") {
      return isURL(variable);
    } else if (subtype === "isBrowserID") {
      return isBrowserID(variable);
    } else if (subtype === "isFocusable") {
      return isFocusable(variable);
    } else if (subtype === "isTest") {
      return tools[variable];
    } else if (subtype === "isWaitable") {
      return ["url", "title", "body"].includes(variable);
    } else if (subtype === "areNumbers") {
      return areNumbers(variable);
    } else if (subtype === "areStrings") {
      return areStrings(variable);
    } else if (subtype === "areArrays") {
      return areArrays(variable);
    } else if (subtype === "isState") {
      return isState(variable);
    } else {
      console.log(`ERROR: ${subtype} not a known subtype`);
      return false;
    }
  } else {
    return true;
  }
};
const isDeviceID = exports.isDeviceID = (deviceID) => deviceID === "default" || !!devices[deviceID];
const isBrowserID = exports.isBrowserID = (type) => ["chromium", "firefox", "webkit"].includes(type);
const isState = (string) => ["loaded", "idle"].includes(string);
const isURL = exports.isURL = (string) => /^(?:https?|file):\/\/[^\s]+$/.test(string);
const isFocusable = (string) => ["a", "button", "input", "select"].includes(string);
const areNumbers = (array) => array.every((element) => typeof element === "number");
const areStrings = (array) => array.every((element) => typeof element === "string");
const areArrays = (object) => Object.values(object).every((value) => Array.isArray(value));
const isValidAct = exports.isValidAct = (act) => {
  const type = act.type;
  if (type && actSpecs.etc[type]) {
    const validator = Object.assign({}, actSpecs.etc[type][1]);
    if (type === "test") {
      const toolName = act.which;
      if (toolName && tools[toolName]) {
        if (actSpecs.tools[toolName]) {
          Object.assign(validator, actSpecs.tools[toolName][1]);
        }
      } else {
        return false;
      }
    }
    return Object.keys(validator).every((property) => {
      if (property === "name") {
        return true;
      } else {
        const vP = validator[property];
        const aP = act[property];
        const optAndNone = !vP[0] && !aP;
        const isValid = aP !== void 0 && hasType(aP, vP[1]) && hasSubtype(aP, vP[2]);
        return optAndNone || isValid;
      }
    });
  } else {
    return false;
  }
};
exports.isValidJob = (job) => {
  if (job) {
    const {
      id,
      strict,
      standard,
      observe,
      device,
      browserID,
      timeLimit,
      creationTimeStamp,
      executionTimeStamp,
      target,
      sources,
      acts
    } = job;
    if (!id || typeof id !== "string") {
      return "Bad job ID";
    }
    if (typeof strict !== "boolean") {
      return "Bad job strict";
    }
    if (!["also", "only", "no"].includes(standard)) {
      return "Bad job standard";
    }
    if (typeof observe !== "boolean") {
      return "Bad job observe";
    }
    if (!isDeviceID(device.id)) {
      return "Bad job deviceID";
    }
    if (!isBrowserID(browserID)) {
      return "Bad job browserID";
    }
    if (typeof timeLimit !== "number" || timeLimit < 1) {
      return "Bad job timeLimit";
    }
    if (!(creationTimeStamp && typeof creationTimeStamp === "string" && dateOf(creationTimeStamp))) {
      return "bad job creationTimeStamp";
    }
    if (!(executionTimeStamp && typeof executionTimeStamp === "string") && dateOf(executionTimeStamp)) {
      return "bad job executionTimeStamp";
    }
    if (typeof target !== "object" || target.url && !isURL(target.url) || target.what === "") {
      return "bad job target";
    }
    if (sources && typeof sources !== "object") {
      return "Bad job sources";
    }
    if (!acts || !Array.isArray(acts) || !acts.length || !acts.every((act) => act.type && typeof act.type === "string")) {
      return "Bad job acts";
    }
    const invalidAct = acts.find((act) => !isValidAct(act));
    if (invalidAct) {
      return `Invalid act:
${JSON.stringify(invalidAct, null, 2)}`;
    }
    return "";
  } else {
    return "no job";
  }
};
