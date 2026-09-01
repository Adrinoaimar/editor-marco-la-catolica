const canvas = document.querySelector('#editorCanvas');
const ctx = canvas.getContext('2d');
const input = document.querySelector('#photoInput');
const uploadZone = document.querySelector('#uploadZone');
const canvasWrap = document.querySelector('#canvasWrap');
const emptyState = document.querySelector('#emptyState');
const adjustments = document.querySelector('#adjustments');
const zoomRange = document.querySelector('#zoomRange');
const zoomValue = document.querySelector('#zoomValue');
const resetButton = document.querySelector('#resetButton');
const replaceButton = document.querySelector('#replaceButton');
const downloadButton = document.querySelector('#downloadButton');
const status = document.querySelector('#status');
const professionalProcessButton = document.querySelector('#professionalProcessButton');
const professionalProgress = document.querySelector('#professionalProgress');
const professionalStage = document.querySelector('#professionalStage');
const professionalPercent = document.querySelector('#professionalPercent');
const professionalProgressBar = document.querySelector('#professionalProgressBar');
const professionalProgressText = document.querySelector('#professionalProgressText');
const cancelProfessionalButton = document.querySelector('#cancelProfessionalButton');
const serverBadge = document.querySelector('#serverBadge');
const resultsPanel = document.querySelector('#resultsPanel');
const resultsGallery = document.querySelector('#resultsGallery');
const resultsDownloadButton = document.querySelector('#resultsDownloadButton');
const maskPointStatus = document.querySelector('#maskPointStatus');
const clearMaskPointsButton = document.querySelector('#clearMaskPointsButton');
const maskModeButtons = [...document.querySelectorAll('[data-mask-mode]')];

const configuredApi = new URLSearchParams(window.location.search).get('api');
const isLocalPreview = window.location.protocol === 'file:' || ['localhost', '127.0.0.1'].includes(window.location.hostname);
const localApi = isLocalPreview ? 'http://127.0.0.1:8787/api' : '/api';
const API_BASE = String(window.PHOTO_EDITOR_API || configuredApi || localApi).replace(/\/$/, '');

const state = {
  image: null,
  fileName: 'foto-la-catolica',
  items: [],
  selectedIndex: -1,
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
  dragging: false,
  pointerX: 0,
  pointerY: 0,
};

let logoCanvas = null;
let replaceRequested = false;
let batchDownloadInProgress = false;
let professionalJobId = null;
let professionalPollTimer = null;
let professionalBusy = false;
let backendAvailable = false;
let maskMode = 'off';

input.multiple = true;
const batchPanel = document.querySelector('#batchPanel');
const batchList = document.querySelector('#batchList');
const batchCount = document.querySelector('#batchCount');
const batchPosition = document.querySelector('#batchPosition');
const previousPhotoButton = document.querySelector('#previousPhotoButton');
const nextPhotoButton = document.querySelector('#nextPhotoButton');
const clearBatchButton = document.querySelector('#clearBatchButton');
const downloadBatchButton = document.querySelector('#downloadBatchButton');

function setStatus(message, type = '') {
  status.textContent = message;
  status.className = `status ${type}`.trim();
}

function setEnabled(enabled) {
  adjustments.setAttribute('aria-disabled', String(!enabled));
  zoomRange.disabled = !enabled;
  resetButton.disabled = !enabled;
  replaceButton.disabled = !enabled;
  downloadButton.disabled = !enabled;
  emptyState.hidden = enabled;
  canvasWrap.classList.toggle('is-ready', enabled);
}

function isHeicFile(file) {
  return /\.hei[cf]$/i.test(file.name || '') || ['image/heic', 'image/heif'].includes((file.type || '').toLowerCase());
}

function getCoverScale() {
  if (!state.image) return 1;
  return Math.max(canvas.width / state.image.naturalWidth, canvas.height / state.image.naturalHeight);
}

function clampOffsets() {
  if (!state.image) return;
  const scale = getCoverScale() * state.zoom;
  const overflowX = Math.max(0, (state.image.naturalWidth * scale - canvas.width) / 2);
  const overflowY = Math.max(0, (state.image.naturalHeight * scale - canvas.height) / 2);
  state.offsetX = Math.max(-overflowX, Math.min(overflowX, state.offsetX));
  state.offsetY = Math.max(-overflowY, Math.min(overflowY, state.offsetY));
}

function prepareLogo() {
  // Usamos el PNG transparente preprocesado para que file:// y GitHub Pages
  // rendericen el escudo real sin depender de getImageData/CORS.
  logoCanvas = document.createElement('canvas');
  logoCanvas.width = logoImage.naturalWidth;
  logoCanvas.height = logoImage.naturalHeight;
  logoCanvas.getContext('2d').drawImage(logoImage, 0, 0);
  draw();
}

function createFallbackLogo() {
  const fallback = document.createElement('canvas');
  fallback.width = 290;
  fallback.height = 330;
  const fallbackContext = fallback.getContext('2d');
  const path = new Path2D();
  path.moveTo(145, 0);
  path.quadraticCurveTo(235, 36, 286, 28);
  path.lineTo(278, 195);
  path.quadraticCurveTo(255, 270, 145, 330);
  path.quadraticCurveTo(35, 270, 12, 195);
  path.lineTo(4, 28);
  path.quadraticCurveTo(55, 36, 145, 0);
  path.closePath();
  fallbackContext.save();
  fallbackContext.clip(path);
  fallbackContext.fillStyle = '#121044';
  fallbackContext.fillRect(0, 0, 145, 330);
  fallbackContext.fillStyle = '#2786c3';
  fallbackContext.fillRect(145, 0, 145, 330);
  fallbackContext.restore();
  fallbackContext.strokeStyle = '#c7c8ca';
  fallbackContext.lineWidth = 9;
  fallbackContext.stroke(path);
  fallbackContext.strokeStyle = 'rgba(255,255,255,.65)';
  fallbackContext.lineWidth = 2;
  fallbackContext.stroke(path);
  fallbackContext.beginPath();
  fallbackContext.moveTo(145, 4);
  fallbackContext.lineTo(145, 326);
  fallbackContext.strokeStyle = '#10a8ed';
  fallbackContext.lineWidth = 5;
  fallbackContext.stroke();
  fallbackContext.fillStyle = '#f4f4f4';
  fallbackContext.textAlign = 'center';
  fallbackContext.textBaseline = 'middle';
  fallbackContext.font = '700 92px Georgia, serif';
  fallbackContext.fillText('L', 76, 160);
  fallbackContext.fillText('C', 215, 208);
  return fallback;
}

const logoImage = new Image();
logoImage.onload = () => {
  try {
    prepareLogo();
  } catch {
    // Chrome puede bloquear getImageData al abrir la página con file://.
    logoCanvas = createFallbackLogo();
    draw();
  }
};
logoImage.onerror = () => {
  logoCanvas = createFallbackLogo();
  draw();
};
logoImage.src = 'logo-transparent.png';

function drawFrame(targetContext = ctx, targetCanvas = canvas) {
  const gradient = targetContext.createLinearGradient(0, targetCanvas.height * 0.57, 0, targetCanvas.height);
  gradient.addColorStop(0, 'rgba(4, 14, 35, 0)');
  gradient.addColorStop(0.55, 'rgba(5, 18, 45, 0.58)');
  gradient.addColorStop(1, 'rgba(4, 17, 43, 0.98)');
  targetContext.fillStyle = gradient;
  targetContext.fillRect(0, targetCanvas.height * 0.5, targetCanvas.width, targetCanvas.height * 0.5);

  if (logoCanvas) {
    const logoHeight = Math.round(targetCanvas.height * 0.13);
    const logoWidth = Math.round(logoHeight * (logoCanvas.width / logoCanvas.height));
    const logoX = Math.round(targetCanvas.width * 0.122);
    const logoY = targetCanvas.height - logoHeight - Math.round(targetCanvas.height * 0.032);
    targetContext.drawImage(logoCanvas, logoX, logoY, logoWidth, logoHeight);
  }

  targetContext.fillStyle = 'rgba(255,255,255,.92)';
  targetContext.textAlign = 'center';
  targetContext.textBaseline = 'alphabetic';
  targetContext.font = '400 28px Arial, sans-serif';
  targetContext.fillText('CENTRO DE CAPACITACIÓN PROFESIONAL', targetCanvas.width / 2, 890);

  targetContext.fillStyle = '#fff';
  targetContext.font = '700 50px Arial, sans-serif';
  targetContext.letterSpacing = '12px';
  targetContext.fillText('LA CATÓLICA', targetCanvas.width / 2, 954);
  targetContext.letterSpacing = '0px';
}

function drawImageWithFrame(targetContext, targetCanvas, image, zoom = 1, offsetX = 0, offsetY = 0) {
  const scale = Math.max(targetCanvas.width / image.naturalWidth, targetCanvas.height / image.naturalHeight) * zoom;
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  const x = (targetCanvas.width - width) / 2 + offsetX;
  const y = (targetCanvas.height - height) / 2 + offsetY;

  targetContext.imageSmoothingEnabled = true;
  targetContext.imageSmoothingQuality = 'high';
  targetContext.drawImage(image, x, y, width, height);
  drawFrame(targetContext, targetCanvas);
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!state.image) return;
  drawImageWithFrame(ctx, canvas, state.image, state.zoom, state.offsetX, state.offsetY);
  drawManualMarkers();
}

function updateMaskPointStatus() {
  const item = state.items[state.selectedIndex];
  if (!item) {
    maskPointStatus.textContent = 'Opcional';
    return;
  }
  const positives = item.positivePoints?.length || 0;
  const negatives = item.negativePoints?.length || 0;
  maskPointStatus.textContent = positives || negatives ? `+${positives} · −${negatives}` : 'Opcional';
}

function drawManualMarkers() {
  const item = state.items[state.selectedIndex];
  if (!state.image || !item) return;
  const scale = getCoverScale() * state.zoom;
  const width = state.image.naturalWidth * scale;
  const height = state.image.naturalHeight * scale;
  const originX = (canvas.width - width) / 2 + state.offsetX;
  const originY = (canvas.height - height) / 2 + state.offsetY;
  const drawPoints = (points, color, symbol) => {
    ctx.save();
    ctx.fillStyle = color;
    ctx.strokeStyle = 'rgba(0,0,0,.7)';
    ctx.lineWidth = 3;
    ctx.font = '700 18px Arial, sans-serif';
    points.forEach(([x, y]) => {
      const px = originX + x * scale;
      const py = originY + y * scale;
      ctx.beginPath();
      ctx.arc(px, py, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(symbol, px, py + 1);
      ctx.fillStyle = color;
    });
    ctx.restore();
  };
  drawPoints(item.positivePoints || [], '#1bad6d', '+');
  drawPoints(item.negativePoints || [], '#d64b4b', '−');
}

function sourcePointFromEvent(event) {
  if (!state.image) return null;
  const rect = canvas.getBoundingClientRect();
  const canvasX = (event.clientX - rect.left) * (canvas.width / rect.width);
  const canvasY = (event.clientY - rect.top) * (canvas.height / rect.height);
  const scale = getCoverScale() * state.zoom;
  const width = state.image.naturalWidth * scale;
  const height = state.image.naturalHeight * scale;
  return {
    x: Math.max(0, Math.min(state.image.naturalWidth - 1, (canvasX - ((canvas.width - width) / 2 + state.offsetX)) / scale)),
    y: Math.max(0, Math.min(state.image.naturalHeight - 1, (canvasY - ((canvas.height - height) / 2 + state.offsetY)) / scale)),
  };
}

function resetPosition() {
  state.zoom = 1;
  state.offsetX = 0;
  state.offsetY = 0;
  zoomRange.value = '100';
  zoomValue.value = '100%';
  saveCurrentItemSettings();
  draw();
}

function validateFile(file) {
  const type = (file.type || '').toLowerCase();
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'].includes(type) && !isHeicFile(file)) {
    return 'Formato no compatible. Usa JPG, PNG, WebP o HEIC.';
  }
  if (file.size > 30 * 1024 * 1024) {
    return 'La imagen supera 30 MB. Elige un archivo más ligero.';
  }
  return '';
}

function readImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve({
        file,
        image,
        fileName: file.name.replace(/\.[^.]+$/, '') || 'foto-la-catolica',
        previewUrl: URL.createObjectURL(file),
        zoom: 1,
        offsetX: 0,
        offsetY: 0,
        positivePoints: [],
        negativePoints: [],
        backendOnly: false,
      });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('No se pudo leer la imagen. Prueba con otro archivo.'));
    };
    image.src = url;
  });
}

function createBackendOnlyItem(file) {
  return {
    file,
    image: null,
    fileName: file.name.replace(/\.[^.]+$/, '') || 'foto-la-catolica',
    previewUrl: '',
    zoom: 1,
    offsetX: 0,
    offsetY: 0,
    positivePoints: [],
    negativePoints: [],
    backendOnly: true,
  };
}

function saveCurrentItemSettings() {
  const item = state.items[state.selectedIndex];
  if (!item) return;
  item.zoom = state.zoom;
  item.offsetX = state.offsetX;
  item.offsetY = state.offsetY;
}

function selectItem(index) {
  if (!state.items[index]) return;
  saveCurrentItemSettings();
  const item = state.items[index];
  state.selectedIndex = index;
  state.image = item.image;
  state.fileName = item.fileName;
  state.zoom = item.zoom;
  state.offsetX = item.offsetX;
  state.offsetY = item.offsetY;
  zoomRange.value = String(Math.round(state.zoom * 100));
  zoomValue.value = `${zoomRange.value}%`;
  clampOffsets();
  setEnabled(Boolean(item.image));
  updateMaskPointStatus();
  updateBatchUI();
  draw();
}

function updateBatchUI() {
  const count = state.items.length;
  batchPanel.hidden = count === 0;
  batchCount.textContent = `${count} foto${count === 1 ? '' : 's'}`;
  batchPosition.textContent = count && state.selectedIndex >= 0 ? `${state.selectedIndex + 1} / ${count}` : '—';
  previousPhotoButton.disabled = count < 2 || state.selectedIndex <= 0 || batchDownloadInProgress;
  nextPhotoButton.disabled = count < 2 || state.selectedIndex < 0 || state.selectedIndex >= count - 1 || batchDownloadInProgress;
  clearBatchButton.disabled = count === 0 || batchDownloadInProgress;
  downloadBatchButton.disabled = count === 0 || batchDownloadInProgress || state.items.some((item) => !item.image);
  // El botón permanece disponible aunque el servicio esté apagado para mostrar
  // cómo iniciarlo; no queda bloqueado sin explicación.
  professionalProcessButton.disabled = count === 0 || professionalBusy;
  batchList.replaceChildren();

  state.items.forEach((item, index) => {
    const card = document.createElement('div');
    card.className = `batch-item${index === state.selectedIndex ? ' is-active' : ''}`;
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', `Seleccionar ${item.fileName}`);
    card.addEventListener('click', () => selectItem(index));
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectItem(index);
      }
    });

    const thumbnail = document.createElement('img');
    thumbnail.className = 'batch-thumb';
    if (item.previewUrl) thumbnail.src = item.previewUrl;
    else thumbnail.classList.add('is-missing');
    thumbnail.alt = item.backendOnly ? 'Vista previa disponible al procesar HEIC' : '';
    card.appendChild(thumbnail);

    const metadata = document.createElement('span');
    const name = document.createElement('span');
    name.className = 'batch-item-name';
    name.textContent = item.fileName;
    metadata.appendChild(name);
    const itemState = document.createElement('span');
    itemState.className = 'batch-item-state';
    itemState.textContent = item.backendOnly ? 'HEIC · servidor' : (index === state.selectedIndex ? 'Editando' : 'Lista');
    metadata.appendChild(itemState);
    card.appendChild(metadata);

    const remove = document.createElement('button');
    remove.className = 'batch-item-remove';
    remove.type = 'button';
    remove.title = `Quitar ${item.fileName}`;
    remove.setAttribute('aria-label', `Quitar ${item.fileName}`);
    remove.textContent = '×';
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      removeItem(index);
    });
    card.appendChild(remove);
    batchList.appendChild(card);
  });
}

function removeItem(index) {
  const [removed] = state.items.splice(index, 1);
  if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);

  if (state.items.length === 0) {
    state.selectedIndex = -1;
    state.image = null;
    state.fileName = 'foto-la-catolica';
    setEnabled(false);
    updateBatchUI();
    draw();
    setStatus('Selecciona una foto para comenzar.');
    return;
  }

  if (state.selectedIndex > index) state.selectedIndex -= 1;
  else if (state.selectedIndex === index) state.selectedIndex = Math.min(index, state.items.length - 1);
  selectItem(state.selectedIndex);
  setStatus(`${state.items.length} foto${state.items.length === 1 ? '' : 's'} en la lista.`, 'success');
}

function clearBatch() {
  state.items.forEach((item) => {
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
  });
  state.items = [];
  state.selectedIndex = -1;
  state.image = null;
  state.fileName = 'foto-la-catolica';
  setEnabled(false);
  updateBatchUI();
  draw();
  setStatus('Selecciona una foto para comenzar.');
}

async function loadFiles(fileList, { replaceIndex = null } = {}) {
  const files = Array.from(fileList || []).filter(Boolean);
  if (files.length === 0) return;

  const validFiles = [];
  let invalidCount = 0;
  for (const file of files) {
    const error = validateFile(file);
    if (error) invalidCount += 1;
    else validFiles.push(file);
  }
  if (validFiles.length === 0) {
    setStatus('No hay archivos compatibles. Usa JPG, PNG, WebP o HEIC.', 'error');
    return;
  }

  setStatus(`Cargando ${validFiles.length} foto${validFiles.length === 1 ? '' : 's'}...`);
  const loadedItems = [];
  let readErrors = 0;
  for (const file of validFiles) {
    try {
      loadedItems.push(await readImage(file));
    } catch {
      if (isHeicFile(file)) loadedItems.push(createBackendOnlyItem(file));
      else readErrors += 1;
    }
  }
  if (loadedItems.length === 0) {
    setStatus('No se pudo leer ninguna imagen. Prueba con otros archivos.', 'error');
    return;
  }

  if (replaceIndex !== null && state.items[replaceIndex]) {
    const previous = state.items[replaceIndex];
    if (previous.previewUrl) URL.revokeObjectURL(previous.previewUrl);
    state.items.splice(replaceIndex, 1, loadedItems[0]);
    if (loadedItems.length > 1) state.items.splice(replaceIndex + 1, 0, ...loadedItems.slice(1));
    state.selectedIndex = replaceIndex;
  } else {
    state.items.push(...loadedItems);
    if (state.selectedIndex < 0) state.selectedIndex = 0;
  }

  selectItem(state.selectedIndex);
  const notes = [];
  if (invalidCount) notes.push(`${invalidCount} archivo${invalidCount === 1 ? '' : 's'} omitido${invalidCount === 1 ? '' : 's'}`);
  if (readErrors) notes.push(`${readErrors} no se pudo leer`);
  setStatus(`${state.items.length} foto${state.items.length === 1 ? '' : 's'} lista${state.items.length === 1 ? '' : 's'}${notes.length ? ` · ${notes.join(' · ')}` : ''}.`, 'success');
}

input.addEventListener('change', (event) => {
  const files = event.target.files;
  const replaceIndex = replaceRequested && state.selectedIndex >= 0 ? state.selectedIndex : null;
  replaceRequested = false;
  loadFiles(files, { replaceIndex });
  input.value = '';
});
replaceButton.addEventListener('click', () => {
  replaceRequested = true;
  input.click();
});
resetButton.addEventListener('click', resetPosition);
clearBatchButton.addEventListener('click', clearBatch);

zoomRange.addEventListener('input', () => {
  state.zoom = Number(zoomRange.value) / 100;
  zoomValue.value = `${zoomRange.value}%`;
  clampOffsets();
  saveCurrentItemSettings();
  draw();
});

['dragenter', 'dragover'].forEach((eventName) => {
  uploadZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    uploadZone.classList.add('is-dragging');
  });
});

['dragleave', 'drop'].forEach((eventName) => {
  uploadZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    uploadZone.classList.remove('is-dragging');
  });
});

uploadZone.addEventListener('drop', (event) => loadFiles(event.dataTransfer.files));

canvasWrap.addEventListener('pointerdown', (event) => {
  if (!state.image) return;
  if (maskMode !== 'off') {
    const point = sourcePointFromEvent(event);
    const item = state.items[state.selectedIndex];
    if (point && item) {
      const target = maskMode === 'positive' ? item.positivePoints : item.negativePoints;
      target.push([Math.round(point.x), Math.round(point.y)]);
      updateMaskPointStatus();
      draw();
      setStatus(maskMode === 'positive' ? 'Punto de inclusión añadido.' : 'Punto de exclusión añadido.', 'success');
    }
    return;
  }
  state.dragging = true;
  state.pointerX = event.clientX;
  state.pointerY = event.clientY;
  canvasWrap.classList.add('is-dragging');
  canvasWrap.setPointerCapture(event.pointerId);
});

canvasWrap.addEventListener('pointermove', (event) => {
  if (!state.dragging) return;
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  state.offsetX += (event.clientX - state.pointerX) * scaleX;
  state.offsetY += (event.clientY - state.pointerY) * scaleY;
  state.pointerX = event.clientX;
  state.pointerY = event.clientY;
  clampOffsets();
  saveCurrentItemSettings();
  draw();
});

function stopDragging(event) {
  if (!state.dragging) return;
  state.dragging = false;
  canvasWrap.classList.remove('is-dragging');
  if (event.pointerId !== undefined && canvasWrap.hasPointerCapture(event.pointerId)) {
    canvasWrap.releasePointerCapture(event.pointerId);
  }
}

canvasWrap.addEventListener('pointerup', stopDragging);
canvasWrap.addEventListener('pointercancel', stopDragging);

function canvasToBlob(targetCanvas) {
  return new Promise((resolve) => targetCanvas.toBlob(resolve, 'image/jpeg', 0.94));
}

function downloadBlob(blob, fileName) {
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function renderItemToBlob(item) {
  const outputCanvas = document.createElement('canvas');
  outputCanvas.width = canvas.width;
  outputCanvas.height = canvas.height;
  const outputContext = outputCanvas.getContext('2d');
  drawImageWithFrame(outputContext, outputCanvas, item.image, item.zoom, item.offsetX, item.offsetY);
  return canvasToBlob(outputCanvas);
}

function safeOutputName(fileName) {
  const base = fileName
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9áéíóúÁÉÍÓÚñÑ _-]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
  return `${base || 'foto-la-catolica'}-con-marco.jpg`;
}

function uniqueOutputName(fileName, usedNames) {
  const original = safeOutputName(fileName);
  if (!usedNames.has(original)) {
    usedNames.add(original);
    return original;
  }
  const extension = '-con-marco.jpg';
  const base = original.slice(0, -extension.length);
  let counter = 2;
  let candidate = `${base}-${counter}${extension}`;
  while (usedNames.has(candidate)) {
    counter += 1;
    candidate = `${base}-${counter}${extension}`;
  }
  usedNames.add(candidate);
  return candidate;
}

let crcTable = null;
function getCrcTable() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[n] = c >>> 0;
  }
  return crcTable;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  const table = getCrcTable();
  for (const byte of bytes) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function getDosDateTime() {
  const now = new Date();
  const year = Math.max(1980, now.getFullYear());
  return {
    time: (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate(),
  };
}

async function createZip(entries) {
  const encoder = new TextEncoder();
  const chunks = [];
  const centralChunks = [];
  let offset = 0;
  const dos = getDosDateTime();

  for (const entry of entries) {
    const bytes = new Uint8Array(await entry.blob.arrayBuffer());
    const nameBytes = encoder.encode(entry.name);
    const checksum = crc32(bytes);
    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x800, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, dos.time, true);
    localView.setUint16(12, dos.date, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, bytes.length, true);
    localView.setUint32(22, bytes.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    chunks.push(local, bytes);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, dos.time, true);
    centralView.setUint16(14, dos.date, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, bytes.length, true);
    centralView.setUint32(24, bytes.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centralChunks.push(central);

    offset += local.length + bytes.length;
  }

  const centralSize = centralChunks.reduce((total, chunk) => total + chunk.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  endView.setUint16(20, 0, true);
  return new Blob([...chunks, ...centralChunks, end], { type: 'application/zip' });
}

downloadButton.addEventListener('click', async () => {
  if (!state.image || batchDownloadInProgress) return;
  saveCurrentItemSettings();
  const blob = await canvasToBlob(canvas);
  if (!blob) {
    setStatus('No se pudo preparar la descarga.', 'error');
    return;
  }
  downloadBlob(blob, safeOutputName(state.fileName));
  setStatus('Imagen descargada.', 'success');
});

function moveSelection(direction) {
  if (state.items.length < 2 || state.selectedIndex < 0) return;
  const nextIndex = Math.max(0, Math.min(state.items.length - 1, state.selectedIndex + direction));
  if (nextIndex !== state.selectedIndex) selectItem(nextIndex);
}

previousPhotoButton.addEventListener('click', () => moveSelection(-1));
nextPhotoButton.addEventListener('click', () => moveSelection(1));

downloadBatchButton.addEventListener('click', async () => {
  if (state.items.length === 0 || batchDownloadInProgress) return;
  saveCurrentItemSettings();
  batchDownloadInProgress = true;
  updateBatchUI();
  downloadButton.disabled = true;
  const entries = [];
  const usedNames = new Set();
  try {
    for (let index = 0; index < state.items.length; index += 1) {
      const item = state.items[index];
      setStatus(`Procesando foto ${index + 1} de ${state.items.length}...`);
      const blob = await renderItemToBlob(item);
      if (!blob) throw new Error(`No se pudo preparar la foto ${index + 1}.`);
      entries.push({ blob, name: uniqueOutputName(item.fileName, usedNames) });
    }
    setStatus('Creando archivo ZIP...');
    const zip = await createZip(entries);
    downloadBlob(zip, 'fotos-la-catolica-con-marco.zip');
    setStatus(`${entries.length} foto${entries.length === 1 ? '' : 's'} descargadas en un ZIP.`, 'success');
  } catch (error) {
    setStatus(error.message || 'No se pudo preparar el lote.', 'error');
  } finally {
    batchDownloadInProgress = false;
    updateBatchUI();
    downloadButton.disabled = !state.image;
  }
});

function apiUrl(path) {
  const normalized = String(path);
  if (/^\/?api\//.test(normalized)) {
    const origin = API_BASE.replace(/\/api$/, '');
    return `${origin}/${normalized.replace(/^\//, '')}`;
  }
  return `${API_BASE}/${normalized.replace(/^\//, '')}`;
}

async function checkProfessionalBackend() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1800);
    const response = await fetch(apiUrl('health'), { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) throw new Error('offline');
    const payload = await response.json();
    backendAvailable = Boolean(payload.ok && payload.model_available);
    serverBadge.textContent = backendAvailable ? 'Servidor listo' : 'Modelo no instalado';
    serverBadge.classList.toggle('is-ready', backendAvailable);
    serverBadge.classList.toggle('is-offline', !backendAvailable);
  } catch {
    backendAvailable = false;
    serverBadge.textContent = 'Solo edición local';
    serverBadge.classList.remove('is-ready');
    serverBadge.classList.add('is-offline');
  }
  updateBatchUI();
}

function setProfessionalProgress(payload) {
  const progress = payload.progress || {};
  const total = Math.max(1, Number(progress.total || payload.items?.length || 1));
  const completed = Math.min(total, Number(progress.completed || 0));
  const percent = payload.status === 'done' ? 100 : Math.round((completed / total) * 100);
  professionalPercent.textContent = `${percent}%`;
  professionalProgressBar.style.width = `${percent}%`;
  professionalStage.textContent = progress.stage === 'segmenting' ? 'Segmentando candidata…' : progress.stage === 'composing' ? 'Aplicando acabado…' : progress.stage === 'qa' ? 'Revisando máscara…' : payload.status === 'done' ? 'Lote listo' : 'En cola…';
  professionalProgressText.textContent = progress.current ? `${completed} de ${total}: ${progress.current}` : `${completed} de ${total} fotos procesadas.`;
}

function renderProfessionalResults(job) {
  resultsGallery.replaceChildren();
  (job.items || []).forEach((item) => {
    const card = document.createElement('article');
    card.className = 'result-card';
    const title = document.createElement('h3');
    title.textContent = item.name || item.source || 'Foto';
    card.appendChild(title);
    if (item.status === 'error') {
      const message = document.createElement('p');
      message.className = 'result-card-status review';
      message.textContent = item.error || 'No se pudo procesar.';
      card.appendChild(message);
      resultsGallery.appendChild(card);
      return;
    }
    const grid = document.createElement('div');
    grid.className = 'result-card-grid';
    const before = document.createElement('figure');
    const beforeImage = document.createElement('img');
    const sourceItem = state.items.find((candidate) => candidate.file.name === item.name);
    if (sourceItem?.previewUrl) beforeImage.src = sourceItem.previewUrl;
    beforeImage.alt = 'Antes';
    before.appendChild(beforeImage);
    const beforeCaption = document.createElement('figcaption');
    beforeCaption.textContent = 'Antes';
    before.appendChild(beforeCaption);
    grid.appendChild(before);
    const horizontal = item.outputs?.find((output) => output.type === 'horizontal');
    const after = document.createElement('figure');
    const afterImage = document.createElement('img');
    if (horizontal) afterImage.src = apiUrl(horizontal.url);
    afterImage.alt = 'Después';
    after.appendChild(afterImage);
    const afterCaption = document.createElement('figcaption');
    afterCaption.textContent = 'Horizontal 1920 × 1080';
    after.appendChild(afterCaption);
    grid.appendChild(after);
    const vertical = item.outputs?.find((output) => output.type === 'vertical');
    if (vertical) {
      const verticalFigure = document.createElement('figure');
      const verticalImage = document.createElement('img');
      verticalImage.src = apiUrl(vertical.url);
      verticalImage.alt = 'Versión vertical';
      verticalFigure.appendChild(verticalImage);
      const verticalCaption = document.createElement('figcaption');
      verticalCaption.textContent = 'Vertical 1080 × 1350';
      verticalFigure.appendChild(verticalCaption);
      grid.appendChild(verticalFigure);
    }
    card.appendChild(grid);
    const resultStatus = document.createElement('p');
    resultStatus.className = `result-card-status${item.needs_review ? ' review' : ''}`;
    resultStatus.textContent = item.needs_review ? 'Requiere revisión de máscara' : 'Máscara aprobada';
    card.appendChild(resultStatus);
    resultsGallery.appendChild(card);
  });
  resultsPanel.hidden = false;
  resultsDownloadButton.hidden = job.status !== 'done';
  resultsDownloadButton.href = job.download ? apiUrl(job.download) : '#';
}

async function pollProfessionalJob(jobId) {
  try {
    const response = await fetch(apiUrl(`jobs/${jobId}`));
    if (!response.ok) throw new Error('No se pudo consultar el lote.');
    const job = await response.json();
    setProfessionalProgress(job);
    if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') {
      professionalBusy = false;
      professionalJobId = null;
      cancelProfessionalButton.hidden = true;
      professionalProgress.hidden = false;
      renderProfessionalResults(job);
      setStatus(job.status === 'done' ? 'Proceso profesional terminado. Revisa la galería de resultados.' : (job.error || 'El lote terminó con incidencias.'), job.status === 'done' ? 'success' : 'error');
      updateBatchUI();
      return;
    }
    professionalPollTimer = setTimeout(() => pollProfessionalJob(jobId), 900);
  } catch (error) {
    professionalBusy = false;
    professionalJobId = null;
    setStatus(error.message || 'No se pudo consultar el proceso profesional.', 'error');
    updateBatchUI();
  }
}

async function processProfessionalBatch() {
  if (state.items.length === 0 || professionalBusy) return;
  if (!backendAvailable) {
    setStatus('El servicio HQ‑SAM no está iniciado. Abre ABRIR_EDITOR_PRO.bat y recarga esta página.', 'error');
    checkProfessionalBackend();
    return;
  }
  saveCurrentItemSettings();
  professionalBusy = true;
  professionalProgress.hidden = false;
  cancelProfessionalButton.hidden = false;
  resultsPanel.hidden = true;
  updateBatchUI();
  const formData = new FormData();
  state.items.forEach((item) => formData.append('files', item.file, item.file.name));
  formData.append('annotations', JSON.stringify(state.items.map((item) => ({
    fileName: item.file.name,
    positive: item.positivePoints || [],
    negative: item.negativePoints || [],
  }))));
  try {
    setStatus('Enviando lote al proceso profesional…');
    const response = await fetch(apiUrl('jobs'), { method: 'POST', body: formData });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'No se pudo crear el lote.');
    professionalJobId = payload.id;
    setProfessionalProgress(payload);
    setStatus('Lote en cola. Puedes seguir ajustando la vista local.');
    pollProfessionalJob(professionalJobId);
  } catch (error) {
    professionalBusy = false;
    professionalJobId = null;
    setStatus(error.message || 'No se pudo enviar el lote.', 'error');
    updateBatchUI();
  }
}

professionalProcessButton.addEventListener('click', processProfessionalBatch);
cancelProfessionalButton.addEventListener('click', async () => {
  if (!professionalJobId) return;
  try {
    await fetch(apiUrl(`jobs/${professionalJobId}/cancel`), { method: 'POST' });
    setStatus('Cancelando lote…');
  } catch {
    setStatus('No se pudo cancelar el lote.', 'error');
  }
});

maskModeButtons.forEach((button) => button.addEventListener('click', () => {
  maskMode = button.dataset.maskMode || 'off';
  maskModeButtons.forEach((candidate) => candidate.classList.toggle('is-active', candidate === button));
  canvasWrap.classList.toggle('is-marking', maskMode !== 'off');
  setStatus(maskMode === 'positive' ? 'Haz clic en la candidata o accesorio para incluirlo.' : maskMode === 'negative' ? 'Haz clic en el fondo o accesorio para excluirlo.' : 'Arrastra la foto para ajustar su posición.');
}));

clearMaskPointsButton.addEventListener('click', () => {
  const item = state.items[state.selectedIndex];
  if (!item) return;
  item.positivePoints = [];
  item.negativePoints = [];
  updateMaskPointStatus();
  draw();
  setStatus('Puntos manuales eliminados.', 'success');
});

setEnabled(false);
updateBatchUI();
checkProfessionalBackend();
