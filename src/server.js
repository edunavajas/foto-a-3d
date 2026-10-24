import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { createProgressTracker, generateModel } from './tripo.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.join(root, 'output');
const distDir = path.join(root, 'dist');
const maxPhotoBytes = 20 * 1024 * 1024;

function imageExtension(buffer) {
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return '.jpg';
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return '.png';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  if (buffer.toString('ascii', 0, 2) === 'BM') return '.bmp';
  return null;
}

/**
 * Builds an onProgress handler for one generate stage: monotonic per-task
 * progress (reset when the CLI starts a new task) written to the job field the
 * UI reads for that stage. Only the first make call may chain the rig inside a
 * single invocation, so its rig sub-task (new taskId8, animate_rig phase)
 * routes to rigProgress and flips the job into the rigging status.
 */
function stageHandler(job, field) {
  const track = createProgressTracker();
  const trackRig = createProgressTracker();
  return ({ phase, pct, taskId8 }) => {
    if (field === 'progress' && phase === 'animate_rig') {
      job.rigProgress = trackRig({ pct, taskId8 });
      job.status = job.phase = 'rigging';
      return;
    }
    job[field] = track({ pct, taskId8 });
  };
}

export function createApp({ outputDir = outputRoot, generate = generateModel } = {}) {
  const app = express();
  const jobs = new Map();
  const photosDir = path.join(outputDir, 'photos');
  const workRoot = path.join(outputDir, '.work');
  const modelsDir = path.join(outputDir, 'models');
  let active = false;
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxPhotoBytes, files: 1 } });

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin) {
      try {
        if (new URL(origin).host !== req.get('host')) return res.sendStatus(403);
      } catch {
        return res.sendStatus(403);
      }
    }
    next();
  });
  app.use(express.static(distDir, { index: 'index.html' }));

  app.post('/api/jobs', upload.single('photo'), async (req, res, next) => {
    try {
      if (active) return res.status(409).json({ error: 'Ya se está generando un modelo.' });
      if (!req.file) return res.status(400).json({ error: 'Elige primero una foto.' });
      const extension = imageExtension(req.file.buffer);
      if (!extension) return res.status(415).json({ error: 'Usa una imagen JPEG, PNG, WebP o BMP.' });

      const quality = req.body.quality === 'best' ? 'best' : 'fast';
      const texture = req.body.texture === 'off' ? 'off' : 'on';
      const rig = req.body.rig === 'on';

      active = true;
      const id = crypto.randomUUID();
      const job = {
        id,
        status: 'generating',
        phase: 'generating',
        error: null,
        modelUrl: null,
        modelVersion: 0,
        improving: quality === 'best',
        quality,
        texture,
        hasRig: false,
        hasHq: false,
        progress: 0,
        hqProgress: null,
        rigProgress: null,
        riggedModelUrl: null
      };
      jobs.set(id, job);
      await Promise.all([fs.mkdir(photosDir, { recursive: true }), fs.mkdir(workRoot, { recursive: true }), fs.mkdir(modelsDir, { recursive: true })]);
      const photoPath = path.join(photosDir, `${id}${extension}`);
      const workDir = path.join(workRoot, id);
      await fs.writeFile(photoPath, req.file.buffer, { flag: 'wx' });
      res.status(202).json({ id, status: job.status });

      const publish = async (modelPath, name) => {
        const finalPath = path.join(modelsDir, name);
        const partialPath = `${finalPath}.part`;
        await fs.copyFile(modelPath, partialPath);
        await fs.rename(partialPath, finalPath);
      };

      void (async () => {
        try {
          // quality fast + rig: one make call chains the auto-rig; its model_file is the rigged GLB.
          const fast = await generate({
            photoPath, workDir, cwd: root, model: 'tripo-p1', texture, rig: rig && quality === 'fast',
            onProgress: stageHandler(job, 'progress')
          });
          await publish(fast.modelPath, `${id}.glb`);
          job.modelVersion = 1;
          job.modelUrl = `/api/jobs/${id}/model`;
          if (rig && quality === 'fast') job.hasRig = true;
          job.status = 'ready';
          if (quality === 'best') {
            job.status = 'improving';
            job.phase = 'improving';
            // Rig the final model, so the rig source falls back to the fast task if the HQ step fails.
            let rigSource = fast.taskId;
            let riggedSuffix = '-rigged';
            try {
              const refined = await generate({
                photoPath, workDir, cwd: root, model: 'tripo-v3.1', texture,
                onProgress: stageHandler(job, 'hqProgress')
              });
              await publish(refined.modelPath, `${id}-hq.glb`);
              rigSource = refined.taskId;
              riggedSuffix = '-hq-rigged';
              job.modelVersion = 2;
              job.modelUrl = `/api/jobs/${id}/model?variant=hq`;
              job.hasHq = true;
            } catch {
              // The fast model is already delivered; the upgrade is a bonus, not a failure.
            }
            if (rig) {
              job.status = 'rigging';
              job.phase = 'rigging';
              try {
                const rigged = await generate({
                  input: rigSource, workDir, cwd: root, model: null, rig: true,
                  onProgress: stageHandler(job, 'rigProgress')
                });
                const riggedName = `${id}${riggedSuffix}.glb`;
                await publish(rigged.modelPath, riggedName);
                job.riggedFile = riggedName;
                job.hasRig = true;
                job.modelVersion = 3;
                job.modelUrl = `/api/jobs/${id}/model?variant=rigged`;
                job.riggedModelUrl = job.modelUrl;
              } catch {
                // The textured model is already delivered; the skeleton is a bonus.
              }
            }
            job.status = 'ready';
          }
        } catch (error) {
          job.status = 'error';
          job.error = error?.message || 'No se pudo generar el modelo.';
        } finally {
          await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
          active = false;
        }
      })();
    } catch (error) {
      active = false;
      next(error);
    }
  });

  app.get('/api/jobs/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.sendStatus(404);
    res.json(job);
  });

  app.get('/api/jobs/:id/model', (req, res) => {
    const job = jobs.get(req.params.id);
    const serving = job && (job.status === 'ready' || job.status === 'improving' || job.status === 'rigging');
    if (!serving) return res.sendStatus(404);
    const name = req.query.variant === 'rigged' && job.riggedFile ? job.riggedFile
      : req.query.variant === 'hq' && job.modelVersion === 2 ? `${job.id}-hq.glb`
        : `${job.id}.glb`;
    res.type('model/gltf-binary');
    res.sendFile(path.join(modelsDir, name));
  });

  // SPA fallback: every non-API GET serves the app shell (client-side routes, refreshes).
  const indexHtml = path.join(distDir, 'index.html');
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
    res.sendFile(indexHtml, error => {
      if (error) res.sendStatus(404);
    });
  });

  app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
      return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: 'La foto es demasiado grande o la subida no es válida.' });
    }
    res.status(500).json({ error: 'El servidor no pudo guardar esta foto.' });
  });
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const app = createApp();
  const server = app.listen(port, '0.0.0.0', error => {
    if (error) {
      process.stderr.write(`Could not start Foto a 3D: ${error.code || 'listen error'}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`Foto a 3D: http://localhost:${server.address().port}\nModels for Blender: ${path.join(outputRoot, 'models')}\n`);
  });
}
