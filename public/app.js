const input = document.querySelector('#photo');
const status = document.querySelector('#status');
const preview = document.querySelector('#preview');
const scan = document.querySelector('#scan');
const scanContext = scan.getContext('2d');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function readJson(response) {
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error('The server returned an unexpected response.');
  }
  if (!response.ok) throw new Error(body.error || 'The request failed.');
  return body;
}

let scanDots = [];
let scanFrame = null;
let scanStart = 0;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Turn the photo into a point cloud: pixel colour and brightness become dot
// colour and depth, so the animation hints at the object being generated.
function sampleDots(photo) {
  const image = new Image();
  return new Promise(resolve => {
    image.onload = () => {
      const side = 80;
      const sample = Object.assign(document.createElement('canvas'), { width: side, height: side });
      const context = sample.getContext('2d', { willReadFrequently: true });
      const ratio = Math.min(side / image.width, side / image.height);
      const width = image.width * ratio;
      const height = image.height * ratio;
      context.drawImage(image, (side - width) / 2, (side - height) / 2, width, height);
      const { data } = context.getImageData(0, 0, side, side);
      const dots = [];
      for (let y = 0; y < side; y += 2) {
        for (let x = 0; x < side; x += 2) {
          const i = (y * side + x) * 4;
          if (data[i + 3] < 128) continue;
          // Scatter on a spherical shell so the start reads as a cloud, not noise.
          const theta = Math.random() * Math.PI * 2;
          const phi = Math.acos(Math.random() * 2 - 1);
          const radius = .9 + Math.random() * .4;
          dots.push({
            tx: (x / (side - 1)) * 2 - 1,
            ty: (y / (side - 1)) * 2 - 1,
            tz: (data[i] + data[i + 1] + data[i + 2]) / 765 - .5,
            color: `rgb(${data[i]},${data[i + 1]},${data[i + 2]})`,
            sx: radius * Math.sin(phi) * Math.cos(theta),
            sy: radius * Math.sin(phi) * Math.sin(theta),
            sz: radius * Math.cos(phi)
          });
        }
      }
      resolve(dots);
    };
    image.onerror = () => resolve([]);
    image.src = URL.createObjectURL(photo);
  });
}

const ease = t => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function drawScan(now) {
  const context = scanContext;
  const width = scan.width;
  const height = scan.height;
  context.clearRect(0, 0, width, height);
  if (!scanDots.length) return;

  const elapsed = now - scanStart;
  const angle = (elapsed / 1000) * .5;
  // Dots fly in from the cloud for ~2s, then hold the silhouette and keep spinning.
  const mix = ease(Math.min(1, elapsed / 2000));
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  for (const dot of scanDots) {
    const x = dot.sx + (dot.tx - dot.sx) * mix;
    const y = dot.sy + (dot.ty - dot.sy) * mix;
    const z = dot.sz + (dot.tz - dot.sz) * mix;
    const rx = x * cos - z * sin;
    const rz = x * sin + z * cos;
    const scale = 3 / (3 + rz);
    const size = 3 * scale;
    context.globalAlpha = .3 + mix * .6;
    context.fillStyle = dot.color;
    context.fillRect(
      width / 2 + rx * width * .32 * scale - size / 2,
      height / 2 + y * width * .32 * scale - size / 2,
      size,
      size
    );
  }
  context.globalAlpha = 1;
}

function tickFrame(now) {
  drawScan(now);
  scanFrame = requestAnimationFrame(tickFrame);
}

function startScan() {
  if (scanFrame !== null || !input.disabled) return;
  scan.hidden = false;
  scanStart = performance.now();
  if (reducedMotion) {
    drawScan(scanStart + 2000);
    return;
  }
  scanFrame = requestAnimationFrame(tickFrame);
}

function stopScan() {
  if (scanFrame !== null) cancelAnimationFrame(scanFrame);
  scanFrame = null;
  scan.hidden = true;
}

async function upload(photo) {
  input.disabled = true;
  preview.hidden = true;
  preview.removeAttribute('src');
  status.textContent = 'Uploading photo…';

  try {
    const form = new FormData();
    form.append('photo', photo);
    form.append('quality', document.querySelector('input[name="quality"]:checked')?.value || 'fast');
    const created = await readJson(await fetch('/api/jobs', { method: 'POST', body: form }));
    status.textContent = 'Generating model…';

    while (true) {
      const job = await readJson(await fetch(`/api/jobs/${encodeURIComponent(created.id)}`, { cache: 'no-store' }));
      if (job.status === 'ready' || job.status === 'improving') {
        const url = `${job.modelUrl}${job.modelUrl.includes('?') ? '&' : '?'}v=${job.modelVersion}`;
        if (preview.getAttribute('src') !== url) {
          preview.src = url;
          preview.hidden = false;
          stopScan();
        }
        status.textContent = job.status === 'improving' ? 'Improving quality…' : 'Model ready. Drag to rotate it.';
        if (job.status === 'ready') return;
      }
      if (job.status === 'error') throw new Error(job.error || 'Model generation failed.');
      await pause(2000);
    }
  } catch (error) {
    stopScan();
    status.textContent = `Error: ${error.message}`;
  } finally {
    input.disabled = false;
    input.value = '';
  }
}

input.addEventListener('change', () => {
  const photo = input.files?.[0];
  if (!photo) return;
  void sampleDots(photo).then(dots => {
    scanDots = dots;
    startScan();
  });
  void upload(photo);
});
