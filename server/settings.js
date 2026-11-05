'use strict';
// RP111b: the options of the panel that the page may read and write, as a CLOSED list. The list is the only door: a key that is not in it is not read and not written, and what a
// write touches is what its entry says (never the whole configuration: the port, the groups and their paths, the sessions and the rooms are not reachable from here). The key is
// compared as text against the list, never used as a property name, so `__proto__` and `constructor` are just keys that are not there.
const { HttpError } = require('./errors.js');
const { loadConfig, saveConfig } = require('./config.js');

const OPTIONS = [
  {
    key: 'chat.showResults',
    type: 'boolean',
    default: false,
    read: (cfg) => !!cfg.chat && cfg.chat.showResults === true,
    write: (cfg, value) => ({ ...cfg, chat: { showResults: value } }),
  },
];

const find = (key) => (typeof key === 'string' ? OPTIONS.find((o) => o.key === key) : undefined);

// { options: [{ key, value, default }] } for the closed list, nothing else.
function readSettings() {
  const cfg = loadConfig();
  return { options: OPTIONS.map((o) => ({ key: o.key, value: o.read(cfg), default: o.default })) };
}

// One option, by its key, with a value of the type its entry says; answers the list as it is now. Anything else is a 400 and the file is not touched.
function writeSetting(key, value) {
  const option = find(key);
  if (!option) throw new HttpError(400, 'Unknown setting');
  if (typeof value !== option.type) throw new HttpError(400, `${option.key} must be a ${option.type}`);
  saveConfig(option.write(loadConfig(), value));
  return readSettings();
}

module.exports = { OPTIONS, readSettings, writeSetting };
