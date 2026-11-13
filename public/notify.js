'use strict';
// RP178: the pure part of the notifications, shared by the server (which kind of attention a Summary row asks for, the text) and the page (the
// validation of a `notify` event and the decision of what to show). No DOM, no network, no dependencies.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RepoPanelNotify = api;
}(typeof self !== 'undefined' ? self : this, () => {
  const KINDS = ['answer', 'ci', 'deliver', 'merge', 'start'];
  // The browser preference that turns each kind off (`false`; a missing one is on), then the sound and the system notification.
  const PREF = { answer: 'notifyAnswer', ci: 'notifyCi', deliver: 'notifyDeliver', merge: 'notifyMerge', start: 'notifyStart' };
  const PREF_KEYS = [...Object.values(PREF), 'notifySound', 'notifySystem'];
  const EVENT_MAX = 4096;
  const TITLE_MAX = 120;
  const BODY_MAX = 240;

  // The kind of attention a Summary row asks for, `null` when it asks for none, `undefined` when it cannot say (loading, an error, a session
  // whose state is unknown): the watcher keeps what it knew instead of taking that for a change.
  function kindOf(row) {
    if (!row || typeof row !== 'object' || row.loading || row.error) return undefined;
    const state = row.session && row.session.state;
    if (state === 'unknown') return undefined;
    if (state === 'waiting') return 'answer';
    if (row.rank === 1) return 'ci';
    const kind = row.action && row.action.kind;
    return kind === 'deliver' || kind === 'merge' || kind === 'start' ? kind : null;
  }

  function textOf(kind, row) {
    const name = String((row && row.name) || 'repo');
    const pr = row && row.action && row.action.pr && row.action.pr.number;
    const body = {
      answer: 'The agent is asking you a question',
      ci: 'CI is failing',
      deliver: 'Done working: ready for /flow-ship',
      merge: pr ? `PR #${pr} is ready to merge` : 'A PR is ready to merge',
      start: 'Clean: ready for /flow-next',
    }[kind] || '';
    return { title: name, body };
  }

  const isText = (v) => typeof v === 'string';
  // One SSE frame -> { id, kind, title, body } or null. Nothing else of the frame is trusted.
  function parse(frame) {
    if (!frame || frame.event !== 'notify' || !isText(frame.data) || frame.data.length > EVENT_MAX) return null;
    let b;
    try { b = JSON.parse(frame.data); } catch { return null; }
    if (!b || typeof b !== 'object' || !isText(b.id) || !/^[0-9a-f]{10}$/.test(b.id) || !KINDS.includes(b.kind) || !isText(b.title) || !isText(b.body)) return null;
    return { id: b.id, kind: b.kind, title: b.title.slice(0, TITLE_MAX), body: b.body.slice(0, BODY_MAX) };
  }

  // What the page does with one notice, or null for nothing. `view` = { visible, focused, permission, prefs }. A panel that is in view says it
  // itself, so it stays quiet; `force` (the test button) shows it whatever the view and the switch of its kind say.
  function plan(n, view, force = false) {
    const v = view || {};
    const prefs = v.prefs || {};
    if (!force && ((v.visible && v.focused) || prefs[PREF[n.kind]] === false)) return null;
    return { toast: true, sound: prefs.notifySound !== false, system: v.permission === 'granted' && prefs.notifySystem !== false };
  }

  return { KINDS, PREF, PREF_KEYS, kindOf, textOf, parse, plan };
}));
