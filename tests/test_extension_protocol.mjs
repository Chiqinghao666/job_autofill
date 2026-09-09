import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { buildApiRequest, stableFormSignature } from '../extension/protocol.js';

test('stableFormSignature ignores field order but detects a changed field fingerprint', () => {
  const first = stableFormSignature(['text::email', 'select::degree']);
  const reordered = stableFormSignature(['select::degree', 'text::email']);
  const changed = stableFormSignature(['text::email', 'select::degree-v2']);

  assert.equal(first, reordered);
  assert.notEqual(first, changed);
});

test('buildApiRequest attaches the paired bearer token without accepting caller auth headers', () => {
  const request = buildApiRequest('/api/profile', { method: 'PUT', headers: { Authorization: 'Bearer bad' } }, 'paired-token');

  assert.equal(request.headers.Authorization, 'Bearer paired-token');
  assert.equal(request.headers['Content-Type'], 'application/json');
});

test('manifest delegates requests to a service worker and injects every accessible frame', async () => {
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url)));
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.equal(manifest.content_scripts[0].all_frames, true);
  assert.equal(manifest.content_scripts[0].match_about_blank, true);
  assert.equal(manifest.side_panel.default_path, 'sidepanel.html');
});

test('page-facing scripts never fetch the local profile service directly', async () => {
  const [content, popup] = await Promise.all([
    readFile(new URL('../extension/content.js', import.meta.url), 'utf8'),
    readFile(new URL('../extension/popup.js', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(content, /fetch\s*\(/);
  assert.doesNotMatch(popup, /fetch\s*\(/);
  assert.match(content, /JOB_AUTOFILL_API/);
  assert.match(popup, /JOB_AUTOFILL_API/);
});
