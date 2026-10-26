'use strict';

const SCS = ["1.1.1","1.4.1","1.4.13","2.1.1","2.1.2","2.4.3","2.4.4","2.4.7","3.3.1","4.1.3"];
const fs = require('fs');
const path = require('path');
const CRITERIA = {};
for (const sc of SCS) if (fs.existsSync(path.join(__dirname, `${sc}.js`))) CRITERIA[sc] = require(`./${sc}.js`);
module.exports = { CRITERIA, SCS };
