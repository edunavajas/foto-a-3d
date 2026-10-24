import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { createProgressTracker, generateModel, TripoError } from '../src/tripo.js';

const temporaryDirs = [];
afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

/** Fake tripo CLI: logs invocations, validates dry-runs, and can emit stderr progress lines. */
async function writeFakeCli(dir, { progress = false } = {}) {
  const fakeCli = path.join(dir, 'tripo');
  const invocationLog = path.join(dir, 'invocations.txt');
  await fs.writeFile(fakeCli, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
fs.appendFileSync(${JSON.stringify(invocationLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.env.TRIPO_API_KEY) process.exit(1);
const args = process.argv.slice(2);
if (args.includes('--dry-run')) {
  console.log(JSON.stringify({valid: true, errors: []}));
} else {
  ${progress ? `process.stderr.write('image_to_model · running 37% · abc123ab\\n');
  process.stderr.write('animate_rig · running 80% · def456cd\\n');` : ''}
  const folder = path.join(args[args.indexOf('--out') + 1], 'result');
  fs.mkdirSync(folder, {recursive: true});
  const model = path.join(folder, 'model.glb');
  fs.writeFileSync(model, 'glTF');
  console.log(JSON.stringify({status: 'success', task_id: 'task-test', model_file: model}));
}
`, { mode: 0o755 });
  return { fakeCli, invocationLog };
}

async function readInvocations(invocationLog) {
  return (await fs.readFile(invocationLog, 'utf8')).trim().split('\n').map(JSON.parse);
}

test('validates with dry-run and reads the final CLI JSON without credits', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foto-a-3d-cli-test-'));
  temporaryDirs.push(dir);
  const { fakeCli, invocationLog } = await writeFakeCli(dir);
  const photoPath = path.join(dir, 'photo.png');
  await fs.writeFile(photoPath, 'photo');
  process.env.TRIPO_API_KEY = 'must-not-reach-child';
  try {
    const result = await generateModel({ photoPath, workDir: path.join(dir, 'work'), binary: fakeCli, cwd: dir });
    assert.equal(result.taskId, 'task-test');
    assert.equal(path.basename(result.modelPath), 'model.glb');
  } finally {
    delete process.env.TRIPO_API_KEY;
  }
  const calls = await readInvocations(invocationLog);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].slice(0, 2), ['make', photoPath]);
  assert.ok(calls[0].includes('--dry-run'));
  assert.ok(calls[0].includes('--json'));
  assert.ok(calls[1].includes('--out'));
  assert.ok(!calls[1].includes('--dry-run'));
});

test('maps CLI authentication errors without exposing stderr', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foto-a-3d-cli-test-'));
  temporaryDirs.push(dir);
  const fakeCli = path.join(dir, 'tripo');
  await fs.writeFile(fakeCli, '#!/bin/sh\necho private-data >&2\nexit 3\n', { mode: 0o755 });
  await assert.rejects(
    generateModel({ photoPath: path.join(dir, 'photo.png'), workDir: path.join(dir, 'work'), binary: fakeCli, cwd: dir }),
    error => error instanceof TripoError && error.exitCode === 3 && !error.message.includes('private-data')
  );
});

test('passes texture-off and rig flags and reports stderr progress events', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foto-a-3d-cli-test-'));
  temporaryDirs.push(dir);
  const { fakeCli, invocationLog } = await writeFakeCli(dir, { progress: true });
  const photoPath = path.join(dir, 'photo.png');
  await fs.writeFile(photoPath, 'photo');
  const events = [];
  await generateModel({
    photoPath, workDir: path.join(dir, 'work'), binary: fakeCli, cwd: dir,
    texture: 'off', rig: true, onProgress: event => events.push(event)
  });
  assert.deepEqual(events, [
    { phase: 'image_to_model', pct: 37, taskId8: 'abc123ab' },
    { phase: 'animate_rig', pct: 80, taskId8: 'def456cd' }
  ]);
  const [dryRun, real] = await readInvocations(invocationLog);
  assert.deepEqual(dryRun.slice(2, 9), ['--model', 'tripo-p1', '--param', 'texture=false', '--param', 'pbr=false', '--then']);
  assert.equal(real[9], 'rig');
  assert.deepEqual(real.slice(2, 8), ['--model', 'tripo-p1', '--param', 'texture=false', '--param', 'pbr=false']);
  assert.ok(real.includes('--dry-run') === false);
});

test('texture-on sends pbr and quality params and skips the rig by default', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foto-a-3d-cli-test-'));
  temporaryDirs.push(dir);
  const { fakeCli, invocationLog } = await writeFakeCli(dir);
  const photoPath = path.join(dir, 'photo.png');
  await fs.writeFile(photoPath, 'photo');
  await generateModel({ photoPath, workDir: path.join(dir, 'work'), binary: fakeCli, cwd: dir, texture: 'on' });
  const [dryRun, real] = await readInvocations(invocationLog);
  for (const call of [dryRun, real]) {
    assert.deepEqual(call.slice(2, 8), ['--model', 'tripo-p1', '--param', 'pbr=true', '--param', 'texture_quality=standard']);
    assert.equal(call.includes('--then'), false);
  }
});

test('accepts a finished task id as input to chain the rig on it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foto-a-3d-cli-test-'));
  temporaryDirs.push(dir);
  const { fakeCli, invocationLog } = await writeFakeCli(dir);
  await generateModel({ input: 'task-hq', workDir: path.join(dir, 'work'), binary: fakeCli, cwd: dir, model: null, rig: true });
  const [dryRun, real] = await readInvocations(invocationLog);
  assert.equal(dryRun[1], 'task-hq');
  assert.equal(dryRun.includes('--model'), false);
  assert.deepEqual(real.slice(2, 4), ['--then', 'rig']);
});

test('progress tracker is monotonic per task and resets when the task changes', () => {
  const track = createProgressTracker();
  assert.equal(track({ pct: 50, taskId8: 'aa11aa11' }), 50);
  assert.equal(track({ pct: 30, taskId8: 'aa11aa11' }), 50);
  assert.equal(track({ pct: 120, taskId8: 'aa11aa11' }), 100);
  assert.equal(track({ pct: 5, taskId8: 'bb22bb22' }), 5);
  assert.equal(track({ pct: null, taskId8: 'bb22bb22' }), 5);
});
