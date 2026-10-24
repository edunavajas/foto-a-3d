import { spawn } from 'node:child_process';
import path from 'node:path';

const EXIT_MESSAGES = {
  1: 'Tripo sufrió un error interno.',
  2: 'Tripo rechazó la imagen o los parámetros.',
  3: 'Tripo no está autenticado. Ejecuta tripo login en este ordenador.',
  4: 'Los créditos de Tripo son insuficientes.',
  5: 'Tripo rechazó la imagen por su política de contenido.',
  6: 'Tripo no pudo completar la tarea del modelo.',
  7: 'Tripo no pudo contactar con su servicio. Comprueba la red y el historial de tareas antes de reintentar.',
  8: 'Tripo no encontró un recurso necesario.',
  9: 'Tripo está limitando las peticiones. Inténtalo más tarde.'
};

export class TripoError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.name = 'TripoError';
    this.exitCode = exitCode;
  }
}

/** Headless stderr progress line: `image_to_model · running 45% · 7fde49b4`. */
const PROGRESS_LINE = /([a-z_]+)\s+·\s+(\w+)(?:\s+(\d+)%)?\s+·\s+([a-f0-9]{8})/;

/** CLI flags for the Texturas switch; omitted entirely when unspecified (CLI defaults). */
function textureParams(texture) {
  if (texture === 'off') return ['--param', 'texture=false', '--param', 'pbr=false'];
  if (texture === 'on') return ['--param', 'pbr=true', '--param', 'texture_quality=standard'];
  return [];
}

function runCommand(args, { binary, cwd, onProgress }) {
  return new Promise((resolve, reject) => {
    // Browser login is the supported authentication path. Do not pass an
    // inherited API key to the child, and never print CLI stderr or stdout.
    const { TRIPO_API_KEY: _ignored, ...env } = process.env;
    const child = spawn(binary, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let overflow = false;
    let stderrBuffer = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > 1024 * 1024) {
        overflow = true;
        child.kill();
      }
    });
    // Capture stderr to extract throttled progress lines; the content is never logged.
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      stderrBuffer += chunk;
      const lines = stderrBuffer.split('\n');
      stderrBuffer = lines.pop();
      for (const line of lines) {
        const match = PROGRESS_LINE.exec(line);
        if (match) onProgress?.({ phase: match[1], pct: match[3] ? Number(match[3]) : null, taskId8: match[4] });
      }
    });
    child.on('error', error => {
      reject(new TripoError(error.code === 'ENOENT'
        ? 'Tripo CLI no se encontró. Instálalo con npm install -g tripo-cli.'
        : 'Tripo CLI no pudo iniciarse.'));
    });
    child.on('close', code => {
      if (overflow) {
        reject(new TripoError('Tripo produjo un resultado inesperadamente grande.'));
      } else if (code !== 0) {
        reject(new TripoError(EXIT_MESSAGES[code] || 'Tripo no terminó correctamente.', code));
      } else {
        const line = stdout.trim().split(/\r?\n/).at(-1);
        try {
          resolve(JSON.parse(line));
        } catch {
          reject(new TripoError('Tripo devolvió un JSON no válido.'));
        }
      }
    });
  });
}

/**
 * Monotonic 0-100 progress for one job field. A new task id on stderr means a
 * new task started (e.g. the chained rig), so the value resets instead of
 * mixing percentages from different tasks.
 */
export function createProgressTracker() {
  let taskKey = null;
  let value = 0;
  return ({ pct, taskId8 }) => {
    if (taskId8 !== taskKey) {
      taskKey = taskId8;
      value = 0;
    }
    if (Number.isFinite(pct)) value = Math.max(value, Math.min(100, Math.max(0, pct)));
    return value;
  };
}

export async function generateModel({ photoPath, input, workDir, binary = 'tripo', cwd = process.cwd(), model = 'tripo-p1', texture, rig, onProgress }) {
  // tripo-p1: low-poly, mesh in seconds and cheaper credits; v3.1 is high fidelity but slow.
  // `input` may be a finished task id: the CLI natively chains steps from it (used to rig
  // a generated model; pass model: null then, a rig-only run takes no --model).
  // `--then rig` runs the auto-rig inside the same make call.
  const args = [
    'make', input ?? photoPath,
    ...(model ? ['--model', model] : []),
    ...textureParams(texture),
    ...(rig ? ['--then', 'rig'] : []),
    '--json', '--yes', '--no-open', '--out', workDir
  ];
  const plan = await runCommand([...args, '--dry-run'], { binary, cwd, onProgress });
  if (plan.valid !== true || plan.errors?.length) {
    throw new TripoError('Tripo rechazó el plan de generación.', 2);
  }

  const result = await runCommand(args, { binary, cwd, onProgress });
  if (result.status !== 'success' || typeof result.model_file !== 'string') {
    throw new TripoError('Tripo terminó sin un archivo de modelo utilizable.');
  }
  const modelPath = path.resolve(cwd, result.model_file);
  if (path.extname(modelPath).toLowerCase() !== '.glb') {
    throw new TripoError('Tripo devolvió un modelo que no es un archivo GLB.');
  }
  const relative = path.relative(workDir, modelPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new TripoError('Tripo devolvió un modelo fuera de su carpeta de salida.');
  }
  return { modelPath, taskId: result.task_id };
}
