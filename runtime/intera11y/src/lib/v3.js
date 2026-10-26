'use strict';

const path = require('path');
const V3 = path.join(__dirname, '..', '..', 'measurements');
const req = (m) => require(path.join(V3, m));

const settle = req('settle.js');
const kbd = req('kbd-graph.js');
const tools = req('cdp-tools.js');

const order = req('order-check.js');
const colour = req('a11y-eval.js');

module.exports = {

  awaitSettle: settle.awaitSettle,
  awaitFocusSettle: settle.awaitFocusSettle,

  detectKeyboardTraps: kbd.detectKeyboardTraps,
  detectFocusRetentionTraps: kbd.detectFocusRetentionTraps,
  detectFixedSetConfinementTraps: kbd.detectFixedSetConfinementTraps,
  detectFocusRejection: kbd.detectFocusRejection,

  parseRGB: colour.parseRGB,
  contrastRatio: colour.contrastRatioRaw,

  visualOrderDivergence: order.visualOrderDivergence,

  toolHandlers: {
    query_ax_node: tools.queryAxNode,
    observe_state_after_activation: tools.observeStateAfterActivation,
    interact_and_observe: tools.interactAndObserve,
    set_state_and_capture: tools.setStateAndCapture,
    measure_geometry_live: tools.measureGeometryLive,
    request_hi_res_crop: tools.requestHiResCrop,
    resolve_destination: tools.resolveDestination,
    compare_named_regions: tools.compareNamedRegions,
    probe_screen_reader_after_action: tools.probeScreenReaderAfterAction,
    render_with_overrides: tools.renderWithOverrides,
    compute_contrast_ratio: tools.computeContrastRatio,
    resolve_part_color: tools.resolvePartColor,
    capture_full_page: tools.captureFullPage,
  },

  toolDeclarations() {
    const d = tools.buildCdpToolDispatch({ page: null, freshClone: null });
    return Object.fromEntries(d.declarations.filter(x => module.exports.toolHandlers[x.name]).map(x => [x.name, { ...x,
      description: x.description + ' Optional stateId:new creates a retained isolated workflow; reuse its returned stateId to continue or inspect the same state. All mutations in a retained state persist, including rendering overrides. Otherwise mutating tools use fresh pages.',
      parameters: { ...x.parameters, properties: { ...x.parameters.properties, stateId: {type:'string'} } },
    }]));
  },
};
