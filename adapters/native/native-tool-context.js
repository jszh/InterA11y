"use strict";
const puppeteer = require("puppeteer");
const { installHelpers } = require("../../runtime/intera11y/src/model/inpage.js");
const { stateSession } = require("../../runtime/intera11y/src/judge/tool-state-session.js");
const { bindTools } = require("../../runtime/intera11y/src/judge/tools.js");
const CURRENT_STATE_TOOLS = /* @__PURE__ */ new Set([
  "query_ax_node",
  "interact_and_observe",
  "observe_state_after_activation",
  "probe_screen_reader_after_action",
  "measure_geometry_live",
  "compute_contrast_ratio",
  "resolve_part_color",
  "compare_named_regions",
  "compare_iframe_content",
  "resolve_destination",
  "capture_full_page",
  "set_state_and_capture",
  "request_hi_res_crop"
]);
class NativeToolContext {
  constructor() {
    this.browser = null;
    this.endpoint = null;
    this.targetId = null;
    this.bound = null;
  }
  async call(context, name, args, identities) {
    if (!CURRENT_STATE_TOOLS.has(name) || name === "measure_geometry_live" && args.viewportWidth)
      return { error: "This instrument requires an isolated workflow. Use stateId:new and construct the required state there.", measurementContext: "native-unavailable" };
    const endpoint = new URL(context.endpoint);
    if (!["ws:", "http:"].includes(endpoint.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname))
      throw new Error("Native tool connection requires a loopback CDP endpoint.");
    if (this.endpoint !== context.endpoint) {
      await this.close();
      this.browser = await puppeteer.connect({ ...endpoint.protocol === "ws:" ? { browserWSEndpoint: context.endpoint } : { browserURL: context.endpoint }, defaultViewport: null });
      this.endpoint = context.endpoint;
    }
    if (this.targetId !== context.targetId) {
      if (this.bound) await this.bound.close();
      if (this.page && this.onDialog) this.page.off("dialog", this.onDialog);
      const target = this.browser.targets().find((t) => t._targetId === context.targetId);
      const page = target && await target.page();
      if (!page || page.isClosed()) throw new Error("Native browser target unavailable; no substitute page measured.");
      if (!await page.evaluate(() => !!window.__ia?.resolveAll)) await page.evaluate(installHelpers);
      const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio }));
      await page.setViewport(viewport);
      page.__dialogs = [];
      this.onDialog = (d) => {
        page.__dialogs.push({ type: d.type(), message: d.message() });
        d.dismiss().catch(() => {
        });
      };
      page.on("dialog", this.onDialog);
      this.page = page;
      this.bound = bindTools(stateSession(page), [...CURRENT_STATE_TOOLS]);
      this.targetId = context.targetId;
    }
    if (!await this.page.evaluate(() => !!window.__ia?.resolveAll)) await this.page.evaluate(installHelpers);
    const result = await this.bound.call(name, args, identities);
    return { ...result, measurementContext: "current-native-page", nativeTargetId: this.targetId };
  }
  async close() {
    if (this.bound) await this.bound.close();
    if (this.page && this.onDialog) this.page.off("dialog", this.onDialog);
    if (this.browser) await this.browser.disconnect();
    this.browser = this.bound = this.page = null;
    this.endpoint = this.targetId = null;
  }
}
module.exports = { NativeToolContext };
