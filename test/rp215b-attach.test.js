'use strict';
// RP215b: images in the chat, the screen. Only the logic is tested here (the screen itself is approved by the person by looking at it): the size an image is shrunk to,
// which picked files are taken (images only, at most 4 per message), and the pending bubble of a message sent with images.
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../public/resumen.js');

test('fitImageSize: the long side goes down to 1568 px keeping the ratio; a smaller image is never enlarged; a bad size is null', () => {
  assert.deepEqual(R.fitImageSize(4032, 3024), { width: 1568, height: 1176 });
  assert.deepEqual(R.fitImageSize(1170, 2532), { width: 725, height: 1568 });
  assert.deepEqual(R.fitImageSize(1568, 1000), { width: 1568, height: 1000 });
  assert.deepEqual(R.fitImageSize(800, 600), { width: 800, height: 600 });
  assert.deepEqual(R.fitImageSize(100000, 1), { width: 1568, height: 1 }, 'never below one pixel');
  assert.deepEqual(R.fitImageSize(3000, 2000, 1000), { width: 1000, height: 667 });
  for (const [w, h] of [[0, 10], [10, 0], [-5, 10], [NaN, 10], [10, Infinity], ['800', 600], [null, null]]) assert.equal(R.fitImageSize(w, h), null, `${w}x${h}`);
});

test('attachPick: takes images only, up to 4 per message counting the ones already attached, and says why it left any out', () => {
  const f = (type) => ({ type });
  assert.deepEqual(R.attachPick([f('image/png'), f('image/jpeg')], 0), { take: [0, 1], note: '' });
  assert.deepEqual(R.attachPick([f('image/heic'), f('image/webp')], 1), { take: [0, 1], note: '' }, 'any image the browser can decode is shrunk to JPEG');
  assert.deepEqual(R.attachPick([f('application/pdf'), f('image/png'), f('text/html'), f(''), {}], 0), { take: [1], note: 'Only images can be attached' });
  assert.deepEqual(R.attachPick([f('image/png'), f('image/png'), f('image/png')], 2), { take: [0, 1], note: 'At most 4 images per message' });
  assert.deepEqual(R.attachPick([f('image/png')], 4), { take: [], note: 'At most 4 images per message' });
  assert.deepEqual(R.attachPick([f('image/svg+xml'), f('image/png')], 0), { take: [1], note: 'Only images can be attached' }, 'an SVG is not a picture the server takes');
  assert.deepEqual(R.attachPick([], 0), { take: [], note: '' });
  assert.deepEqual(R.attachPick(null, 0), { take: [], note: '' });
});

test('pending bubble: a message sent with images shows one «Image» frame per image until the history has it, and an empty text is fine', () => {
  const body = (pending) => R.chatBody({ id: 'r1', info: { adopted: { id: 's1', name: 'panel:a' }, adoptedFound: true, sessions: [] }, hist: { found: true, items: [], truncated: false }, pending }, { now: Date.now() });
  const html = body([{ text: 'look', state: 'sending', base: 0, images: 2 }]);
  assert.equal((html.match(/class="m-img/g) || []).length, 2);
  assert.match(html, /look/);
  assert.equal((body([{ text: '', state: 'sending', base: 0, images: 1 }]).match(/class="m-img/g) || []).length, 1);
  assert.equal((body([{ text: 'plain', state: 'sending', base: 0 }]).match(/m-img/g) || []).length, 0);
});

test('footButtons: attached images count as something to send, like text', () => {
  assert.deepEqual(R.footButtons({ busy: true, canSteer: true, hasText: true }), R.footButtons({ busy: true, canSteer: true, hasText: true }));
  const idle = R.footButtons({ busy: false, canSteer: false, hasText: false });
  assert.equal(idle.send, true);
});

test('attachStripHtml: one thumbnail per attached image with its remove button; only blob: addresses become an <img>; nothing attached, nothing drawn', () => {
  assert.equal(R.attachStripHtml([]), '');
  assert.equal(R.attachStripHtml(null), '');
  const html = R.attachStripHtml([{ url: 'blob:http://127.0.0.1/a' }, { url: 'javascript:alert(1)' }, { url: '"><b>' }]);
  assert.equal((html.match(/data-act="attach-remove"/g) || []).length, 3);
  assert.match(html, /<img src="blob:http:\/\/127\.0\.0\.1\/a"/);
  assert.ok(!html.includes('javascript:') && !html.includes('<b>'));
  assert.match(html, /data-n="2"/);
});
