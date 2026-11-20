'use strict';
// RP240 and RP215: the one check of an image, whether it is read from a session file (GET /api/chat/image) or sent by the page to a session.
// Only a closed list of types whose bytes start as the type says, strict base64, at most IMAGE_MAX bytes decoded. Nothing here touches the disk.
const { HttpError } = require('./errors.js');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IMAGE_TYPES = {
  'image/png': (b) => b.length >= 8 && b.subarray(0, 8).equals(PNG),
  'image/jpeg': (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1')),
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};
const IMAGE_MAX = 5 * 1024 * 1024;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

// The bytes of one { data, mimeType } block, or a 415 (type, base64 or bytes) or 413 (size).
function decodeImage(img) {
  const matches = img && typeof img.mimeType === 'string' && Object.hasOwn(IMAGE_TYPES, img.mimeType) ? IMAGE_TYPES[img.mimeType] : null;
  if (!matches || typeof img.data !== 'string') throw new HttpError(415, 'Unsupported image');
  if (img.data.length > Math.ceil(IMAGE_MAX / 3) * 4) throw new HttpError(413, 'Image too large');
  if (img.data.length % 4 || !BASE64.test(img.data)) throw new HttpError(415, 'Unsupported image');
  const body = Buffer.from(img.data, 'base64');
  if (body.length > IMAGE_MAX) throw new HttpError(413, 'Image too large');
  if (!matches(body)) throw new HttpError(415, 'Unsupported image');
  return body;
}

// RP215: the images a page sends with a message, as pi takes them ({ type: 'image', data, mimeType }). Absent is none; else a list of at most SEND_MAX objects
// with exactly `data` and `mimeType` (a name, a path or any other field is refused: the server never uses a name from the client), each one passing decodeImage.
const SEND_MAX = 4;
function sentImages(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > SEND_MAX) throw new HttpError(400, `Send at most ${SEND_MAX} images as a list`);
  for (const img of value) {
    if (!img || typeof img !== 'object' || Array.isArray(img) || Object.keys(img).some((k) => k !== 'data' && k !== 'mimeType')) throw new HttpError(400, 'An image is { data, mimeType } and nothing else');
  }
  for (const img of value) decodeImage(img);
  return value.map((img) => ({ type: 'image', data: img.data, mimeType: img.mimeType }));
}

module.exports = { decodeImage, sentImages, IMAGE_MAX, SEND_MAX };
