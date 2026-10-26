'use strict';

const { key, within } = require('../lib/xpath.js');
const PROFILES = {
  combined: { relevant: true, lightweight: true, detectors: true, targeted: true, regional: true },
};
function makeProfile(name = 'combined', scs = [], targets = null) {
  const flags = PROFILES[name];
  if (!flags) throw new Error(`unknown probe profile ${name}`);
  if (!scs.length) throw new Error('The probe profile requires SC context');
  const has = (...xs) => xs.some(x => scs.includes(x));

  const keys = targets && scs.flatMap(sc => [...(targets[sc]?.keys || [])]);
  const scoped = !!(flags.targeted && targets && !scs.some(sc => !targets[sc] || targets[sc].page));
  const matches = xpath => !scoped || keys.some(t => within(key(xpath), t));
  const relates = xpath => !scoped || keys.some(t => within(key(xpath), t) || within(t, key(xpath)));
  return {
    name, flags, scs, targetKeys: scoped ? keys : null, matches, relates,
    keyboard: {
      capture: !flags.lightweight || has('2.4.7'),
      sequenceMap: !flags.relevant || has('2.4.3'),
      regional: !!flags.regional,

      backward: true,
      traps: !flags.detectors || has('2.1.2'),
      retention: !flags.detectors || has('2.1.2'),
      confinement: !flags.detectors || has('2.1.2'),
      rejection: !flags.detectors || has('2.1.1', '2.4.7'),
      composites: !flags.detectors || has('2.1.1', '2.4.7'),
    },
    activation: { idle: !flags.relevant || has('4.1.3') },
    content: {
      links: !flags.relevant || has('2.4.4'),
      linkContextScope: 'page',
      texts: !flags.relevant || has('1.4.3'),
      images: !flags.relevant || has('1.1.1'),
      lookalikes: !flags.relevant || has('1.1.1'),
      targetKeys: scoped ? keys : null,
    },
  };
}
module.exports = { PROFILES, makeProfile };
