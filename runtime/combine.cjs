'use strict';
const { combineDeterministic } = require('./run-intera11y.cjs');
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { data += chunk; });
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data);
    process.stdout.write(JSON.stringify(combineDeterministic(input.baseline, input.full)) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({state:'error',flagged:false,findings:[],error:error.message}) + '\n');
    process.exitCode = 1;
  }
});
