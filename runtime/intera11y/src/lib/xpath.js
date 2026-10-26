'use strict';

const key = (x) => String(x || '').normalize('NFC').replace(/\[1\]/g, '').replace(/\s+/g, ' ').trim();

const toV3 = (x) => String(x || '').replace(/^\/html\[1\]\/body\[1\]/, '/html/body');
const fromV3 = (x) => String(x || '').replace(/^\/html\/body(?=\/|$)/, '/html[1]/body[1]');

const within = (k, t) => k === t || k.startsWith(t + '/') || k.startsWith(t + '>>');

module.exports = { key, within, toV3, fromV3 };
