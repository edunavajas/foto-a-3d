import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { createApp } from '../src/server.js';

const servers = [];
const temporaryDirs = [];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=', 'base64');

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
  await Promise.all(temporaryDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function start(generate) {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'foto-a-3d-test-'));
  temporaryDirs.push(outputDir);
  const server = createApp({ outputDir, generate }).listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise(resolve => server.once('listening', resolve));
  return { outputDir, url: `http://127.0.0.1:${server.address().port}` };
}

function photoForm(data = png, filename = 'photo.png') {
  const form = new FormData();
  form.append('photo', new Blob([data], { type: 'image/png' }), filename);
  return form;
}

async function waitForJob(url, id, target) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(`${url}/api/jobs/${id}`);
    const job = await response.json();
    if (job.status === target) return job;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Job did not reach ${target}`);
}

test('serves the mobile page and accepts a photo without contacting Tripo', async () => {
  let receivedPhoto;
  const { outputDir, url } = await start(async ({ photoPath, workDir }) => {
    receivedPhoto = await fs.readFile(photoPath);
    await fs.mkdir(workDir, { recursive: true });
    const modelPath = path.join(workDir, 'model.glb');
    await fs.writeFile(modelPath, Buffer.from('glTF-test'));
    return { modelPath };
  });
  const page = await fetch(url);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /accept="image\/\*" capture="environment"/);

  const response = await fetch(`${url}/api/jobs`, { method: 'POST', body: photoForm() });
  assert.equal(response.status, 202);
  const { id } = await response.json();
  const job = await waitForJob(url, id, 'ready');
  assert.deepEqual(receivedPhoto, png);
  assert.equal(job.modelUrl, `/api/jobs/${id}/model`);
  assert.deepEqual(await fs.readFile(path.join(outputDir, 'models', `${id}.glb`)), Buffer.from('glTF-test'));
  const model = await fetch(`${url}${job.modelUrl}`);
  assert.equal(model.status, 200);
  assert.match(model.headers.get('content-type'), /model\/gltf-binary/);
  assert.equal(await model.text(), 'glTF-test');
});

test('rejects unsupported files and cross-origin requests', async () => {
  const { url } = await start(async () => assert.fail('Generation must not run'));
  const badFile = await fetch(`${url}/api/jobs`, { method: 'POST', body: photoForm(Buffer.from('not an image')) });
  assert.equal(badFile.status, 415);
  const crossOrigin = await fetch(`${url}/api/jobs`, {
    method: 'POST', body: photoForm(), headers: { origin: 'http://untrusted.example' }
  });
  assert.equal(crossOrigin.status, 403);
});

test('allows only one credit-consuming job at a time and exposes a safe failure', async () => {
  let finish;
  const { url } = await start(() => new Promise((resolve, reject) => { finish = reject; }));
  const first = await fetch(`${url}/api/jobs`, { method: 'POST', body: photoForm() });
  const { id } = await first.json();
  const second = await fetch(`${url}/api/jobs`, { method: 'POST', body: photoForm() });
  assert.equal(second.status, 409);
  finish(new Error('Tripo failed'));
  const job = await waitForJob(url, id, 'error');
  assert.equal(job.error, 'Tripo failed');
  const model = await fetch(`${url}/api/jobs/${id}/model`);
  assert.equal(model.status, 404);
});
