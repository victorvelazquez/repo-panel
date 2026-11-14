'use strict';
// RP179: the service worker. A push carries no text: it asks the panel for the pending notices and shows them. It ALWAYS shows something (iOS revokes the
// subscription of a push that shows nothing), a generic notice when it cannot get the text. It reads nothing else and keeps nothing.
const REPO_ID = /^[0-9a-f]{10}$/;

async function pending() {
  try {
    const sub = await registration.pushManager.getSubscription();
    if (!sub) return [];
    const res = await fetch('/push/pending', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.notices) ? data.notices.filter((n) => n && typeof n.title === 'string') : [];
  } catch { return []; }
}

async function onPush() {
  const list = await pending();
  if (!list.length) { await registration.showNotification('Repo Panel', { body: 'Something needs you. Open the panel to see what.', icon: '/icon.svg' }); return; }
  for (const n of list) await registration.showNotification(n.title, { body: String(n.body || ''), tag: `rp-${n.id}-${n.kind}`, icon: '/icon.svg', data: { id: n.id } });
}

async function onClick(note) {
  note.close();
  const id = note.data && note.data.id;
  const url = typeof id === 'string' && REPO_ID.test(id) ? `/#/repo/${id}/chat` : '/';
  const open = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  try {
    if (!open.length) throw new Error('no window');
    await open[0].focus();
    await open[0].navigate(url);
  } catch { await clients.openWindow(url); }
}

addEventListener('push', (e) => e.waitUntil(onPush()));
addEventListener('notificationclick', (e) => e.waitUntil(onClick(e.notification)));
