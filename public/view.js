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
  const API_VERSION = 4;

  // `health` is the parsed /health answer, or null when the request itself failed (no answer, so
  // there is nothing to warn about). Any answer without the current integer `api` is out of date:
  // an old server does not send the field at all.
  function isOutdated(health) {
    if (health == null) return false;
    return !(typeof health === 'object' && Number.isInteger(health.api) && health.api === API_VERSION);
  }

  // Single place that decides what the conformity drawer says.
  // conf = { loaded, failed, ok, items, req: { prereq, repos: [{ id, state, ready }] } } where prereq and
  // each repo state are 'loading' | 'loaded' | 'failed'. Conformity is claimed only when the roadmap report
  // came back empty AND the requirements of every repo and the prerequisites were loaded and ready: never
  // on data that is missing or unverified.
  function conformityView(conf) {
    if (conf.failed) return { state: 'error', summary: '', message: 'Could not compute the report (is the panel server out of date? restart it)', count: 0 };
    if (!conf.loaded) return { state: 'computing', summary: '', message: 'Computing the report…', count: 0 };
    const req = conf.req || { prereq: 'loading', repos: [] };
    const repos = req.repos || [];
    const notReady = repos.filter((r) => r.state === 'loaded' && !r.ready);
    const itemIds = new Set(conf.items.map((i) => i.id).filter((id) => id !== undefined));
    const count = conf.items.length + notReady.filter((r) => !itemIds.has(r.id)).length;
    if (count) {
      const parts = [`${conf.ok} conform`];
      if (conf.items.length) parts.push(`${conf.items.length} need attention`);
      if (notReady.length) parts.push(`${notReady.length} not ready`);
      return { state: 'issues', summary: parts.join(' · '), message: '', count };
    }
    if (req.prereq === 'failed' || repos.some((r) => r.state === 'failed')) {
      return { state: 'error', summary: '', message: 'Could not check the requirements (is the panel server out of date? restart it)', count: 0 };
    }
    if (req.prereq !== 'loaded' || repos.some((r) => r.state !== 'loaded')) return { state: 'computing', summary: '', message: 'Computing the report…', count: 0 };
    return { state: 'ok', summary: `${conf.ok} conform`, message: 'All repositories conform.', count: 0 };
  }

  // `entry` is the page's record of one repo's requirements: { state: 'loading' | 'loaded' | 'failed', data }.
  // Nothing is claimed about a repo whose requirements are not loaded.
  function openRequirements(entry) {
    const results = entry && entry.state === 'loaded' && entry.data && Array.isArray(entry.data.results) ? entry.data.results : null;
    return results && results.filter((r) => r.status !== 'pass');
  }

  // The compact card warning: only for a REQUIRED requirement that is not passing, and not hidden by the user.
  function cardWarning(entry, dismissed) {
    const open = openRequirements(entry);
    const required = open ? open.filter((r) => r.level === 'required') : [];
    if (!required.length || dismissed) return null;
    return { count: required.length, ids: required.map((r) => r.id) };
  }

  // Items of the card's "more options" menu, as data-act names with their labels.
  function cardMenu(entry, dismissed) {
    const open = openRequirements(entry);
    if (!open || !open.length) return [];
    const items = [{ act: 'put-in-conditions', label: 'Put in conditions' }];
    if (open.some((r) => r.level === 'required')) items.push({ act: 'toggle-warning', label: dismissed ? 'Show warning' : 'Hide warning' });
    return items;
  }

  return { API_VERSION, isOutdated, conformityView, cardWarning, cardMenu };
}));
