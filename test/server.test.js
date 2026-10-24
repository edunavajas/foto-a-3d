import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
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
  return { outputDir, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` };
}

function photoForm(data = png, filename = 'photo.png') {
  const form = new FormData();
  form.append('photo', new Blob([data], { type: 'image/png' }), filename);
  return form;
}

async function waitFor(url, id, predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(`${url}/api/jobs/${id}`);
    const job = await response.json();
    if (predicate(job)) return job;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Job did not reach the expected state');
}

const waitForJob = (url, id, target) => waitFor(url, id, job => job.status === target);

/** Fake generate body: writes a distinct GLB numbered by call order. */
async function fakeModel(workDir, index) {
  await fs.mkdir(workDir, { recursive: true });
  const modelPath = path.join(workDir, `model-${index}.glb`);
  await fs.writeFile(modelPath, Buffer.from(`glTF-${index}`));
  return { modelPath, taskId: `task-${index}` };
}

test('serves the SPA shell and accepts a photo without contacting Tripo', async () => {
  let receivedPhoto;
  const { outputDir, url } = await start(async options => {
    receivedPhoto = await fs.readFile(options.photoPath);
    return fakeModel(options.workDir, 1);
  });
  const page = await fetch(url);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /<div id="root">/);
  // SPA fallback: client-side routes and refreshes serve the same shell.
  const deep = await fetch(`${url}/vista/inexistente`);
  assert.equal(deep.status, 200);
  assert.match(await deep.text(), /<div id="root">/);

  const response = await fetch(`${url}/api/jobs`, { method: 'POST', body: photoForm() });
  assert.equal(response.status, 202);
  const { id } = await response.json();
  const job = await waitForJob(url, id, 'ready');
  assert.deepEqual(receivedPhoto, png);
  assert.equal(job.modelUrl, `/api/jobs/${id}/model`);
  assert.deepEqual(await fs.readFile(path.join(outputDir, 'models', `${id}.glb`)), Buffer.from('glTF-1'));
  const model = await fetch(`${url}${job.modelUrl}`);
  assert.equal(model.status, 200);
  assert.match(model.headers.get('content-type'), /model\/gltf-binary/);
  assert.equal(await model.text(), 'glTF-1');
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

test('fast job with rig chains the CLI rig and exposes real progress phases', async () => {
  let release;
  let received;
  const { url } = await start(async ({ model, texture, rig, onProgress, workDir }) => {
    received = { model, texture, rig };
    onProgress({ phase: 'image_to_model', pct: 37, taskId8: 'abc123ab' });
    onProgress({ phase: 'animate_rig', pct: 80, taskId8: 'abc123ab' });
    await new Promise(resolve => { release = resolve; });
    return fakeModel(workDir, 1);
  });
  const form = photoForm();
  form.append('quality', 'fast');
  form.append('texture', 'off');
  form.append('rig', 'on');
  const response = await fetch(`${url}/api/jobs`, { method: 'POST', body: form });
  assert.equal(response.status, 202);
  const { id } = await response.json();

  const rigging = await waitForJob(url, id, 'rigging');
  assert.equal(rigging.phase, 'rigging');
  assert.equal(rigging.rigProgress, 80);
  assert.equal(rigging.progress, 37);
  assert.equal(received.texture, 'off');
  assert.equal(received.rig, true);

  release();
  const job = await waitForJob(url, id, 'ready');
  assert.equal(job.hasRig, true);
  assert.equal(job.modelUrl, `/api/jobs/${id}/model`);
  assert.equal(received.model, 'tripo-p1');
});

test('best quality with rig publishes fast, hq and rigged models in sequence', async () => {
  const calls = [];
  const { outputDir, url } = await start(async ({ model, input, rig, workDir }) => {
    calls.push({ model, input, rig: Boolean(rig) });
    return fakeModel(workDir, calls.length);
  });
  const form = photoForm();
  form.append('quality', 'best');
  form.append('texture', 'on');
  form.append('rig', 'on');
  const response = await fetch(`${url}/api/jobs`, { method: 'POST', body: form });
  const { id } = await response.json();
  const job = await waitForJob(url, id, 'ready');

  // One publish per artifact: fast, hq and rigged (each is one Blender import).
  assert.deepEqual(calls, [
    { model: 'tripo-p1', input: undefined, rig: false },
    { model: 'tripo-v3.1', input: undefined, rig: false },
    { model: null, input: 'task-2', rig: true }
  ]);
  const models = (await fs.readdir(path.join(outputDir, 'models'))).sort();
  assert.deepEqual(models, [`${id}-hq-rigged.glb`, `${id}-hq.glb`, `${id}.glb`]);
  assert.equal(job.hasHq, true);
  assert.equal(job.hasRig, true);
  assert.equal(job.improving, true);
  assert.equal(job.quality, 'best');
  assert.equal(job.modelVersion, 3);
  assert.equal(job.modelUrl, `/api/jobs/${id}/model?variant=rigged`);
  assert.equal(job.riggedModelUrl, `/api/jobs/${id}/model?variant=rigged`);
  const rigged = await fetch(`${url}/api/jobs/${id}/model?variant=rigged`);
  assert.equal(await rigged.text(), 'glTF-3');
});

test('best quality without rig keeps the two-stage fast then hq flow', async () => {
  const calls = [];
  const { outputDir, url } = await start(async ({ model, rig, workDir }) => {
    calls.push({ model, rig: Boolean(rig) });
    return fakeModel(workDir, calls.length);
  });
  const form = photoForm();
  form.append('quality', 'best');
  const response = await fetch(`${url}/api/jobs`, { method: 'POST', body: form });
  const { id } = await response.json();
  const job = await waitForJob(url, id, 'ready');

  assert.deepEqual(calls, [
    { model: 'tripo-p1', rig: false },
    { model: 'tripo-v3.1', rig: false }
  ]);
  const models = (await fs.readdir(path.join(outputDir, 'models'))).sort();
  assert.deepEqual(models, [`${id}-hq.glb`, `${id}.glb`]);
  assert.equal(job.hasHq, true);
  assert.equal(job.hasRig, false);
  assert.equal(job.modelVersion, 2);
  assert.equal(job.modelUrl, `/api/jobs/${id}/model?variant=hq`);
});

test('reports a startup error instead of announcing a busy port as ready', async () => {
  const { port } = await start(async () => {});
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise(resolve => child.once('exit', resolve));
  assert.equal(code, 1);
  assert.doesNotMatch(stdout, /Foto a 3D:/);
  assert.match(stderr, /EADDRINUSE/);
});
