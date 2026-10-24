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
  const API_VERSION = 5;

  // `health` is the parsed /health answer, or null when the request itself failed (no answer, so
  // there is nothing to warn about). Any answer without the current integer `api` is out of date:
  // an old server does not send the field at all.
  function isOutdated(health) {
    if (health == null) return false;
    return !(typeof health === 'object' && Number.isInteger(health.api) && health.api === API_VERSION);
  }

  // Single place that decides what the conformity drawer says.
  // conf = { loaded, failed, ok, items, req: { prereq, repos: [{ id, state, ready }], rooms?: { state, list: [{ name, ready }] } } }
  // where prereq, each repo state and rooms.state are 'loading' | 'loaded' | 'failed'. Conformity is claimed
  // only when the roadmap report came back empty AND the requirements of every repo and the prerequisites were
  // loaded and ready AND every room was loaded and ready: never on data that is missing or unverified.
  // `rooms` is absent for a page that has no rooms.
  function conformityView(conf) {
    if (conf.failed) return { state: 'error', summary: '', message: 'Could not compute the report (is the panel server out of date? restart it)', count: 0 };
    if (!conf.loaded) return { state: 'computing', summary: '', message: 'Computing the report…', count: 0 };
    const req = conf.req || { prereq: 'loading', repos: [] };
    const repos = req.repos || [];
    const rooms = req.rooms || { state: 'loaded', list: [] };
    const roomsNotReady = rooms.state === 'loaded' ? rooms.list.filter((r) => !r.ready) : [];
    const notReady = repos.filter((r) => r.state === 'loaded' && !r.ready);
    const itemIds = new Set(conf.items.map((i) => i.id).filter((id) => id !== undefined));
    const count = conf.items.length + notReady.filter((r) => !itemIds.has(r.id)).length + roomsNotReady.length;
    if (count) {
      const parts = [`${conf.ok} conform`];
      if (conf.items.length) parts.push(`${conf.items.length} need attention`);
      if (notReady.length) parts.push(`${notReady.length} not ready`);
      if (roomsNotReady.length) parts.push(`${roomsNotReady.length} room${roomsNotReady.length === 1 ? '' : 's'} not ready`);
      return { state: 'issues', summary: parts.join(' · '), message: '', count };
    }
    if (req.prereq === 'failed' || repos.some((r) => r.state === 'failed') || rooms.state === 'failed') {
      return { state: 'error', summary: '', message: 'Could not check the requirements (is the panel server out of date? restart it)', count: 0 };
    }
    if (req.prereq !== 'loaded' || repos.some((r) => r.state !== 'loaded') || rooms.state !== 'loaded') return { state: 'computing', summary: '', message: 'Computing the report…', count: 0 };
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

  // The room a repo belongs to, from the rooms of /api/config ({ name, path, repos: [repoId] }), or null.
  function roomOfRepo(rooms, id) {
    return (Array.isArray(rooms) ? rooms : []).find((r) => r && Array.isArray(r.repos) && r.repos.includes(id)) || null;
  }

  const PRESENCE_TEXT = {
    closed: () => 'no pi session open in the room folder',
    idle: () => 'pi session open, idle',
    busy: () => 'pi session open, busy',
    ambiguous: (p) => `${p.sessions} pi sessions open: close the extra ones`,
    unknown: () => 'Orca unavailable: session state unknown',
  };

  function presenceLabel(presence) {
    const make = presence && PRESENCE_TEXT[presence.state];
    return make ? make(presence) : 'session state unknown';
  }

  // Green idle, yellow busy; closed, ambiguous, unknown and anything not loaded are gray.
  const ROOM_DOT = { idle: 'green', busy: 'yellow' };

  const presenceDot = (presence) => ROOM_DOT[presence && presence.state] || 'gray';

  // The card's room tag: { name, dot, title }, or null for a repo that is not in a room. `entry` is the page's record
  // of /api/rooms: { state: 'loading' | 'loaded' | 'failed', data: { rooms } }; nothing is claimed until it loaded.
  function roomTag(rooms, id, entry) {
    const room = roomOfRepo(rooms, id);
    if (!room) return null;
    const list = entry && entry.state === 'loaded' && entry.data && Array.isArray(entry.data.rooms) ? entry.data.rooms : null;
    const live = list && list.find((r) => r.name === room.name);
    if (!live) return { name: room.name, dot: 'gray', title: `Room ${room.name} · ${entry && entry.state === 'failed' ? 'could not read the room state' : 'checking the room…'}` };
    const last = typeof live.lastCommit === 'string' && live.lastCommit ? live.lastCommit.slice(0, 10) : 'unknown';
    return { name: room.name, dot: presenceDot(live.presence), title: `Room ${room.name} · ${presenceLabel(live.presence)} · last commit ${last}` };
  }

  return { API_VERSION, isOutdated, conformityView, cardWarning, cardMenu, roomOfRepo, roomTag, presenceLabel, presenceDot };
}));
