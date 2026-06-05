import { MAX_UPLOAD_BYTES } from './utils/blobStore.js';

/**
 * Render the browser photo-upload page. The client reads the image, previews
 * it, and POSTs { image_data (base64), mime_type, filename } back to the same
 * URL. Server-side validation (token, MIME whitelist, size) is authoritative;
 * the client checks are only for UX.
 */
export function renderUploadPage(token: string, error?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Upload Photo</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #f5f5f5; color: #333;
    display: flex; align-items: center; justify-content: center;
    min-height: 100dvh; padding: 1rem;
  }
  .card {
    background: #fff; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,.08);
    padding: 2rem; max-width: 420px; width: 100%; text-align: center;
  }
  h1 { font-size: 1.25rem; margin-bottom: .5rem; }
  p.sub { color: #666; font-size: .875rem; margin-bottom: 1.5rem; }
  .dropzone {
    border: 2px dashed #ccc; border-radius: 8px; padding: 2.5rem 1rem;
    cursor: pointer; transition: border-color .2s, background .2s;
    position: relative;
  }
  .dropzone:hover, .dropzone.over { border-color: #0070f3; background: #f0f7ff; }
  .dropzone input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
  .dropzone .icon { font-size: 2.5rem; margin-bottom: .5rem; }
  .dropzone .label { color: #555; font-size: .9rem; }
  .preview { display: none; margin-top: 1rem; }
  .preview img {
    max-width: 100%; max-height: 240px; border-radius: 8px;
    object-fit: contain; margin-bottom: .75rem;
  }
  .preview-actions { display: flex; gap: .75rem; justify-content: center; }
  .btn {
    padding: .6rem 1.5rem; border-radius: 8px; border: none;
    font-size: .9rem; cursor: pointer; font-weight: 500;
    transition: background .2s, transform .1s;
  }
  .btn:active { transform: scale(0.97); }
  .btn-primary { background: #0070f3; color: #fff; }
  .btn-primary:hover { background: #005bc4; }
  .btn-secondary { background: #e5e7eb; color: #333; }
  .btn-secondary:hover { background: #d1d5db; }
  .progress { display: none; margin-top: 1rem; }
  .progress-bar {
    height: 6px; background: #e0e0e0; border-radius: 3px; overflow: hidden;
  }
  .progress-fill {
    height: 100%; background: #0070f3; width: 0%; transition: width .3s;
  }
  .progress-text { font-size: .8rem; color: #666; margin-top: .5rem; }
  .success { display: none; }
  .success .check { font-size: 3rem; color: #22c55e; }
  .success p { margin-top: .75rem; color: #555; }
  .error { color: #dc2626; font-size: .85rem; margin-top: 1rem; display: none; }
  .error.visible { display: block; }
  .initial-error { color: #dc2626; font-size: .85rem; margin-bottom: 1rem; }
</style>
</head>
<body>
<div class="card">
  ${error ? `<p class="initial-error">${error}</p>` : ''}
  <div id="upload-area">
    <h1>Upload Photo</h1>
    <p class="sub">Your image will be attached to the report.</p>
    <div class="dropzone" id="dropzone">
      <div class="icon">&#128247;</div>
      <div class="label">Tap to take a photo or drop an image here</div>
      <input type="file" accept="image/*" capture="environment" id="file-input">
    </div>
    <div class="preview" id="preview">
      <img id="preview-img" alt="Preview">
      <div class="preview-actions">
        <button class="btn btn-secondary" id="retake-btn">Retake</button>
        <button class="btn btn-primary" id="confirm-btn">Upload</button>
      </div>
    </div>
    <div class="progress" id="progress">
      <div class="progress-bar"><div class="progress-fill" id="progress-fill"></div></div>
      <div class="progress-text" id="progress-text">Uploading...</div>
    </div>
    <div class="error" id="error"></div>
  </div>
  <div class="success" id="success">
    <div class="check">&#10003;</div>
    <p><strong>Photo uploaded!</strong></p>
    <p>You can close this window and return to the chat.</p>
  </div>
</div>
<script>
const token = ${JSON.stringify(token)};
const MAX_FILE_SIZE = ${MAX_UPLOAD_BYTES};
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
const previewEl = document.getElementById('preview');
const previewImg = document.getElementById('preview-img');
const retakeBtn = document.getElementById('retake-btn');
const confirmBtn = document.getElementById('confirm-btn');
const progress = document.getElementById('progress');
const progressFill = document.getElementById('progress-fill');
const progressText = document.getElementById('progress-text');
const errorEl = document.getElementById('error');
const uploadArea = document.getElementById('upload-area');
const successEl = document.getElementById('success');

let pendingFile = null;
let pendingBase64 = null;

dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('over'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('over');
  if (e.dataTransfer.files.length) selectFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) selectFile(fileInput.files[0]);
});

retakeBtn.addEventListener('click', () => {
  pendingFile = null;
  pendingBase64 = null;
  previewEl.style.display = 'none';
  dropzone.style.display = 'block';
  fileInput.value = '';
  errorEl.classList.remove('visible');
});

confirmBtn.addEventListener('click', () => {
  if (pendingFile && pendingBase64) {
    uploadFile(pendingFile, pendingBase64);
  }
});

async function selectFile(file) {
  errorEl.classList.remove('visible');

  if (!file.type.startsWith('image/')) {
    showError('Please select an image file.');
    return;
  }
  if (file.size > MAX_FILE_SIZE) {
    showError('Image is too large. Maximum size is 4.5 MB.');
    return;
  }

  pendingFile = file;

  const dataUrl = await fileToDataUrl(file);
  pendingBase64 = dataUrl.split(',')[1];
  previewImg.src = dataUrl;
  dropzone.style.display = 'none';
  previewEl.style.display = 'block';
}

async function uploadFile(file, base64) {
  previewEl.style.display = 'none';
  progress.style.display = 'block';
  progressFill.style.width = '30%';
  progressText.textContent = 'Uploading...';

  try {
    const res = await fetch(window.location.pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image_data: base64,
        mime_type: file.type,
        filename: file.name,
      }),
    });

    progressFill.style.width = '90%';

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Upload failed');
    }

    progressFill.style.width = '100%';
    progressText.textContent = 'Done!';

    setTimeout(() => {
      uploadArea.style.display = 'none';
      successEl.style.display = 'block';
    }, 500);
  } catch (e) {
    progress.style.display = 'none';
    dropzone.style.display = 'block';
    pendingFile = null;
    pendingBase64 = null;
    showError(e.message || 'Upload failed. Please try again.');
  }
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.classList.add('visible');
}
</script>
</body>
</html>`;
}
