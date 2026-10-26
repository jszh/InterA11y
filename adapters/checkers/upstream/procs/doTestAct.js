/*
  © 2024–2025 CVS Health and/or one of its affiliates. All rights reserved.

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
const { launch } = require(`${__dirname}/../run`);
const os = require("os");
const debug = process.env.DEBUG === "true";
const waits = Number.parseInt(process.env.WAITS) || 0;
const tmpDir = os.tmpdir();
const actIndex = Number.parseInt(process.argv[2]);
const doTestAct = async () => {
  const reportPath = `${tmpDir}/report.json`;
  const reportJSON = await fs.readFile(reportPath, "utf8");
  const report = JSON.parse(reportJSON);
  const act = report.acts[actIndex];
  const { which } = act;
  await launch(
    report,
    debug,
    waits,
    act.launch && act.launch.browserID || report.browserID,
    act.launch && act.launch.target && act.launch.target.url || report.target.url
  );
  if (report.jobData && report.jobData.aborted) {
    const reportJSON2 = JSON.stringify(report);
    await fs.writeFile(reportPath, reportJSON2);
    process.send("ERROR: Job aborted");
  } else {
    const { page } = require("../run");
    if (page) {
      try {
        if (page.prevented) {
          process.send("ERROR: Page prevented testing");
        } else {
          const actReport = await require(`../tests/${which}`).reporter(page, report, actIndex, 65);
          act.data = actReport.data;
          act.result = actReport.result;
          if (act.data && act.data.prevented) {
            report.jobData.preventions[which] = act.data.error;
          }
          const reportJSON2 = JSON.stringify(report);
          await fs.writeFile(reportPath, reportJSON2);
          process.send("Act completed");
        }
      } catch (error) {
        const reportJSON2 = JSON.stringify(report);
        await fs.writeFile(reportPath, reportJSON2);
        const message = error.message.slice(0, 400);
        console.log(`ERROR: Test act ${act.which} failed (${message})`);
        process.send("ERROR performing the act");
      }
      ;
    } else {
      act.data ??= {};
      act.data.prevented = true;
      act.data.error = "No page";
      report.jobData.preventions[which] = act.data.error;
      const reportJSON2 = JSON.stringify(report);
      await fs.writeFile(reportPath, reportJSON2);
      const message = "ERROR: No page";
      console.log(message);
      process.send(message);
    }
  }
};
doTestAct();
