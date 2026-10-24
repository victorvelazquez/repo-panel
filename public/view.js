'use strict';
// Pure helpers shared by the page (plain <script>, global RepoPanelView) and the server and tests
// (CommonJS). No dependencies, no DOM.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RepoPanelView = api;
}(typeof self !== 'undefined' ? self : this, () => {
  // Bump it when the client starts needing a new or changed server route. /health reports the value
  // the running server loaded at start; the page compares it with the file it just downloaded.
  const API_VERSION = 1;

  // `health` is the parsed /health answer, or null when the request itself failed (no answer, so
  // there is nothing to warn about). Any answer without the current integer `api` is out of date:
  // an old server does not send the field at all.
  function isOutdated(health) {
    if (health == null) return false;
    return !(typeof health === 'object' && Number.isInteger(health.api) && health.api === API_VERSION);
  }

  // Single place that decides what the conformity drawer says. conf = { loaded, failed, ok, items }.
  // Only a report that was computed and came back empty may claim conformity.
  function conformityView(conf) {
    if (conf.failed) return { state: 'error', summary: '', message: 'Could not compute the report (is the panel server out of date? restart it)' };
    if (!conf.loaded) return { state: 'computing', summary: '', message: 'Computing the report…' };
    if (conf.items.length) return { state: 'issues', summary: `${conf.ok} conform · ${conf.items.length} need attention`, message: '' };
    return { state: 'ok', summary: `${conf.ok} conform`, message: 'All repositories conform.' };
  }

  return { API_VERSION, isOutdated, conformityView };
}));
