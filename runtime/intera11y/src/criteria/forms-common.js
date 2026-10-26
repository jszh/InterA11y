'use strict';

function errorCandidates(forms) {
  const out = [];
  for (const f of forms || []) {
    const flagged = new Map();
    const rest = f.atRest || {};
    (rest.fieldStates || []).forEach((s) => { if (s.ariaInvalid === 'true') flagged.set(s.xpath, { atRest: true, scenarios: [] }); });

    (rest.styleOutliers || []).forEach((o) => { if (!flagged.has(o.xpath)) flagged.set(o.xpath, { atRest: true, byStyleOnly: o, scenarios: [] }); });
    for (const s of f.scenarios || []) {
      for (const x of s.fieldsFlagged || []) { if (!flagged.has(x)) flagged.set(x, { atRest: false, scenarios: [] }); flagged.get(x).scenarios.push(s.mode); }
    }
    for (const [xpath, why] of flagged) out.push({ xpath, kind: 'flagged-field', form: f, why });

    const refusedSilently = (f.scenarios || []).some((s) => !s.error && !s.skipped && !navigationAttempted(s) && !(s.fieldsFlagged || []).length);
    const restingMessages = (rest.messages || []).length > 0;
    if (!flagged.size && (refusedSilently || restingMessages)) out.push({ xpath: f.xpath, kind: restingMessages ? 'form-with-resting-messages' : 'form-refused-submission', form: f });
    if (!flagged.size && !refusedSilently && !restingMessages) out.push({ xpath: f.xpath, kind: 'form-at-rest', form: f });
  }
  return out;
}

function errorTexts(c) {
  const f = c.form;
  const texts = [];
  const rest = f.atRest || {};
  const rs = (rest.fieldStates || []).find((s) => s.xpath === c.xpath);
  if (rs) {
    if (rs.describedByText && rs.describedByText.length) texts.push({ when: 'at rest', via: 'aria-describedby', text: rs.describedByText });
    if (rs.errorMessageText && rs.errorMessageText.length) texts.push({ when: 'at rest', via: 'aria-errormessage', text: rs.errorMessageText });
  }
  for (const m of rest.messages || []) texts.push({ when: 'at rest', via: 'visible message in/near the form', path: m.xpath, text: m.text, role: m.role || m.live || undefined });
  for (const s of f.scenarios || []) {
    if (s.error || s.skipped) continue;
    const st = (s.fieldStates || []).find((x) => x.xpath === c.xpath);
    if (st) {

      if (st.validationMessage && s.nativeValidationBlocked && (s.invalidEvents || []).some(e => e.xpath === st.xpath && !e.defaultPrevented))
        texts.push({ when: `after ${s.mode} submit`, via: 'browser validation message (native validation blocked this submit; the browser displays its first invalid field)', text: st.validationMessage });
      const loaded = (s.fieldStatesAtLoad || rest.fieldStates || []).find(x => x.xpath === c.xpath);
      if (st.describedByText && st.describedByText.length && JSON.stringify(st.describedByText) !== JSON.stringify(loaded?.describedByText)) texts.push({ when: `after ${s.mode} submit`, via: 'aria-describedby', text: st.describedByText });
      if (st.errorMessageText && st.errorMessageText.length && JSON.stringify(st.errorMessageText) !== JSON.stringify(loaded?.errorMessageText)) texts.push({ when: `after ${s.mode} submit`, via: 'aria-errormessage', text: st.errorMessageText });
      const before = (s.fieldStatesBefore || []).find((x) => x.xpath === c.xpath);
      if (before && st.label !== before.label) texts.push({ when: `after ${s.mode} submit`, via: 'label changed', text: st.label });
    }
    for (const t of s.newText || []) texts.push({ when: `after ${s.mode} submit`, via: t.liveRegion ? `new text in ${t.liveRegion.preExisted ? 'a pre-existing' : 'a newly added'} live region (${t.liveRegion.politeness})` : 'new visible text', path: t.xpath, text: t.text });
    for (const d of s.nativeDialogs || []) texts.push({ when: `after ${s.mode} submit`, via: 'native alert dialog', text: d.message });
  }
  return texts;
}

function scenarioFacts(c) {
  const f = c.form;
  return (f.scenarios || []).map((s) => {
    if (s.error || s.skipped) return { mode: s.mode, notRun: s.error || s.skipped };
    const st = (s.fieldStates || []).find((x) => x.xpath === c.xpath);
    const be = (s.fieldStatesBefore || []).find((x) => x.xpath === c.xpath);
    const loaded = (s.fieldStatesAtLoad || f.atRest?.fieldStates || []).find(x => x.xpath === c.xpath);
    return {
      mode: s.mode, inputPlanNote: 'mode describes the intended test inputs, not proven validity or server acceptance',
      submittedBy: s.submittedBy, filled: s.filled,
      navigationAttempted: navigationAttempted(s), navigationBlocked: s.navigationBlocked || [],
      submissionOutcome: 'unknown', serverResponseObserved: false,
      nativeValidationEnabled: s.nativeValidationEnabled, nativeValidationBlocked: s.nativeValidationBlocked,
      invalidEvents: s.invalidEvents,
      observationLimit: 'Navigation is intercepted. Unchanged pre-existing messages on this document do not show a server response or newly detected error for the edited input.',
      fieldsInErrorStateAfterSubmit: s.fieldsFlagged, newlyDetectedErrorFields: s.newlyDetectedErrorFields,
      errorDetectionObservedForEditedValue: (s.newlyDetectedErrorFields || []).includes(c.xpath) || !!s.nativeValidationBlocked,
      unchangedErrorMessagePolicy: 'An unchanged error presentation describes the original at-load input, not a newly detected error in the edited value.',
      focusAfter: s.focusAfter,
      thisFieldAtLoad: loaded || null, thisFieldBeforeSubmit: be || null,
      thisField: st ? { constraintValid: st.constraintValid, ariaInvalid: st.ariaInvalid, borderBefore: be && be.borderColor, borderAfter: st.borderColor, outlineAfter: st.outline, backgroundBefore: be && be.background, backgroundAfter: st.background, value: st.value } : null,
    };
  });
}

function navigationAttempted(s) {
  return s.navigationAttempted ?? ((s.navigationBlocked || []).length > 0 || s.submissionWentThrough === true);
}

function formImages(c) {
  const f = c.form, imgs = [];
  if (f.atRest && f.atRest.image) imgs.push({ label: 'the form as the page loads (before any input)', data: f.atRest.image });
  for (const s of f.scenarios || []) if (s.images && s.images.after) imgs.push({ label: `the form after the ${s.mode} submission`, data: s.images.after });
  return imgs;
}

function fieldFacts(c) {
  return (c.form.fields || []).find((x) => x.xpath === c.xpath) || null;
}

module.exports = { errorCandidates, errorTexts, scenarioFacts, formImages, fieldFacts };
