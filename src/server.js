import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { generateModel } from './tripo.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.join(root, 'output');
const maxPhotoBytes = 15 * 1024 * 1024;

function imageExtension(buffer) {
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return '.jpg';
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return '.png';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  if (buffer.toString('ascii', 0, 2) === 'BM') return '.bmp';
  return null;
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
  app.use(express.static(path.join(root, 'public'), { index: 'index.html' }));
  app.use('/vendor', express.static(path.join(root, 'node_modules/@google/model-viewer/dist')));

  app.post('/api/jobs', upload.single('photo'), async (req, res, next) => {
    try {
      if (active) return res.status(409).json({ error: 'A model is already being generated.' });
      if (!req.file) return res.status(400).json({ error: 'Choose a photo first.' });
      const extension = imageExtension(req.file.buffer);
      if (!extension) return res.status(415).json({ error: 'Use a JPEG, PNG, WebP, or BMP image.' });

      active = true;
      const id = crypto.randomUUID();
      const job = { id, status: 'generating', error: null, modelUrl: null, modelVersion: 0, improving: req.body.quality === 'best' };
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
          const { modelPath } = await generate({ photoPath, workDir, cwd: root });
          await publish(modelPath, `${id}.glb`);
          job.modelVersion = 1;
          job.modelUrl = `/api/jobs/${id}/model`;
          job.status = 'ready';
          if (job.improving) {
            job.status = 'improving';
            try {
              const refined = await generate({ photoPath, workDir, cwd: root, model: 'tripo-v3.1' });
              await publish(refined.modelPath, `${id}-hq.glb`);
              job.modelVersion = 2;
              job.modelUrl = `/api/jobs/${id}/model?variant=hq`;
            } catch {
              // The fast model is already delivered; the upgrade is a bonus, not a failure.
            }
            job.status = 'ready';
          }
        } catch (error) {
          job.status = 'error';
          job.error = error?.message || 'Model generation failed.';
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
    if (!job || (job.status !== 'ready' && job.status !== 'improving')) return res.sendStatus(404);
    const name = req.query.variant === 'hq' && job.modelVersion === 2 ? `${job.id}-hq.glb` : `${job.id}.glb`;
    res.type('model/gltf-binary');
    res.sendFile(path.join(modelsDir, name));
  });

  app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
      return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: 'The photo is too large or the upload is invalid.' });
    }
    res.status(500).json({ error: 'The server could not save this photo.' });
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
