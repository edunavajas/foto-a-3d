import { spawn } from 'node:child_process';
import path from 'node:path';

const EXIT_MESSAGES = {
  1: 'Tripo encountered an internal error.',
  2: 'Tripo rejected the image or command parameters.',
  3: 'Tripo is not authenticated. Run tripo login on this computer.',
  4: 'Tripo credits are insufficient.',
  5: 'Tripo rejected the image under its content policy.',
  6: 'Tripo could not complete the model task.',
  7: 'Tripo could not reach its service. Check the network and task history before retrying.',
  8: 'Tripo could not find a required resource.',
  9: 'Tripo is rate-limiting requests. Try again later.'
};

export class TripoError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.name = 'TripoError';
    this.exitCode = exitCode;
  }
}

function runCommand(args, { binary, cwd }) {
  return new Promise((resolve, reject) => {
    // Browser login is the supported authentication path. Do not pass an
    // inherited API key to the child, and never print CLI stderr or stdout.
    const { TRIPO_API_KEY: _ignored, ...env } = process.env;
    const child = spawn(binary, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let overflow = false;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > 1024 * 1024) {
        overflow = true;
        child.kill();
      }
    });
    child.stderr.resume();
    child.on('error', error => {
      reject(new TripoError(error.code === 'ENOENT'
        ? 'Tripo CLI was not found. Install it with npm install -g tripo-cli.'
        : 'Tripo CLI could not be started.'));
    });
    child.on('close', code => {
      if (overflow) {
        reject(new TripoError('Tripo produced an unexpectedly large result.'));
      } else if (code !== 0) {
        reject(new TripoError(EXIT_MESSAGES[code] || 'Tripo did not finish successfully.', code));
      } else {
        const line = stdout.trim().split(/\r?\n/).at(-1);
        try {
          resolve(JSON.parse(line));
        } catch {
          reject(new TripoError('Tripo returned invalid JSON.'));
        }
      }
    });
  });
}

export async function generateModel({ photoPath, workDir, binary = 'tripo', cwd = process.cwd() }) {
  const args = ['make', photoPath, '--json', '--yes', '--no-open', '--out', workDir];
  const plan = await runCommand([...args, '--dry-run'], { binary, cwd });
  if (plan.valid !== true || plan.errors?.length) {
    throw new TripoError('Tripo rejected the generation plan.', 2);
  }

  const result = await runCommand(args, { binary, cwd });
  if (result.status !== 'success' || typeof result.model_file !== 'string') {
    throw new TripoError('Tripo finished without a usable model file.');
  }
  const modelPath = path.resolve(cwd, result.model_file);
  if (path.extname(modelPath).toLowerCase() !== '.glb') {
    throw new TripoError('Tripo returned a model that is not a GLB file.');
  }
  const relative = path.relative(workDir, modelPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new TripoError('Tripo returned a model outside its output folder.');
  }
  return { modelPath, taskId: result.task_id };
}
