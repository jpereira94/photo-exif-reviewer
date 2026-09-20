const welcome = document.querySelector('#welcome');
const reviewer = document.querySelector('#reviewer');
const empty = document.querySelector('#empty');
const content = document.querySelector('.content');
const photoStage = document.querySelector('.photo-stage');
const photo = document.querySelector('#photo');
const comparison = document.querySelector('#comparison');
const details = document.querySelector('aside');
const metadata = document.querySelector('#metadata');
const counter = document.querySelector('#counter');
const folderName = document.querySelector('#folder-name');
const previousButton = document.querySelector('#previous');
const nextButton = document.querySelector('#next');
const deleteButton = document.querySelector('#delete');
const selectedOnlyButton = document.querySelector('#selected-only');
const compareButton = document.querySelector('#compare');
const clearSelectionButton = document.querySelector('#clear-selection');
const selectionCount = document.querySelector('#selection-count');
const thumbnails = document.querySelector('#thumbnails');
const loading = document.querySelector('#loading');
const toast = document.querySelector('#toast');
const folderButtons = [...document.querySelectorAll('#choose-folder, #welcome-choose-folder, #empty-choose-folder')];
const pathForm = document.querySelector('#path-form');
const pathSubmitButton = pathForm.querySelector('button[type="submit"]');
const zoomViewer = document.querySelector('#zoom-viewer');
const zoomStage = document.querySelector('#zoom-stage');
const zoomImage = document.querySelector('#zoom-image');
const zoomFilename = document.querySelector('#zoom-filename');
const zoomLevel = document.querySelector('#zoom-level');
const zoomLoading = document.querySelector('#zoom-loading');

let folder = '';
let photos = [];
let currentIndex = 0;
let currentRawFiles = [];
let selectedOnly = false;
let compareMode = false;
let loadId = 0;
let toastTimer;
let zoomScale = 1;
let zoomFitScale = 1;
let zoomX = 0;
let zoomY = 0;
let zoomDragging = false;
let zoomPointerX = 0;
let zoomPointerY = 0;
const selectedNames = new Set();

const labels = {
  FileName: 'Ficheiro',
  ExposureProgram: 'Programa',
  ExposureMode: 'Modo de exposição',
  Aperture: 'Abertura',
  ShutterSpeed: 'Velocidade',
  ISO: 'ISO',
  FocalLength: 'Distância focal',
  Model: 'Câmara',
  LensModel: 'Objetiva'
};

function showToast(message, isError = false) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.toggle('error', isError);
  toast.hidden = false;
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 4200);
}

async function request(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Ocorreu um erro inesperado.');
  }

  return data;
}

function updateZoom() {
  zoomImage.style.transform = `translate(${zoomX}px, ${zoomY}px) scale(${zoomScale})`;
  zoomLevel.textContent = `${Math.round(zoomScale * 100)}%`;
}

function fitZoom() {
  if (!zoomImage.naturalWidth || !zoomImage.naturalHeight) {
    return;
  }

  const bounds = zoomStage.getBoundingClientRect();
  zoomFitScale = Math.min(
    bounds.width / zoomImage.naturalWidth,
    bounds.height / zoomImage.naturalHeight,
    1
  );
  zoomScale = zoomFitScale;
  zoomX = (bounds.width - zoomImage.naturalWidth * zoomScale) / 2;
  zoomY = (bounds.height - zoomImage.naturalHeight * zoomScale) / 2;
  updateZoom();
}

function changeZoom(nextScale, clientX, clientY) {
  const bounds = zoomStage.getBoundingClientRect();
  const pointX = (clientX ?? bounds.left + bounds.width / 2) - bounds.left;
  const pointY = (clientY ?? bounds.top + bounds.height / 2) - bounds.top;
  const imageX = (pointX - zoomX) / zoomScale;
  const imageY = (pointY - zoomY) / zoomScale;

  zoomScale = Math.min(Math.max(nextScale, zoomFitScale), 4);
  zoomX = pointX - imageX * zoomScale;
  zoomY = pointY - imageY * zoomScale;
  updateZoom();
}

function openZoom(item) {
  if (!item) {
    return;
  }

  zoomFilename.textContent = item.name;
  zoomImage.alt = item.name;
  zoomImage.hidden = true;
  zoomLoading.hidden = false;
  zoomViewer.showModal();
  zoomImage.onload = () => {
    zoomImage.hidden = false;
    zoomLoading.hidden = true;
    fitZoom();
  };
  zoomImage.onerror = () => {
    zoomLoading.textContent = 'Não foi possível carregar a imagem original.';
  };
  zoomImage.src = item.originalUrl;
}

function closeZoom() {
  zoomViewer.close();
}

function navigationIndices() {
  return photos.reduce((indices, item, index) => {
    if (!selectedOnly || selectedNames.has(item.name)) {
      indices.push(index);
    }

    return indices;
  }, []);
}

function updateView() {
  welcome.hidden = Boolean(folder);
  reviewer.hidden = !folder || photos.length === 0;
  empty.hidden = !folder || photos.length > 0;
}

function setFolderLoading(isLoading) {
  folderButtons.forEach((button) => {
    button.dataset.label ||= button.textContent;
    button.disabled = isLoading;
    button.textContent = isLoading ? 'A preparar imagens…' : button.dataset.label;
  });
  pathSubmitButton.disabled = isLoading;
  pathSubmitButton.textContent = isLoading ? 'A preparar…' : 'Abrir';
}

function updateControls() {
  const indices = navigationIndices();
  const position = indices.indexOf(currentIndex);
  const selectedCount = selectedNames.size;

  counter.textContent = compareMode
    ? `${selectedCount} fotografias em comparação`
    : `${currentIndex + 1} de ${photos.length}${selectedOnly ? ` · seleção ${position + 1} de ${indices.length}` : ''}`;
  previousButton.disabled = compareMode || position <= 0;
  nextButton.disabled = compareMode || position < 0 || position === indices.length - 1;
  deleteButton.disabled = compareMode;
  selectedOnlyButton.disabled = selectedCount === 0;
  selectedOnlyButton.textContent = selectedCount ? `Só selecionadas (${selectedCount})` : 'Só selecionadas';
  selectedOnlyButton.setAttribute('aria-pressed', String(selectedOnly));
  compareButton.disabled = selectedCount < 2;
  compareButton.textContent = selectedCount >= 2 ? `Comparar (${selectedCount})` : 'Comparar';
  compareButton.setAttribute('aria-pressed', String(compareMode));
  clearSelectionButton.disabled = selectedCount === 0;
  selectionCount.textContent = selectedCount === 0
    ? 'Nenhuma selecionada'
    : `${selectedCount} ${selectedCount === 1 ? 'selecionada' : 'selecionadas'}`;
}

function renderThumbnails() {
  thumbnails.replaceChildren();

  photos.forEach((item, index) => {
    const wrapper = document.createElement('div');
    const preview = document.createElement('button');
    const image = document.createElement('img');
    const name = document.createElement('span');
    const selectLabel = document.createElement('label');
    const checkbox = document.createElement('input');

    wrapper.className = 'thumbnail';
    wrapper.dataset.index = index;
    wrapper.classList.toggle('current', index === currentIndex && !compareMode);
    wrapper.classList.toggle('selected', selectedNames.has(item.name));

    preview.className = 'thumbnail-preview';
    preview.type = 'button';
    preview.title = item.name;
    preview.setAttribute('aria-label', `Ver ${item.name}`);
    image.src = item.thumbnailUrl;
    image.alt = '';
    image.loading = 'lazy';
    name.className = 'thumbnail-name';
    name.textContent = item.name;

    preview.append(image);
    preview.addEventListener('click', () => {
      currentIndex = index;
      selectedOnly = false;
      compareMode = false;
      loadPhoto();
    });

    checkbox.type = 'checkbox';
    checkbox.checked = selectedNames.has(item.name);
    checkbox.setAttribute('aria-label', `Selecionar ${item.name}`);
    checkbox.addEventListener('change', () => toggleSelection(item.name));
    selectLabel.className = 'thumbnail-select';
    selectLabel.append(checkbox);

    wrapper.append(preview, selectLabel, name);

    if (item.rawFiles.length) {
      const rawBadge = document.createElement('span');
      rawBadge.className = 'raw-badge';
      rawBadge.textContent = 'RAW';
      rawBadge.title = item.rawFiles.join(', ');
      wrapper.append(rawBadge);
    }

    thumbnails.append(wrapper);
  });

  document.querySelector(`.thumbnail[data-index="${currentIndex}"]`)?.scrollIntoView({
    block: 'nearest',
    inline: 'nearest'
  });
}

function toggleSelection(name) {
  if (selectedNames.has(name)) {
    selectedNames.delete(name);
  } else {
    selectedNames.add(name);
  }

  if (selectedOnly && !selectedNames.size) {
    selectedOnly = false;
  }

  if (selectedOnly && !selectedNames.has(photos[currentIndex].name)) {
    currentIndex = photos.findIndex((item) => selectedNames.has(item.name));
    loadPhoto();
    return;
  }

  if (compareMode && selectedNames.size < 2) {
    compareMode = false;
    loadPhoto();
    return;
  }

  if (compareMode) {
    renderComparison();
  } else {
    updateControls();
    renderThumbnails();
  }
}

function setFolder(data) {
  folder = data.folder;
  photos = data.photos;
  currentIndex = 0;
  currentRawFiles = [];
  selectedOnly = false;
  compareMode = false;
  selectedNames.clear();
  folderName.textContent = folder;
  folderName.title = folder;
  updateView();

  if (photos.length) {
    renderThumbnails();
    loadPhoto();
  }
}

async function chooseFolder() {
  setFolderLoading(true);

  try {
    setFolder(await request('/api/select-folder'));
  } catch (error) {
    if (error.message !== 'Seleção cancelada.') {
      showToast(error.message, true);
    }
  } finally {
    setFolderLoading(false);
  }
}

async function loadPhoto() {
  const requestedLoad = ++loadId;
  currentRawFiles = photos[currentIndex]?.rawFiles || [];
  compareMode = false;
  content.classList.remove('comparing');
  photoStage.hidden = false;
  comparison.hidden = true;
  details.hidden = false;
  loading.hidden = false;
  photo.style.opacity = '0.25';
  photo.src = photos[currentIndex].previewUrl;
  photo.alt = photos[currentIndex].name;
  updateControls();

  try {
    const data = await request(`/api/photos/${currentIndex}`);

    if (requestedLoad !== loadId) {
      return;
    }

    currentRawFiles = data.rawFiles;
    metadata.replaceChildren();

    Object.entries(data.metadata).forEach(([key, value]) => {
      const row = document.createElement('div');
      const term = document.createElement('dt');
      const description = document.createElement('dd');
      row.className = 'metadata-row';
      term.textContent = labels[key] || key;
      description.textContent = value;
      row.append(term, description);
      metadata.append(row);
    });
  } catch (error) {
    showToast(error.message, true);
  } finally {
    if (requestedLoad === loadId) {
      loading.hidden = true;
      photo.style.opacity = '1';
      updateControls();
      renderThumbnails();
    }
  }
}

function renderComparison() {
  const selectedPhotos = photos
    .map((item, index) => ({ ...item, index }))
    .filter((item) => selectedNames.has(item.name));

  if (selectedPhotos.length < 2) {
    return;
  }

  compareMode = true;
  selectedOnly = false;
  content.classList.add('comparing');
  photoStage.hidden = true;
  details.hidden = true;
  comparison.hidden = false;
  comparison.replaceChildren();

  selectedPhotos.forEach((item) => {
    const card = document.createElement('article');
    const image = document.createElement('img');
    const name = document.createElement('span');
    card.className = 'comparison-item';
    image.src = item.previewUrl;
    image.alt = item.name;
    image.addEventListener('dblclick', () => openZoom(item));
    name.textContent = item.name;
    card.append(image, name);
    comparison.append(card);
  });

  updateControls();
  renderThumbnails();
}

function previousPhoto() {
  const indices = navigationIndices();
  const position = indices.indexOf(currentIndex);

  if (!compareMode && position > 0) {
    currentIndex = indices[position - 1];
    loadPhoto();
  }
}

function nextPhoto() {
  const indices = navigationIndices();
  const position = indices.indexOf(currentIndex);

  if (!compareMode && position >= 0 && position < indices.length - 1) {
    currentIndex = indices[position + 1];
    loadPhoto();
  }
}

function toggleSelectedOnly() {
  if (!selectedNames.size) {
    return;
  }

  selectedOnly = !selectedOnly;
  compareMode = false;

  if (selectedOnly && !selectedNames.has(photos[currentIndex].name)) {
    currentIndex = photos.findIndex((item) => selectedNames.has(item.name));
  }

  loadPhoto();
}

async function deletePhoto() {
  const item = photos[currentIndex];

  if (!item) {
    return;
  }

  const rawMessage = currentRawFiles.length
    ? `\n\nTambém será movido para o Lixo: ${currentRawFiles.join(', ')}`
    : '';

  if (!window.confirm(`Mover “${item.name}” para o Lixo?${rawMessage}`)) {
    return;
  }

  deleteButton.disabled = true;

  try {
    const result = await request(`/api/photos/${currentIndex}`, { method: 'DELETE' });
    selectedNames.delete(item.name);
    photos = result.photos;
    const deletedFiles = [result.deleted, ...result.deletedRawFiles];
    showToast(`Movido${deletedFiles.length > 1 ? 's' : ''} para o Lixo: ${deletedFiles.join(', ')}.`);

    if (result.nextIndex === null) {
      updateView();
      return;
    }

    currentIndex = result.nextIndex;

    if (selectedOnly) {
      const firstSelected = photos.findIndex((photoItem) => selectedNames.has(photoItem.name));
      selectedOnly = firstSelected !== -1;
      currentIndex = selectedOnly ? firstSelected : currentIndex;
    }

    renderThumbnails();
    await loadPhoto();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    deleteButton.disabled = false;
  }
}

folderButtons.forEach((button) => {
  button.addEventListener('click', chooseFolder);
});

pathForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const path = new FormData(event.currentTarget).get('path')?.trim();
  setFolderLoading(true);

  try {
    setFolder(await request('/api/folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path })
    }));
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setFolderLoading(false);
  }
});

previousButton.addEventListener('click', previousPhoto);
nextButton.addEventListener('click', nextPhoto);
deleteButton.addEventListener('click', deletePhoto);
photo.addEventListener('dblclick', () => openZoom(photos[currentIndex]));
selectedOnlyButton.addEventListener('click', toggleSelectedOnly);
compareButton.addEventListener('click', () => {
  if (compareMode) {
    loadPhoto();
  } else {
    renderComparison();
  }
});
clearSelectionButton.addEventListener('click', () => {
  selectedNames.clear();
  selectedOnly = false;

  if (compareMode) {
    loadPhoto();
  } else {
    updateControls();
    renderThumbnails();
  }
});

document.querySelector('#zoom-close').addEventListener('click', closeZoom);
document.querySelector('#zoom-fit').addEventListener('click', fitZoom);
document.querySelector('#zoom-in').addEventListener('click', () => changeZoom(zoomScale * 1.25));
document.querySelector('#zoom-out').addEventListener('click', () => changeZoom(zoomScale / 1.25));

zoomStage.addEventListener('wheel', (event) => {
  event.preventDefault();
  changeZoom(zoomScale * (event.deltaY < 0 ? 1.15 : 1 / 1.15), event.clientX, event.clientY);
}, { passive: false });

zoomStage.addEventListener('dblclick', (event) => {
  if (zoomScale < 0.99) {
    changeZoom(1, event.clientX, event.clientY);
  } else {
    fitZoom();
  }
});

zoomStage.addEventListener('pointerdown', (event) => {
  zoomDragging = true;
  zoomPointerX = event.clientX;
  zoomPointerY = event.clientY;
  zoomImage.classList.add('dragging');
  zoomStage.setPointerCapture(event.pointerId);
});

zoomStage.addEventListener('pointermove', (event) => {
  if (!zoomDragging) {
    return;
  }

  zoomX += event.clientX - zoomPointerX;
  zoomY += event.clientY - zoomPointerY;
  zoomPointerX = event.clientX;
  zoomPointerY = event.clientY;
  updateZoom();
});

zoomStage.addEventListener('pointerup', () => {
  zoomDragging = false;
  zoomImage.classList.remove('dragging');
});

zoomViewer.addEventListener('close', () => {
  zoomDragging = false;
  zoomImage.classList.remove('dragging');
  zoomImage.onload = null;
  zoomImage.onerror = null;
  zoomImage.removeAttribute('src');
  zoomLoading.textContent = 'A carregar original…';
});

window.addEventListener('keydown', (event) => {
  if (reviewer.hidden || compareMode || ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
    return;
  }

  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    previousPhoto();
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    nextPhoto();
  } else if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault();
    deletePhoto();
  }
});
