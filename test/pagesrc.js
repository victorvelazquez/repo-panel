'use strict';
// RPC3: the page's own scripts, in the order index.html loads them (after view.js and resumen.js, which tests load on their own). Tests read or run the page
// through this list, so a slice that moves code out of app.js into a new file only adds its name here. `appSource()` is the text of all of them, in order.
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');
const APP_FILES = ['data.js', 'app.js'];
const appSource = () => APP_FILES.map((f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8')).join('\n');

module.exports = { PUBLIC, APP_FILES, appSource };
