import express from 'express';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, realpath, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { exiftool } from 'exiftool-vendored';
import sharp from 'sharp';
import trash from 'trash';
import {
  buildGroups,
  measurePreview,
  measureSubject,
  poolSize,
  readCache,
  runPool,
  scorePhoto,
  writeCache
} from './analysis.js';
import {
  computeFeaturePrints,
  decodeVector,
  encodeVector,
  isAvailable as visionIsAvailable,
  readVectorCache,
  writeVectorCache
} from './featureprint.js';

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
let analysisToken = 0;
let analysisState = { running: false, done: 0, total: 0, stage: null, error: null };
let similarityMode = 'hash';
const analysisEntries = new Map();
const visionVectors = new Map();
const visionMetrics = new Map();

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

  // As derivadas ficam com a data exata do original, e exigimos igualdade: um
  // ficheiro substituído por uma versão mais antiga (restauro de backup) também
  // invalida a cache, ao contrário de uma simples comparação "mais recente que".
  const isStale = (stats) => !stats || Math.abs(stats.mtimeMs - sourceStats.mtimeMs) > 1;

  if (isStale(thumbnailStats) || isStale(previewStats)) {
    // Um único decode do original (com shrink-on-load): a miniatura sai depois
    // do preview já reduzido, em vez de voltar a descodificar o ficheiro.
    const previewBuffer = await sharp(photo.path, { failOn: 'none' })
      .rotate()
      .resize(2048, 1536, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 84 })
      .toBuffer();

    await Promise.all([
      writeFile(previewPath, previewBuffer),
      sharp(previewBuffer)
        .resize(320, 220, { fit: 'cover' })
        .jpeg({ quality: 72 })
        .toFile(thumbnailPath)
    ]);
    await Promise.all([
      utimes(previewPath, sourceStats.atime, sourceStats.mtime),
      utimes(thumbnailPath, sourceStats.atime, sourceStats.mtime)
    ]);
  }

  photo.size = sourceStats.size;
  photo.mtimeMs = sourceStats.mtimeMs;
  photo.cacheKey = cacheKey;
  photo.thumbnailPath = thumbnailPath;
  photo.previewPath = previewPath;
}

function capturedAtFrom(metadata) {
  const value = metadata.SubSecDateTimeOriginal || metadata.DateTimeOriginal || metadata.CreateDate;

  if (!value) {
    return null;
  }

  if (typeof value.toDate === 'function') {
    return value.toDate().getTime();
  }

  const parsed = Date.parse(String(value).replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3'));
  return Number.isFinite(parsed) ? parsed : null;
}

// Segunda fase da análise: framework Vision sobre os previews já em cache (dão
// a mesma distância que os originais). De uma só passagem saem o vetor de
// semelhança, a pontuação estética, a qualidade dos rostos, o horizonte e a
// zona do assunto — depois mede-se a nitidez nessa zona.
async function analyseVision(cacheDirectory, token) {
  if (!(await visionIsAvailable())) {
    similarityMode = 'hash';
    return;
  }

  const cached = await readVectorCache(cacheDirectory);

  visionVectors.clear();
  visionMetrics.clear();

  const reused = new Set();
  let pending = photos.filter((photo) => {
    const entry = cached.photos[photo.name];
    const vector = entry && entry.size === photo.size && entry.mtimeMs === photo.mtimeMs && cached.revision
      ? decodeVector(entry.data)
      : null;

    if (!vector) {
      return true;
    }

    visionVectors.set(photo.name, vector);
    visionMetrics.set(photo.name, entry.metrics || {});
    reused.add(photo.name);
    return false;
  });

  if (token !== analysisToken) {
    return;
  }

  analysisState = { ...analysisState, stage: 'semelhanca', done: photos.length - pending.length, total: photos.length };

  let revision = cached.revision;

  async function extract(targets) {
    const byPreview = new Map(targets.map((photo) => [photo.previewPath, photo]));
    const result = await computeFeaturePrints([...byPreview.keys()]);

    result.vectors.forEach((vector, previewPath) => {
      const photo = byPreview.get(previewPath);

      if (photo) {
        visionVectors.set(photo.name, vector);
        visionMetrics.set(photo.name, result.metrics.get(previewPath) || {});
      }
    });

    // A nitidez na zona do assunto precisa da caixa de saliência, por isso só
    // pode ser medida depois do Vision responder.
    await runPool(targets.filter((photo) => visionMetrics.get(photo.name)?.saliency), async (photo) => {
      const metrics = visionMetrics.get(photo.name);
      const sharpnessSubject = await measureSubject(photo.previewPath, metrics.saliency).catch(() => null);

      if (Number.isFinite(sharpnessSubject)) {
        visionMetrics.set(photo.name, { ...metrics, sharpnessSubject });
      }
    });

    return result.revision;
  }

  if (pending.length) {
    const found = await extract(pending);

    if (token !== analysisToken) {
      return;
    }

    // Uma revisão diferente do Vision produz vetores que não são comparáveis com
    // os guardados: nesse caso os reaproveitados não servem e repete-se tudo.
    if (found && cached.revision && found !== cached.revision && reused.size) {
      pending = photos.filter((photo) => reused.has(photo.name));
      reused.forEach((name) => {
        visionVectors.delete(name);
        visionMetrics.delete(name);
      });
      await extract(pending);

      if (token !== analysisToken) {
        return;
      }
    }

    revision = found || revision;
    analysisState = { ...analysisState, done: photos.length };
  }

  if (!visionVectors.size) {
    similarityMode = 'hash';
  } else {
    similarityMode = visionVectors.size === photos.length ? 'vision' : 'parcial';
  }

  await writeVectorCache(cacheDirectory, revision, Object.fromEntries(
    photos
      .filter((photo) => visionVectors.has(photo.name))
      .map((photo) => [photo.name, {
        size: photo.size,
        mtimeMs: photo.mtimeMs,
        data: encodeVector(visionVectors.get(photo.name)),
        metrics: visionMetrics.get(photo.name) || {}
      }])
  ));
}

async function analyseFolder(folderPath, cacheDirectory, token) {
  const cached = await readCache(folderPath);

  // Entretanto pode ter sido aberta outra pasta: esta análise já não vale e não
  // pode apagar os resultados da nova.
  if (token !== analysisToken) {
    return;
  }

  const pending = [];

  analysisEntries.clear();

  photos.forEach((photo) => {
    const entry = cached[photo.name];

    if (entry && entry.size === photo.size && entry.mtimeMs === photo.mtimeMs && entry.measurements) {
      analysisEntries.set(photo.name, entry);
    } else {
      pending.push(photo);
    }
  });

  analysisState = { running: true, done: photos.length - pending.length, total: photos.length, stage: 'medidas', error: null };

  try {
    await runPool(pending, async (photo) => {
      if (token !== analysisToken) {
        return;
      }

      const [measurements, metadata] = await Promise.all([
        measurePreview(photo.previewPath),
        exiftool.read(photo.path).catch(() => ({}))
      ]);

      analysisEntries.set(photo.name, {
        size: photo.size,
        mtimeMs: photo.mtimeMs,
        capturedAt: capturedAtFrom(metadata) ?? photo.mtimeMs,
        exif: {
          iso: metadata.ISO ?? null,
          focalLength: metadata.FocalLength ?? null,
          exposureTime: metadata.ExposureTime ?? metadata.ShutterSpeed ?? null
        },
        measurements
      });
      analysisState.done += 1;
    });

    if (token !== analysisToken) {
      return;
    }

    await writeCache(folderPath, Object.fromEntries(analysisEntries));
    await analyseVision(cacheDirectory, token);

    if (token !== analysisToken) {
      return;
    }

    analysisState = { ...analysisState, running: false, stage: null, done: analysisState.total };
  } catch (error) {
    if (token === analysisToken) {
      analysisState = { ...analysisState, running: false, stage: null, error: error.message };
    }
  }
}

function composeAnalysis() {
  const scored = photos
    .map((photo) => {
      const entry = analysisEntries.get(photo.name);

      if (!entry) {
        return null;
      }

      const { score, parts, flags } = scorePhoto(entry.measurements, entry.exif || {}, visionMetrics.get(photo.name) || {});
      return {
        name: photo.name,
        capturedAt: entry.capturedAt,
        measurements: entry.measurements,
        vector: visionVectors.get(photo.name),
        score,
        parts,
        flags
      };
    })
    .filter(Boolean);
  const groups = buildGroups(scored);
  const result = {};

  scored.forEach((entry) => {
    const group = groups.get(entry.name) || { groupId: null, groupSize: 1, isGroupBest: true, groupRank: 1 };
    result[entry.name] = {
      score: entry.score,
      parts: entry.parts,
      flags: entry.flags,
      capturedAt: entry.capturedAt,
      ...group
    };
  });

  return result;
}

function clientPhoto(photo, index) {
  return {
    index,
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

  await runPool(photos, (photo) => prepareImages(photo, folderCacheDirectory));

  const token = ++analysisToken;
  analysisState = { running: true, done: 0, total: photos.length, stage: 'medidas', error: null };
  analyseFolder(selectedFolder, folderCacheDirectory, token);

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

app.get('/api/analysis', (_request, response) => {
  response.json({
    running: analysisState.running,
    done: analysisState.done,
    total: analysisState.total,
    stage: analysisState.stage,
    similarity: similarityMode,
    error: analysisState.error,
    photos: composeAnalysis()
  });
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
    analysisEntries.delete(photo.name);
    visionVectors.delete(photo.name);
    visionMetrics.delete(photo.name);
    analysisState.total = Math.max(0, analysisState.total - 1);
    analysisState.done = Math.min(analysisState.done, analysisState.total);
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

  console.log(`Photo EXIF Reviewer disponível em http://${host}:${port} (${poolSize} imagens em paralelo)`);
});

async function shutdown() {
  server.close();
  await exiftool.end();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
