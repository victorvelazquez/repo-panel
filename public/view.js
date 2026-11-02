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
  const API_VERSION = 15;

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
    // A room is judged with the room requirements and never gets the member order.
    const items = entry.data.isRoom ? [] : [{ act: 'put-in-conditions', label: 'Put in conditions' }];
    if (open.some((r) => r.level === 'required')) items.push({ act: 'toggle-warning', label: dismissed ? 'Show warning' : 'Hide warning' });
    return items;
  }

  // The room a repo belongs to, from the rooms of /api/config ({ name, path, repos: [repoId] }), or null.
  function roomOfRepo(rooms, id) {
    return (Array.isArray(rooms) ? rooms : []).find((r) => r && Array.isArray(r.repos) && r.repos.includes(id)) || null;
  }

  // The "Assign to room" group of the card menu, from the rooms of /api/config: { title, items }. Each item is
  // { act, label, current, room? }; `room` is the room name, or null for "No room". With no rooms there is no group
  // (empty title) and the only item offers to create one.
  function roomMenu(rooms, id) {
    const list = (Array.isArray(rooms) ? rooms : []).filter((r) => r && typeof r.name === 'string');
    if (!list.length) return { title: '', items: [{ act: 'room-dialog', label: 'Create a room…', current: false }] };
    const mine = roomOfRepo(list, id);
    return {
      title: 'Assign to room',
      items: [
        ...list.map((r) => ({ act: 'assign-room', room: r.name, label: r.name, current: r === mine })),
        { act: 'assign-room', room: null, label: 'No room', current: !mine },
      ],
    };
  }

  // The warning for `roomIssues` of /api/config (config.json entries under rooms that the panel ignores), or null.
  function roomIssuesNotice(issues) {
    const reasons = (Array.isArray(issues) ? issues : []).filter((s) => typeof s === 'string' && s);
    if (!reasons.length) return null;
    const n = reasons.length;
    const message = reasons.every((s) => s.startsWith('rooms['))
      ? `${n} entr${n === 1 ? 'y' : 'ies'} in config.json under rooms ${n === 1 ? 'is' : 'are'} invalid and ignored`
      : 'rooms in config.json is not a list and is ignored';
    return { message, reasons };
  }

  const PRESENCE_TEXT = {
    closed: () => 'no session open in the room folder',
    idle: () => 'session open, idle',
    busy: () => 'session open, busy',
    ambiguous: (p) => `${p.sessions} sessions open: close the extra ones`,
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

  // The state an agent declared (the answer of /api/state), or null when it cannot be relied on: not available
  // (missing, invalid, unsafe, error), unknown state, or older than the repo's last activity (stale).
  const STATE_DOT = { working: 'yellow', 'needs-input': 'blue', 'ready-to-commit': 'green', 'ready-to-pr': 'green', blocked: 'red' };

  // A declared `working` older than this (by its own `at`) is treated as expired: an agent that crashed would
  // otherwise hide the commit button forever. needs-input, blocked and ready-to-pr never expire by time.
  const WORKING_EXPIRY_MS = 30 * 60 * 1000;

  function expiredWorking(data, now) {
    const at = Date.parse(data.at);
    return data.state === 'working' && Number.isFinite(at) && now - at > WORKING_EXPIRY_MS;
  }

  // A declared `working` is not invalidated by repo activity (`stale`): the agent is meant to be changing files
  // while it works, so only its own expiry ends it. Every other state is ignored once the repo changed after it.
  function usableState(data, now = Date.now()) {
    if (!data || data.available !== true || (data.stale === true && data.state !== 'working')) return null;
    if (!Object.hasOwn(STATE_DOT, data.state)) return null;
    return expiredWorking(data, now) ? null : data;
  }

  // Why the commit buttons are disabled while the work is still going on, or null. `session` is the state of
  // GET /api/pi-status for a repo with changes: busy, asking and 'checking' (see liveSession) hold; idle, closed,
  // ambiguous, unknown and a failed request never do (fail open, a flaky Orca must not hold a repo hostage).
  const SESSION_BUSY = 'the session is still working';
  const SESSION_ASKING = 'waiting for your answer in the session';
  const SESSION_CHECKING = 'checking the session…';
  // How long a dirty repo, seen by the page for the first time, keeps its commit buttons disabled while the first
  // answer of the live session state is still on its way.
  const LIVE_CHECK_MS = 20 * 1000;
  const QUIET_MS = 20 * 1000; // files changed more recently than this: more changes are probably coming
  const QUIET_SKEW_MS = 5 * 1000; // a time further in the future than this is a clock problem, not activity
  const QUIET_REASON = 'files changed a few seconds ago';

  function sessionHold(session) {
    return session === 'busy' ? SESSION_BUSY : session === 'asking' ? SESSION_ASKING : session === 'checking' ? SESSION_CHECKING : null;
  }

  // The `session` of a repo with changes as the buttons see it. A command of this page in flight has its own verdict
  // (undefined). Once the live state was asked for, its answer rules: a state, or undefined after a failed request.
  // Before the first answer the repo is 'checking' until LIVE_CHECK_MS after it was first seen dirty (`dirtyAt`), then
  // the normal rules apply (fail open).
  function liveSession({ sent, live, answered = false, dirtyAt, now = Date.now() } = {}) {
    if (sent) return undefined;
    if (answered) return live;
    const age = now - dirtyAt;
    return typeof dirtyAt === 'number' && age >= 0 && age < LIVE_CHECK_MS ? 'checking' : undefined;
  }

  // Whether the newest changed file is younger than QUIET_MS. A missing or non-finite value never blocks.
  function quietPeriod(lastChangeMs, now = Date.now()) {
    if (typeof lastChangeMs !== 'number' || !Number.isFinite(lastChangeMs)) return false;
    const age = now - lastChangeMs;
    return age >= -QUIET_SKEW_MS && age < QUIET_MS;
  }

  // True while any repo has a request in flight: the one place the page shows that it is refreshing (the top button).
  const isRefreshing = (loading) => Object.values(loading || {}).some((n) => n > 0);

  // Refresh rhythm (S22). Git data (no network) is re-read every LOCAL_REFRESH_MS; GitHub data of every repo every
  // FULL_REFRESH_MS; a "hot" repo also re-reads its PRs every HOT_REFRESH_MS, so a merge shows up fast without every repo
  // spending the API budget of 5000 requests per hour.
  const LOCAL_REFRESH_MS = 10000;
  const HOT_REFRESH_MS = 20000;
  const FULL_REFRESH_MS = 60000;

  // Hot: the current branch has an open PR (the PR is the thing about to change), or a command of the panel is in flight.
  function isHotRepo({ local, prs, sent } = {}) {
    if (sent) return true;
    const branch = local && !local.error && !local.detached ? local.branch : null;
    return !!branch && Array.isArray(prs && prs.prs) && prs.prs.some((p) => p.head === branch);
  }

  // How often a repo with a command of the panel in flight asks for the live session state, to notice the finish fast.
  const SENT_POLL_MS = 3000;

  // What the periodic tick refreshes now: [{ id, kind }], kind 'sent' (the session state of a command in flight), 'hot'
  // (local + PRs) or 'local' (git only); one entry per repo, 'sent' first. `last[id]` is { local, prs, pistatus }: when each
  // kind of data was last asked for (a full refresh sets local and prs). Nothing while the tab is hidden; a repo with a
  // request in flight, or a busy key '<id>:<n>' with value true (a merge or re-run of that repo), is skipped.
  function refreshPlan({ now = Date.now(), ids = [], local = {}, prs = {}, sent = {}, last = {}, loading = {}, hidden = false, busy = {} } = {}) {
    if (hidden) return [];
    const paused = new Set(Object.keys(busy).filter((k) => busy[k] === true).map((k) => k.slice(0, k.lastIndexOf(':'))));
    const out = [];
    for (const id of ids) {
      if (loading[id] > 0 || paused.has(id)) continue;
      const at = last[id] || {};
      if (sent[id] && now - (at.pistatus || 0) >= SENT_POLL_MS) out.push({ id, kind: 'sent' });
      else if (isHotRepo({ local: local[id], prs: prs[id], sent: sent[id] }) && now - (at.prs || 0) >= HOT_REFRESH_MS) out.push({ id, kind: 'hot' });
      else if (now - (at.local || 0) >= LOCAL_REFRESH_MS) out.push({ id, kind: 'local' });
    }
    return out;
  }

  // The repos whose live session state the page polls: loaded, with uncommitted changes, and no command of the panel
  // in flight (loadPiStatus already polls those). Nothing while the tab is hidden.
  function piPollTargets({ ids = [], local = {}, sent = {}, hidden = false } = {}) {
    if (hidden) return [];
    return ids.filter((id) => hasLocal(local[id]) && local[id].files.length > 0 && !sent[id]);
  }

  // The commit button stays unless a usable state says the work is not ready to commit. No state never blocks.
  // `override` is the page's "Show /flow-commit anyway" choice for this repo.
  function commitAllowed(data, { now = Date.now(), override = false } = {}) {
    if (override) return true;
    const s = usableState(data, now);
    return !s || s.state === 'ready-to-commit';
  }

  // The "⋯" menu item that lifts the state gating, only while the gating hides the button and it is not lifted yet.
  // Never on a stale repo with changes: that card offers /flow-base --stash, so /flow-commit would not appear anyway.
  // `session` is the live pi session state: a busy or asking one also gates the button, and the item lifts that too.
  function commitOverrideItem(data, { now = Date.now(), override = false, stale = false, session } = {}) {
    return !override && !stale && (!commitAllowed(data, { now }) || sessionHold(session)) ? { act: 'show-commit', label: 'Show /flow-commit anyway' } : null;
  }

  // The card's "what to do now" line: { kind: 'current', dot, text, title } for a usable state, { kind: 'outdated',
  // dot: 'gray', text: '', title } for a stale one (only a marker: the old text is never shown as current), else null.
  function stateLine(data, { now = Date.now() } = {}) {
    const s = usableState(data, now);
    if (s) return { kind: 'current', dot: STATE_DOT[s.state], text: s.next, title: [s.next, s.detail, s.at].filter(Boolean).join('\n\n') };
    if (data && data.available === true && Object.hasOwn(STATE_DOT, data.state)) {
      if (data.stale === true) return { kind: 'outdated', dot: 'gray', text: '', title: 'Declared state is outdated (the repo changed after it was written); ignored' };
      return { kind: 'outdated', dot: 'gray', text: '', title: 'Declared "working" state is older than 30 minutes; ignored' };
    }
    return null;
  }

  const hasLocal = (l) => !!l && typeof l === 'object' && !l.error && Array.isArray(l.files);

  // A reason the repo needs a person's hands, or null. Commits on the base branch are forbidden outside
  // /flow-commit, and anything done by hand that the panel cannot drive is flagged. A clean branch that is only
  // behind, a base with nothing ahead and a task branch with commits ahead are all normal.
  function manualAction(local, baseName) {
    if (!hasLocal(local)) return null;
    if (local.inProgress) return `A ${local.inProgress} is in progress: finish or abort it`;
    if (local.detached) return 'Detached HEAD: switch to a task branch';
    if (baseName && local.branch === baseName && local.ahead > 0) return `Commits on ${baseName}: move them to a task branch`;
    if (local.ahead > 0 && local.behind > 0) return `Diverged from ${local.upstream || 'its upstream'}: reconcile it by hand`;
    return null;
  }

  // The optional facts the "Go work on" strip sends for a repo, so it never says "Deliver changes" for work that
  // must not be delivered: `manual` (why the repo needs a person's hands: manualAction, else the reason of an
  // attention verdict) and `waiting` ({ state, next } of a usable needs-input or blocked declared state, not when
  // the person lifted the gating with `override`). Keys are absent when they do not apply.
  function queueFlags(local, stateData, verdict, { now = Date.now(), override = false } = {}) {
    const out = {};
    const manual = manualAction(local, local && local.base) || (verdict && verdict.state === 'attention' ? verdict.reason : null);
    if (manual) out.manual = manual;
    const s = override ? null : usableState(stateData, now);
    if (s && (s.state === 'needs-input' || s.state === 'blocked')) out.waiting = { state: s.state, next: typeof s.next === 'string' ? s.next : '' };
    if (verdict && verdict.asking === true) out.waiting = { state: 'needs-input', next: 'Answer the question in the session' };
    return out;
  }

  // Whether the COMMITTED card offers /flow-pr. `verdict` is the state of commitVerdict ('running' | 'ok' |
  // 'attention' | null). /flow-pr creates the PR or updates the open one, so `update` only changes the label.
  function prAction(local, prInfo, verdict) {
    const no = (reason) => ({ show: false, update: false, reason });
    if (!hasLocal(local)) return no('Local state not loaded');
    const manual = manualAction(local, local.base);
    if (manual) return no(manual);
    if (local.files.length > 0) return no('Uncommitted changes: run /flow-commit first');
    if (!(local.ahead > 0)) return no('No commits to deliver');
    if (prInfo && prInfo.stale) return no('Branch already merged: run /flow-base');
    if (verdict === 'attention') return no('Needs attention after /flow-commit');
    if (verdict === 'running') return no('Committing…');
    const open = prInfo && Array.isArray(prInfo.prs) ? prInfo.prs : [];
    return { show: true, update: open.some((p) => p && p.head === local.branch), reason: null };
  }

  const FLOW_BASE_HINT = 'Start from a fresh, updated base branch: this branch was already merged';
  const FLOW_STASH_HINT = 'This branch was already merged but has uncommitted changes. /flow-base --stash carries them to the fresh base branch (stash, switch, update, restore). It refuses and changes nothing when the work of this branch is not yet merged or its remote branch not yet deleted.';

  const UNSTAGE_HINT = '/flow-commit needs an empty index. This clears the index (git reset: your changes stay in the working tree) and continues with the normal commit.';

  // What a running command is called in a tooltip.
  const RUNNING_NAME = { 'fix-pr': 'the fix order', 'put-in-conditions': 'the put-in-conditions order' };

  // The tooltip of a button that is disabled while `running` ({ cmd, label }) runs.
  function runningReason(running) {
    const name = RUNNING_NAME[running.cmd] || CMD_TEXT[running.cmd] || `/${running.cmd}`;
    return `Running ${name} (${running.label}): wait for it to finish`;
  }

  // The flow buttons of a repo's LOCAL card, in order: [{ cmd, label, reason?, disabled? }] with cmd flow-commit |
  // flow-commit-unstage | flow-pr | flow-base | flow-base-stash, or []. The one source of truth for the page and the
  // tests. `ctx` is { override (the person lifted the declared-state gating of /flow-commit), verdict ('running' |
  // 'ok' | 'attention' | null, the last /flow-commit), running ({ cmd, label } of a command sent from this page that is
  // still running: the same buttons come back disabled with a reason), retry (label the commit button "Retry …"), session
  // (live pi session state of a repo with changes: busy or asking disables the commit pair with a reason; so does a
  // `local.lastChangeMs` younger than QUIET_MS; `override` lifts both), now }.
  // A stale repo with changed or untracked files offers /flow-base --stash instead of /flow-commit (the skill carries
  // the changes aside, updates the base branch and brings them back). A dirty repo with staged files offers
  // /flow-commit --unstage instead of /flow-commit (the index must be empty). Neither branch button shows while a
  // bare `verdict: 'running'` is passed or when the repo needs manual action.
  function flowButtons(local, prInfo, stateData, ctx = {}) {
    if (ctx.running) {
      const { running, ...rest } = ctx;
      const reason = runningReason(running);
      return flowButtons(local, prInfo, stateData, { ...rest, verdict: null }).map((b) => ({ ...b, disabled: true, reason }));
    }
    if (!hasLocal(local) || manualAction(local, local.base)) return [];
    const { override = false, verdict = null, retry = false, now = Date.now() } = ctx;
    if (local.files.length > 0 && prInfo && prInfo.stale) return verdict === 'running' ? [] : [{ cmd: 'flow-base-stash', label: '/flow-base --stash', reason: FLOW_STASH_HINT }];
    if (local.files.length > 0) {
      if (!commitAllowed(stateData, { now, override })) return [];
      const again = retry ? 'Retry ' : '';
      const hold = override ? null : sessionHold(ctx.session) || (quietPeriod(local.lastChangeMs, now) ? QUIET_REASON : null);
      if (local.stagedCount > 0) return [{ cmd: 'flow-commit-unstage', label: `${again}/flow-commit --unstage`, reason: hold || UNSTAGE_HINT, ...(hold ? { disabled: true } : {}) }];
      return [{ cmd: 'flow-commit', label: `${again}/flow-commit`, ...(hold ? { disabled: true, reason: hold } : {}) }];
    }
    const pa = local.ahead > 0 ? prAction(local, prInfo, verdict) : null;
    if (pa && pa.show) return [{ cmd: 'flow-pr', label: pa.update ? '/flow-pr (update PR)' : '/flow-pr' }];
    if (prInfo && prInfo.stale && verdict !== 'running') return [{ cmd: 'flow-base', label: '/flow-base', reason: FLOW_BASE_HINT }];
    return [];
  }

  // Tooltip of the red stale chip: names the button the card really offers. `stale` is { via, pr }; `dirty` is whether the
  // repo has changed or untracked files (then the button is /flow-base --stash, which carries them).
  function staleChipTitle(stale, dirty) {
    const why = stale && stale.via === 'merged' ? `PR #${stale.pr} from this branch was merged.` : 'The remote branch was deleted, so its work was merged.';
    if (dirty) return `${why} Press the /flow-base --stash button: it carries your uncommitted changes to a fresh, updated base branch.`;
    return `${why} Press the /flow-base button to start from a fresh, updated base branch.`;
  }

  // Whether a PR card offers "Fix CI": only when its checks failed (even with no GitHub Actions run to re-run).
  function fixPrAction(pr) {
    if (pr && pr.checks && pr.checks.state === 'failed') return { show: true, reason: null };
    return { show: false, reason: 'The checks have not failed' };
  }

  // Where a repo's LOCAL card goes, by Git state alone: { column, attn, row }. `column` is changes | committed | clean, or
  // null when the repo has no local card (clean, nothing stale, only its PR cards); `row` is the compact clean row;
  // `attn` marks a card that needs a person (error, stale branch, manual action, failed /flow-commit). `verdict` is
  // the state of the last /flow-commit and `prCount` the number of open PRs of the repo.
  function localPlacement(local, prInfo, prCount, verdict) {
    const l = local || {};
    if (l.error) return { column: 'changes', attn: true, row: false };
    const attn = !!(prInfo && prInfo.stale) || !!manualAction(l, l.base) || verdict === 'attention';
    if ((l.files || []).length > 0) return { column: 'changes', attn, row: false };
    if ((l.ahead || 0) > 0) return { column: 'committed', attn, row: false };
    if (attn) return { column: 'clean', attn: true, row: false };
    if (!prCount) return { column: 'clean', attn: false, row: true };
    return { column: null, attn: false, row: false };
  }

  // Where a repo's LOCAL card goes on the board: { column, attn, row }, built on localPlacement. `column` is attention |
  // changes | committed | merged | idle | clean, or null (no local card). A stale branch with a clean tree and nothing ahead
  // goes to `merged`; a card that needs a person for another reason goes to `attention`, so it is never hidden in the
  // collapsed Idle bar; a quiet repo is an `idle` row. With `cleanAsColumn` the old Clean column holds the rows and the
  // attention cards instead (and there is no `attention` or `idle` place).
  function boardPlacement(local, prInfo, prCount, verdict, cleanAsColumn = false) {
    const place = localPlacement(local, prInfo, prCount, verdict);
    if (place.column !== 'clean') return place;
    if (prInfo && prInfo.stale && place.attn) return { column: 'merged', attn: true, row: false };
    if (cleanAsColumn) return place;
    return place.attn ? { column: 'attention', attn: true, row: false } : { column: 'idle', attn: false, row: true };
  }

  // The board's columns left to right. Needs attention exists only while it has cards (`attentionCount`); Clean only
  // when the person asked for it as a column.
  function boardColumns(cleanAsColumn = false, attentionCount = 0) {
    const first = cleanAsColumn ? ['clean'] : attentionCount > 0 ? ['attention'] : [];
    return [...first, 'changes', 'committed', 'prs', 'merged'];
  }

  // A PR that cannot merge because of something the user must fix.
  const isProblem = (pr) => !pr.ready && (pr.checks.state === 'failed' || ['DIRTY', 'BEHIND'].includes(pr.mergeStateStatus));

  // The rank of a PR (the board shows all of them in the one `prs` column; the work queue relies on this).
  const prColumn = (pr) => (pr.ready ? 'ready' : 'progress');

  // The order inside the Pull requests column: 0 ready to merge, 1 problems (red), 2 the rest (checks running, waiting).
  const prRank = (pr) => (pr.ready ? 0 : isProblem(pr) ? 1 : 2);

  // The cards of the column in that order, keeping the original order inside each group; `get` reads the PR of an item.
  const sortPrCards = (items, get = (x) => x) => items.map((item, i) => ({ item, i, rank: prRank(get(item)) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i).map((x) => x.item);

  // Verdict after /flow-commit: { state: 'running' | 'ok' | 'attention', reason }, or null without a record.
  // `sent` is { at (epoch ms), head, files } recorded when the command was sent; `session` is the state of
  // GET /api/pi-status (busy | idle | closed | ambiguous | unknown, or undefined before the first answer).
  // ok/attention is judged from Git (clean tree including untracked files, HEAD changed, commits ahead) and from
  // the session state, never from terminal text. The panel does not judge the quality of the commits.
  const SETTLE_MS = 30 * 1000; // an idle prompt right after sending may just not have started yet
  const UNKNOWN_MS = 15 * 60 * 1000; // how long an unknown session may be given the benefit of the doubt

  function commitVerdict(sent, local, session, now = Date.now()) {
    if (!sent) return null;
    const running = (reason) => ({ state: 'running', reason });
    const attention = (reason) => ({ state: 'attention', reason });
    if (!hasLocal(local)) return running('Waiting for the repo state');
    if (session === 'busy') return running('The session is working');
    const n = local.files.length;
    const changed = !!local.head && local.head !== sent.head;
    if (n === 0 && changed && local.ahead > 0) return { state: 'ok', reason: 'Committed: clean tree and commits ready to deliver' };
    const elapsed = now - sent.at;
    const filesLeft = `${n} file${n === 1 ? '' : 's'} still uncommitted after /flow-commit`;
    if (session === 'idle' || session === 'closed') {
      if (elapsed < SETTLE_MS) return running('Waiting for the session to start');
      if (n > 0) return attention(filesLeft);
      if (!changed) return attention(session === 'closed' ? 'The session closed before /flow-commit made a commit' : 'No new commit after /flow-commit (HEAD did not change)');
      return attention('HEAD changed but no commits are left to deliver');
    }
    if (elapsed < UNKNOWN_MS) return running('Waiting for the session');
    if (n > 0) return attention(filesLeft);
    return attention(changed ? 'HEAD changed but no commits are left to deliver' : 'No change 15 minutes after /flow-commit and the session state is unknown');
  }

  // What the status line says while each command a button can send is running.
  const RUNNING_LABEL = {
    'flow-commit': 'committing…', 'flow-commit-unstage': 'committing…', 'flow-pr': 'creating pull request…',
    'flow-base': 'updating base branch…', 'flow-base-stash': 'updating base branch…',
    'fix-pr': 'fixing pull request…', 'put-in-conditions': 'putting repo in conditions…', 'flow-next': 'starting the next task…',
  };
  // The GitHub-like color of the progress line of each command (the pending CI chip is always yellow).
  const RUN_COLOR = { 'flow-commit': 'blue', 'flow-commit-unstage': 'blue', 'flow-pr': 'green', 'flow-base': 'purple', 'flow-base-stash': 'purple', 'fix-pr': 'orange' };
  const runColor = (cmd) => RUN_COLOR[cmd] || 'gray';
  const CMD_TEXT = { 'flow-commit': '/flow-commit', 'flow-commit-unstage': '/flow-commit --unstage', 'flow-pr': '/flow-pr', 'flow-base': '/flow-base', 'flow-base-stash': '/flow-base --stash' };
  // The pseudo-verdict of a command whose order is still being sent to the session: it behaves as a running one, with
  // the label the real running verdict shows for that command.
  const sendingVerdict = (cmd) => ({ state: 'running', cmd, label: RUNNING_LABEL[cmd] || '', reason: 'Sending the order to the session' });
  const SESSION_CLOSED = 'The session closed while the command was running';
  const ASKING = 'waiting for your answer in the session';

  // The CSS animations of the progress lines (pulsing dot, ellipsis) all last this long. The page re-renders #app on
  // every draw, which restarts a CSS animation; an inline negative animation-delay of `now mod ANIM_MS` puts a
  // freshly drawn element back at the phase it would have had, so the animation looks continuous across redraws.
  const ANIM_MS = 1200;
  const animDelay = (now = Date.now()) => 0 - (now % ANIM_MS);

  // Verdict of any command sent from the page: { state: 'running' | 'ok' | 'attention', reason, label }, or null when
  // there is no record or the command has no verdict (fix-pr and put-in-conditions are dropped once the session is
  // idle: a failure answer from the session is a legitimate outcome). `sent` is { cmd, at, head, branch, files, ahead,
  // busySeen? } recorded when the command was confirmed; `session` is the state of GET /api/pi-status; `prInfo` is the
  // answer of /api/prs. Judged from Git and the session state, never from terminal text. /flow-commit and
  // /flow-commit --unstage are judged by commitVerdict (the latter must also leave an empty index).
  function flowVerdict(sent, local, session, prInfo, now = Date.now()) {
    if (!sent) return null;
    // A session showing a selection dialog is waiting for the person, who is the blocker: stay running, never expire.
    if (session === 'asking') return { state: 'running', reason: ASKING, label: ASKING, cmd: sent.cmd, asking: true };
    const label = RUNNING_LABEL[sent.cmd] || '';
    const done = (v) => (v ? { ...v, label, cmd: sent.cmd } : null);
    if (sent.cmd === 'flow-commit' || sent.cmd === 'flow-commit-unstage') {
      const v = commitVerdict(sent, local, session, now);
      if (v && v.state === 'ok' && sent.cmd === 'flow-commit-unstage' && local.stagedCount > 0) {
        return done({ state: 'attention', reason: `${local.stagedCount} file${local.stagedCount === 1 ? ' is' : 's are'} still staged after /flow-commit --unstage` });
      }
      return done(v);
    }
    const running = (reason) => done({ state: 'running', reason });
    const attention = (reason) => done({ state: 'attention', reason });
    const noCommit = sent.cmd === 'fix-pr' || sent.cmd === 'put-in-conditions' || sent.cmd === 'flow-next';
    if (!hasLocal(local)) return running('Waiting for the repo state');
    if (session === 'busy') return running('The session is working');
    const text = CMD_TEXT[sent.cmd] || `/${sent.cmd}`;
    const branch = local.branch || '(detached)';
    const base = local.base || 'the base branch';
    let ok = false;
    let notOk = '';
    if (sent.cmd === 'flow-pr') {
      const open = prInfo && Array.isArray(prInfo.prs) ? prInfo.prs : [];
      ok = local.files.length === 0 && !local.noUpstream && local.ahead === 0 && open.some((p) => p && p.head === local.branch);
      notOk = `No open pull request for ${branch} after ${text}`;
    } else if (!noCommit) {
      const up = local.branch === local.base && local.behind === 0 && local.ahead === 0;
      // The plain /flow-base asks for a clean tree only when it was clean when sent: files that appeared afterwards are
      // the person already working on the fresh base branch, not a failed command. A record without the count stays strict.
      ok = up && (sent.cmd === 'flow-base-stash' || local.files.length === 0 || sent.files === 0);
      notOk = local.branch === sent.branch ? `Still on ${branch} after ${text}` : `Not on a ${sent.cmd === 'flow-base' ? 'clean, ' : ''}up-to-date ${base} after ${text}`;
    }
    if (ok) return done({ state: 'ok', reason: `${text} done` });
    const elapsed = now - sent.at;
    const settling = elapsed < SETTLE_MS && !sent.busySeen;
    if (session === 'closed') return noCommit || settling ? attention(SESSION_CLOSED) : attention(notOk);
    if (session === 'idle') {
      if (settling) return running('Waiting for the session to start');
      return noCommit ? null : attention(notOk);
    }
    if (elapsed < UNKNOWN_MS) return running('Waiting for the session');
    return attention(`No change 15 minutes after ${text} and the session state is unknown`);
  }

  // ---------- event stream (RP77b) ----------
  // The text of a stream, frame by frame: the complete frames as { event, data } and the unfinished tail as `rest` (feed it back with the next chunk).
  // Comments (heartbeat) and fields other than event and data are ignored; a frame without data is no event.
  function parseSse(buffer) {
    const events = [];
    let rest = String(buffer);
    for (let m = /\r?\n\r?\n/.exec(rest); m; m = /\r?\n\r?\n/.exec(rest)) {
      const lines = rest.slice(0, m.index).split(/\r?\n/);
      rest = rest.slice(m.index + m[0].length);
      let event = 'message';
      const data = [];
      for (const line of lines) {
        if (line.startsWith(':')) continue;
        const at = line.indexOf(':');
        const field = at < 0 ? line : line.slice(0, at);
        const value = at < 0 ? '' : line.slice(at + 1).replace(/^ /, '');
        if (field === 'event') event = value; else if (field === 'data') data.push(value);
      }
      if (data.length) events.push({ event, data: data.join('\n') });
    }
    return { events, rest };
  }

  const EVENT_MAX = 64 * 1024;
  const EVENT_PI = ['closed', 'idle', 'busy', 'asking', 'ambiguous', 'unknown'];
  const EVENT_LIVE = ['none', 'free', 'working', 'waiting', 'unknown'];
  const isObject = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
  function liveEntry(x) {
    if (!isObject(x) || typeof x.id !== 'string' || !/^[0-9a-f]{10}$/.test(x.id)) return null;
    if (!EVENT_PI.includes(x.state) || !isObject(x.live) || !EVENT_LIVE.includes(x.live.state)) return null;
    return { id: x.id, state: x.state, ask: typeof x.ask === 'string' ? x.ask : undefined, live: x.live };
  }
  // A `live` frame as { id, state, ask, live }; a `snapshot` frame as an array of those (bad entries dropped); anything else, null.
  function liveEvent(frame) {
    if (!frame || (frame.event !== 'live' && frame.event !== 'snapshot') || typeof frame.data !== 'string' || frame.data.length > EVENT_MAX) return null;
    let body;
    try { body = JSON.parse(frame.data); } catch { return null; }
    if (frame.event === 'live') return liveEntry(body);
    return Array.isArray(body) ? body.map(liveEntry).filter(Boolean) : null;
  }
  // RP79 (S68, S74): the page keeps the last chats it read, per repo, and paints them at once when the card is opened again. The use order
  // is a counter, never a clock. A cached live state is never reused: chatFromCache replaces it with 'unknown' (no question, no answer buttons).
  let cacheTick = 0;
  const plainCopy = (x) => (x === undefined ? null : JSON.parse(JSON.stringify(x)));
  const validCacheId = (id) => typeof id === 'string' && id !== '';
  function chatCachePut(cache, id, entry, max = 8) {
    if (!validCacheId(id) || !entry || typeof entry !== 'object' || !entry.info || typeof entry.info !== 'object') return false;
    if (!Object.hasOwn(cache, id) && Object.keys(cache).length >= max) {
      const oldest = Object.keys(cache).reduce((a, b) => (cache[b].at < cache[a].at ? b : a));
      delete cache[oldest];
    }
    cache[id] = { info: plainCopy(entry.info), hist: plainCopy(entry.hist), key: entry.key, at: cacheTick++ };
    return true;
  }
  function chatCacheGet(cache, id) {
    if (!validCacheId(id) || !Object.hasOwn(cache, id)) return null;
    cache[id].at = cacheTick++;
    const { info, hist, key } = cache[id];
    return { info: plainCopy(info), hist: plainCopy(hist), key };
  }
  const chatFromCache = (entry) => (entry ? { info: { ...plainCopy(entry.info), live: { state: 'unknown', count: 0 } }, hist: plainCopy(entry.hist), key: entry.key, cached: true } : null);

  // With the stream open the polls are only a safety net; without it they keep today's 10 s and 5 s.
  const eventsPlan = ({ connected }) => (connected ? { pollLiveMs: 60000, chatMs: 30000 } : { pollLiveMs: 10000, chatMs: 5000 });
  const eventsRetryMs = (attempt) => Math.min(30000, 1000 * 2 ** attempt);
  // The server sends a heartbeat every 15 s: three missed beats mean the stream is dead (a server that vanished without closing it).
  const eventsStale = ({ connected, lastByteAt, now }) => connected === true && Number.isFinite(lastByteAt) && Number.isFinite(now) && now - lastByteAt >= 45000;

  // RP80: what the page takes from a /api/board answer. A fact is dropped when the page read it directly at the same time or later
  // (lastAt[id][kind]; an unknown page time never blocks), and so is its error. `missing` lists, in board order, the repos that came
  // without a good local, prs, roadmap or state (req does not count; a fact the page guard dropped still came).
  const BOARD_KINDS = ['local', 'prs', 'roadmap', 'state', 'req'];
  function boardApply(board, { lastAt = {} } = {}) {
    const set = {};
    const missing = [];
    for (const [id, e] of Object.entries(board.repos || {})) {
      const page = lastAt[id] || {};
      const stale = (k) => Number.isFinite(page[k]) && Number.isFinite((e.at || {})[k]) && page[k] >= e.at[k];
      const out = {};
      for (const k of BOARD_KINDS) if (e[k] != null && !stale(k)) out[k] = e[k];
      const errors = Object.fromEntries(Object.entries(e.errors || {}).filter(([k]) => !stale(k)));
      if (Object.keys(errors).length) out.errors = errors;
      set[id] = out;
      if (BOARD_KINDS.slice(0, 4).some((k) => e[k] == null)) missing.push(id);
    }
    return { set, rev: board.rev, refreshing: board.refreshing || [], missing };
  }
  const htmlEsc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // RP87 (S9): the change chips of a repo card, shared by the board card (Work) and the Summary card, which used to build them twice. `c` is the model's
  // `changes` ({ files, added, deleted, ahead, behind, noUpstream }) or null (not loaded). Pure; anything that is not a count reads as 0; the id is escaped.
  function changeChips(c, id) {
    if (!isObject(c)) return '';
    const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
    const files = n(c.files);
    return (files ? `<button class="chip yellow chip-btn" data-act="diff" data-id="${htmlEsc(id)}" title="View diff">● ${files} file${files === 1 ? '' : 's'} <span class="add">+${n(c.added)}</span> <span class="del">−${n(c.deleted)}</span></button>` : '')
      + (n(c.ahead) ? `<span class="chip blue">↑ ${n(c.ahead)} unpushed${c.noUpstream ? ' · no upstream' : ''}</span>` : '')
      + (n(c.behind) ? `<span class="chip gray">↓ ${n(c.behind)} behind</span>` : '');
  }

  // RP86 (S9): ONE read model per repo. The page keeps each fact of a repo in its own map (local, prs, roadmap, state, req) and the Summary row in another; the
  // board cards, the Summary cards, the "go work on" strip and the Files tab used to read those maps each its own way. This joins them, pure: `loaded` is what
  // the Summary button needed (a good local state with its file list AND a good PR answer), `changes` the Summary chips (null until the local state loads), and
  // `row` the Summary row with a free session lifted to "working" while a command of the repo runs (a copy: the server answer is never changed).
  function repoModel(facts) {
    const x = isObject(facts) ? facts : {};
    const local = isObject(x.local) ? x.local : null;
    const prs = isObject(x.prs) ? x.prs : null;
    const l = local || {};
    const p = prs || {};
    const list = Array.isArray(p.prs) ? p.prs : [];
    const files = Array.isArray(l.files) ? l.files : null;
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const row = isObject(x.row) ? x.row : null;
    return {
      l, p, prs: list,
      dirty: !!files && files.length > 0,
      unpushed: num(l.ahead) > 0,
      ready: list.filter((q) => isObject(q) && q.ready).length,
      loaded: !!local && !local.error && !!files && !!prs && !prs.error,
      changes: local && !local.error && files ? { files: files.length, added: num(l.added), deleted: num(l.deleted), ahead: num(l.ahead), behind: num(l.behind), noUpstream: !!l.noUpstream } : null,
      roadmap: x.roadmap ?? null,
      state: x.state ?? null,
      req: x.req ?? null,
      row: row && isObject(row.session) && row.session.state === 'free' && x.running === true ? { ...row, session: { ...row.session, state: 'working' } } : row,
    };
  }

  // RP88b (S9, S10): the frame of a repo card, ONE function for the Summary card and the board card. `m` carries ready HTML for what differs on purpose (the caller
  // escapes it) and the raw text it must escape itself (id, label, branch). Mode 'summary': { id, label, cls, current, identity, branch: { text, title }, chips, meta,
  // body }. Mode 'work': { attn, top, before: [lines], branch, between: [lines], chips, after: [lines] }: one line each, in that order. Total: anything else draws ''.
  function RepoCard(m, mode) {
    if (!isObject(m)) return '';
    const e = (v) => htmlEsc(v == null ? '' : v);
    const b = isObject(m.branch) ? m.branch : {};
    const s = (v) => (typeof v === 'string' ? v : '');
    const chips = s(m.chips);
    if (mode === 'summary') {
      return `<article class="rs-card${s(m.cls)}" data-id="${e(m.id)}" data-act="chat-open" tabindex="0"${m.current ? ' aria-current="true"' : ''} aria-label="${e(m.label)}">
      <div class="rs-l1">${s(m.identity)}<span class="mono rs-branch" title="${e(b.title)}">${e(b.text)}</span>${chips ? `<span class="rs-chips">${chips}</span>` : ''}<span class="rs-spacer"></span>${s(m.meta)}</div>
      <div class="rs-l2">${s(m.body)}</div>
    </article>`;
    }
    if (mode === 'work') {
      const lines = (a) => (Array.isArray(a) ? a.map(s) : []);
      return `<div class="card ${m.attn ? 'attn' : ''}">
    ${[s(m.top), ...lines(m.before), `<div class="branch one-line" title="${e(b.title)}">${e(b.text)}</div>`, ...lines(m.between), chips ? `<div class="chips">${chips}</div>` : '', ...lines(m.after)].join('\n    ')}
  </div>`;
    }
    return '';
  }

  // The wait before the next board request: 3 s while it works, then doubling per failure up to 30 s.
  const boardWait = ({ ok, failures }) => (ok ? 3000 : Math.min(30000, 3000 * 2 ** failures));

  // RP62 (S61, S77): the Claude usage bar. `usage` is the answer of /api/usage; opts { now, timeZone } are for tests (default: the clock and the local zone).
  // Result { state: 'ok' | 'old' | 'none', five, seven: { text, tone: '' | 'warn' | 'error' | 'dim' }, label, title }. 'none' (no file, or no window at all) wins over 'old'.
  const USAGE_WARN = 70;
  const USAGE_ERROR = 90;
  const USAGE_NONE_TITLE = 'Claude usage: the usage file has not been written yet, or the usage is not reported by the session. Sessions already open must be restarted to report it.';
  const USAGE_TITLE = 'Claude usage: share of the 5-hour and 7-day limits used, and when each resets (↻). A dash means the window has reset or is not reported.';

  function usageParts(ms, timeZone) {
    const f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return { day: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday, time: `${p.hour}:${p.minute}` };
  }

  // RP96: the time left, as "<1m", "59m", "2h 29m" (under a day) or "4d 14h". Total: anything that is not a positive finite number reads "<1m".
  function usageRemaining(ms) {
    const m = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 60000) : 0;
    if (m < 1) return '<1m';
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
  }
  const USAGE_PACE_MARGIN = 5; // points over the share of the window already run before it counts as "ahead of the clock"
  const NO_WINDOW = { percent: null, left: null, elapsed: null, reset: null, ahead: false };

  // `span` is the length of the window in ms. Besides the RP62 text and tone it carries what the meters draw: the percent, the time left, the share of the
  // window already run (0 to 1), the reset text and whether the use runs ahead of the clock (never for an old file).
  function usageWindow(name, w, { now, timeZone, old, span }) {
    if (!w || w.expired || typeof w.percent !== 'number') return { text: `${name} –`, tone: 'dim', ...NO_WINDOW };
    const at = usageParts(w.resetAt, timeZone);
    const reset = at.day === usageParts(now, timeZone).day ? at.time : `${at.weekday} ${at.time}`;
    const tone = old ? 'dim' : w.percent >= USAGE_ERROR ? 'error' : w.percent >= USAGE_WARN ? 'warn' : '';
    const run = Math.min(100, Math.max(0, Math.round((1 - (w.resetAt - now) / span) * 100)));
    return { text: `${name} ${w.percent}% ↻${reset}`, tone, percent: w.percent, left: usageRemaining(w.resetAt - now), elapsed: run / 100, reset, ahead: !old && w.percent - run > USAGE_PACE_MARGIN };
  }

  function usageAge(ms) {
    const min = Math.max(0, Math.floor(ms / 60000));
    return min < 60 ? `${min} min ago` : `${Math.floor(min / 60)} h ago`;
  }

  function usageView(usage, { now = Date.now(), timeZone } = {}) {
    const u = isObject(usage) ? usage : {};
    const old = u.available === true && u.stale === true;
    const five = usageWindow('5h', u.five, { now, timeZone, old, span: 5 * 3600000 });
    const seven = usageWindow('7d', u.seven, { now, timeZone, old, span: 7 * 86400000 });
    const windows = `${five.text} · ${seven.text}`;
    if (u.available !== true || (!u.five && !u.seven)) return { state: 'none', five, seven, label: 'Claude usage: no data', title: USAGE_NONE_TITLE };
    const updated = Number.isFinite(u.updatedAt) ? usageAge(now - u.updatedAt) : null; // RP96: how old the data is, always known for the popover
    if (!old) return { state: 'ok', five, seven, label: windows, title: USAGE_TITLE, age: null, updated };
    return { state: 'old', five, seven, label: `${windows} · ${usageAge(now - u.updatedAt)}`, title: `${USAGE_TITLE} The usage file is old: the numbers may have changed.`, age: updated, updated };
  }

  // RP96 (S12, S13): the header element as HTML, from a usageView result. Pure and total; every text goes through usageEsc and the only numbers that reach a
  // style attribute are integers clamped to 0..100. A message (no data) is just its text; otherwise one compact meter per window (name, bar with fill and pace
  // mark, percent, time left) and, hidden until hover, click or focus, the popover with the detail.
  const usageEsc = htmlEsc;
  const usagePct = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, Math.round(v))) : null);
  const USAGE_WINDOWS = [['five', '5h', 'Session (5 h)'], ['seven', '7d', 'Weekly (7 d)']];
  function usageHtml(view) {
    const v = isObject(view) ? view : {};
    if (v.state !== 'ok' && v.state !== 'old') return usageEsc(v.label);
    const meters = [];
    const details = [];
    for (const [key, name, title] of USAGE_WINDOWS) {
      const w = isObject(v[key]) ? v[key] : {};
      const tone = ['warn', 'error', 'dim'].includes(w.tone) ? w.tone : '';
      const pct = usagePct(w.percent);
      const cls = tone ? ` usage-${tone}` : '';
      if (pct === null) {
        meters.push(`<span class="um usage-dim" data-win="${name}"><span class="um-name">${name}</span><span class="um-pct">–</span></span>`);
        details.push(`<div class="up-win usage-dim"><div class="up-title">${title}</div><div class="up-line"><span>No data: the window reset or is not reported</span></div></div>`);
        continue;
      }
      const run = usagePct(typeof w.elapsed === 'number' ? w.elapsed * 100 : null) ?? 0;
      const said = `${name}: ${pct}% used, ${run}% of the window gone${w.ahead === true ? ', more than the clock' : ''}`;
      const bar = (c) => `<span class="${c}" role="img" aria-label="${usageEsc(said)}"><i class="um-fill" style="width:${pct}%"></i><i class="um-pace" style="left:${run}%"></i></span>`;
      const flag = tone === 'warn' || tone === 'error' ? '<b class="um-flag" aria-hidden="true">⚠</b>' : '';
      meters.push(`<span class="um${cls}" data-win="${name}"><span class="um-name">${name}</span>${bar('um-bar')}<span class="um-pct">${flag}${pct}%</span><span class="um-left">${usageEsc(w.left)}</span></span>`);
      details.push(`<div class="up-win${cls}"><div class="up-title">${title}</div>${bar('um-bar up-bar')}<div class="up-line"><span>${pct}% used</span><span>Resets in ${usageEsc(w.left)}</span></div><div class="up-sub">Resets at ${usageEsc(w.reset)} · ${run}% of the window gone</div>${w.ahead === true ? '<div class="up-warn">⚠ Using it faster than the clock</div>' : ''}</div>`);
    }
    const age = v.state === 'old' && v.age ? `<span class="um-age">${usageEsc(v.age)}</span>` : '';
    const note = v.state === 'old' ? '<div class="up-note">The usage file is old: the numbers may have changed.</div>' : '';
    const foot = v.updated ? `<div class="up-foot">Updated ${usageEsc(v.updated)}</div>` : '';
    return `${meters.join('')}${age}<div class="usage-pop" role="group" aria-label="Claude usage details">${details.join('')}${note}${foot}</div>`;
  }

  return { repoModel, changeChips, RepoCard, usageView, usageHtml, usageRemaining, boardApply, boardWait, chatCachePut, chatCacheGet, chatFromCache, API_VERSION, isRefreshing, LOCAL_REFRESH_MS, HOT_REFRESH_MS, FULL_REFRESH_MS, SENT_POLL_MS, isHotRepo, refreshPlan, runColor, QUIET_MS, quietPeriod, piPollTargets, LIVE_CHECK_MS, liveSession, sendingVerdict, ANIM_MS, animDelay, flowVerdict, runningReason, commitAllowed, commitOverrideItem, staleChipTitle, stateLine, manualAction, prAction, flowButtons, fixPrAction, localPlacement, boardPlacement, boardColumns, isProblem, prColumn, prRank, sortPrCards, commitVerdict, queueFlags, isOutdated, conformityView, cardWarning, cardMenu, roomOfRepo, roomTag, roomMenu, roomIssuesNotice, presenceLabel, presenceDot, parseSse, liveEvent, eventsPlan, eventsRetryMs, eventsStale };
}));
