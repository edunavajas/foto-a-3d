import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { generateModel, TripoError } from '../src/tripo.js';

const temporaryDirs = [];
afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

test('validates with dry-run and reads the final CLI JSON without credits', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foto-a-3d-cli-test-'));
  temporaryDirs.push(dir);
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
  const folder = path.join(args[args.indexOf('--out') + 1], 'result');
  fs.mkdirSync(folder, {recursive: true});
  const model = path.join(folder, 'model.glb');
  fs.writeFileSync(model, 'glTF');
  console.log(JSON.stringify({status: 'success', task_id: 'task-test', model_file: model}));
}
`, { mode: 0o755 });
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
  const calls = (await fs.readFile(invocationLog, 'utf8')).trim().split('\n').map(JSON.parse);
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
