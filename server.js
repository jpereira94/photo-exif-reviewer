import express from 'express';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, realpath, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { exiftool } from 'exiftool-vendored';
import sharp from 'sharp';
import trash from 'trash';

const execFileAsync = promisify(execFile);
const app = express();
const port = Number(process.env.PORT) || 4173;
const host = '127.0.0.1';
const appDirectory = path.dirname(fileURLToPath(import.meta.url));
const imageCacheDirectory = path.join(tmpdir(), 'photo-exif-reviewer');
const supportedExtensions = new Set(['.jpg', '.jpeg']);
const rawExtensions = new Set(['.arw', '.cr2', '.cr3', '.dng', '.nef', '.nrw', '.orf', '.pef', '.raf', '.raw', '.rw2', '.srw']);

let selectedFolder = '';
let photos = [];

app.use(express.json());
app.use(express.static(path.join(appDirectory, 'public')));

function naturalSort(left, right) {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

async function prepareImages(photo, folderCacheDirectory) {
  const sourceStats = await stat(photo.path);
  const cacheKey = createHash('sha1')
    .update(`${photo.path}:${sourceStats.size}:${sourceStats.mtimeMs}`)
    .digest('hex');
  const thumbnailPath = path.join(folderCacheDirectory, `${photo.name}-thumbnail.jpg`);
  const previewPath = path.join(folderCacheDirectory, `${photo.name}-preview.jpg`);
  const [thumbnailStats, previewStats] = await Promise.all([
    stat(thumbnailPath).catch(() => null),
    stat(previewPath).catch(() => null)
  ]);

  if (
    !thumbnailStats
    || !previewStats
    || thumbnailStats.mtimeMs < sourceStats.mtimeMs
    || previewStats.mtimeMs < sourceStats.mtimeMs
  ) {
    const image = sharp(photo.path).rotate();
    await Promise.all([
      image.clone()
        .resize(320, 220, { fit: 'cover' })
        .jpeg({ quality: 72 })
        .toFile(thumbnailPath),
      image.clone()
        .resize(2048, 1536, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 84 })
        .toFile(previewPath)
    ]);
  }

  photo.cacheKey = cacheKey;
  photo.thumbnailPath = thumbnailPath;
  photo.previewPath = previewPath;
}

function clientPhoto(photo, index) {
  return {
    name: photo.name,
    rawFiles: photo.rawFiles.map((rawFile) => rawFile.name),
    thumbnailUrl: `/api/photos/${index}/thumbnail?v=${photo.cacheKey}`,
    previewUrl: `/api/photos/${index}/preview?v=${photo.cacheKey}`,
    originalUrl: `/api/photos/${index}/file?v=${photo.cacheKey}`
  };
}

async function loadFolder(folderPath) {
  const resolvedPath = await realpath(folderPath);
  const folderStats = await stat(resolvedPath);

  if (!folderStats.isDirectory()) {
    throw new Error('O caminho escolhido não é uma pasta.');
  }

  const entries = await readdir(resolvedPath, { withFileTypes: true });
  const rawFiles = entries
    .filter((entry) => entry.isFile() && rawExtensions.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => ({
      name: entry.name,
      path: path.join(resolvedPath, entry.name),
      stem: path.parse(entry.name).name.toLowerCase()
    }));

  selectedFolder = resolvedPath;
  photos = entries
    .filter((entry) => entry.isFile() && supportedExtensions.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => ({
      name: entry.name,
      path: path.join(resolvedPath, entry.name),
      rawFiles: rawFiles.filter((rawFile) => rawFile.stem === path.parse(entry.name).name.toLowerCase())
    }))
    .sort((left, right) => naturalSort(left.name, right.name));

  const folderCacheKey = createHash('sha1').update(selectedFolder).digest('hex').slice(0, 8);
  const folderName = path.basename(selectedFolder) || 'folder';
  const folderCacheDirectory = path.join(imageCacheDirectory, `${folderName}-${folderCacheKey}`);
  await mkdir(folderCacheDirectory, { recursive: true });

  for (let index = 0; index < photos.length; index += 4) {
    await Promise.all(
      photos.slice(index, index + 4).map((photo) => prepareImages(photo, folderCacheDirectory))
    );
  }

  return {
    folder: selectedFolder,
    count: photos.length,
    photos: photos.map(clientPhoto)
  };
}

function getPhoto(indexValue) {
  const index = Number(indexValue);

  if (!Number.isInteger(index) || index < 0 || index >= photos.length) {
    return null;
  }

  return { index, ...photos[index] };
}

function displayValue(value) {
  if (value === undefined || value === null || value === '') {
    return '—';
  }

  return String(value);
}

app.get('/api/select-folder', async (_request, response) => {
  try {
    const { stdout } = await execFileAsync('osascript', [
      '-e',
      'POSIX path of (choose folder with prompt "Escolhe a pasta com as fotografias")'
    ]);
    response.json(await loadFolder(stdout.trim()));
  } catch (error) {
    if (error.code === 1) {
      return response.status(400).json({ error: 'Seleção cancelada.' });
    }

    response.status(500).json({ error: error.message || 'Não foi possível abrir a pasta.' });
  }
});

app.post('/api/folder', async (request, response) => {
  try {
    if (!request.body?.path || typeof request.body.path !== 'string') {
      return response.status(400).json({ error: 'Indica o caminho da pasta.' });
    }

    response.json(await loadFolder(request.body.path));
  } catch (error) {
    response.status(400).json({ error: error.message || 'Não foi possível abrir a pasta.' });
  }
});

app.get('/api/photos/:index', async (request, response) => {
  const photo = getPhoto(request.params.index);

  if (!photo) {
    return response.status(404).json({ error: 'Fotografia não encontrada.' });
  }

  try {
    const metadata = await exiftool.read(photo.path);
    response.json({
      index: photo.index,
      total: photos.length,
      imageUrl: `/api/photos/${photo.index}/preview?v=${photo.cacheKey}`,
      rawFiles: photo.rawFiles.map((rawFile) => rawFile.name),
      metadata: {
        FileName: photo.name,
        ExposureProgram: displayValue(metadata.ExposureProgram),
        ExposureMode: displayValue(metadata.ExposureMode),
        Aperture: displayValue(metadata.Aperture),
        ShutterSpeed: displayValue(metadata.ShutterSpeed),
        ISO: displayValue(metadata.ISO),
        FocalLength: displayValue(metadata.FocalLength),
        Model: displayValue(metadata.Model),
        LensModel: displayValue(metadata.LensModel)
      }
    });
  } catch (error) {
    response.status(500).json({ error: `Não foi possível ler os dados EXIF: ${error.message}` });
  }
});

app.get('/api/photos/:index/file', (request, response) => {
  const photo = getPhoto(request.params.index);

  if (!photo) {
    return response.status(404).end();
  }

  response.set('Cache-Control', 'public, max-age=31536000, immutable');
  response.sendFile(photo.path);
});

app.get('/api/photos/:index/thumbnail', (request, response) => {
  const photo = getPhoto(request.params.index);

  if (!photo) {
    return response.status(404).end();
  }

  response.set('Cache-Control', 'public, max-age=31536000, immutable');
  response.sendFile(photo.thumbnailPath);
});

app.get('/api/photos/:index/preview', (request, response) => {
  const photo = getPhoto(request.params.index);

  if (!photo) {
    return response.status(404).end();
  }

  response.set('Cache-Control', 'public, max-age=31536000, immutable');
  response.sendFile(photo.previewPath);
});

app.delete('/api/photos/:index', async (request, response) => {
  const photo = getPhoto(request.params.index);

  if (!photo) {
    return response.status(404).json({ error: 'Fotografia não encontrada.' });
  }

  try {
    await trash([photo.path, ...photo.rawFiles.map((rawFile) => rawFile.path)]);
    await Promise.all([
      unlink(photo.thumbnailPath).catch(() => {}),
      unlink(photo.previewPath).catch(() => {})
    ]);
    photos.splice(photo.index, 1);
    response.json({
      deleted: photo.name,
      deletedRawFiles: photo.rawFiles.map((rawFile) => rawFile.name),
      count: photos.length,
      nextIndex: photos.length ? Math.min(photo.index, photos.length - 1) : null,
      photos: photos.map(clientPhoto)
    });
  } catch (error) {
    response.status(500).json({ error: `Não foi possível mover a fotografia para o Lixo: ${error.message}` });
  }
});

app.get('/api/status', (_request, response) => {
  response.json({
    folder: selectedFolder,
    count: photos.length,
    photos: photos.map(clientPhoto)
  });
});

const server = app.listen(port, host, (error) => {
  if (error) {
    console.error(`Não foi possível iniciar a aplicação: ${error.message}`);
    exiftool.end().finally(() => process.exit(1));
    return;
  }

  console.log(`Photo EXIF Reviewer disponível em http://${host}:${port}`);
});

async function shutdown() {
  server.close();
  await exiftool.end();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
