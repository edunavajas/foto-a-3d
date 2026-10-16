const input = document.querySelector('#photo');
const status = document.querySelector('#status');
const preview = document.querySelector('#preview');

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

async function upload(photo) {
  input.disabled = true;
  preview.hidden = true;
  preview.removeAttribute('src');
  status.textContent = 'Uploading photo…';

  try {
    const form = new FormData();
    form.append('photo', photo);
    const created = await readJson(await fetch('/api/jobs', { method: 'POST', body: form }));
    status.textContent = 'Generating model…';

    while (true) {
      const job = await readJson(await fetch(`/api/jobs/${encodeURIComponent(created.id)}`, { cache: 'no-store' }));
      if (job.status === 'ready') {
        preview.src = job.modelUrl;
        preview.hidden = false;
        status.textContent = 'Model ready. Drag to rotate it.';
        return;
      }
      if (job.status === 'error') throw new Error(job.error || 'Model generation failed.');
      await pause(2000);
    }
  } catch (error) {
    status.textContent = `Error: ${error.message}`;
  } finally {
    input.disabled = false;
    input.value = '';
  }
}

input.addEventListener('change', () => {
  const photo = input.files?.[0];
  if (photo) void upload(photo);
});
