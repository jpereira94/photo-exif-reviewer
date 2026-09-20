import { spawn } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDirectory = path.dirname(fileURLToPath(import.meta.url));
const helperPath = path.join(appDirectory, 'vision', 'featureprint');
const cacheFileName = 'featureprints.json';
const cacheVersion = 1;
// O vetor tem 768 floats normalizados; a distância euclidiana entre dois deles é
// exatamente o que o computeDistance do Vision devolve.
const expectedElements = 768;

let availability = null;

export async function isAvailable() {
  if (availability === null) {
    availability = await access(helperPath).then(() => true).catch(() => false);
  }

  return availability;
}

function decode(base64) {
  const buffer = Buffer.from(base64, 'base64');

  if (buffer.byteLength !== expectedElements * 4) {
    return null;
  }

  // O Buffer pode não estar alinhado a 4 bytes, por isso copia-se antes de ler.
  const aligned = new ArrayBuffer(buffer.byteLength);
  Buffer.from(aligned).set(buffer);
  return new Float32Array(aligned);
}

export function distance(left, right) {
  if (!left || !right || left.length !== right.length) {
    return Number.POSITIVE_INFINITY;
  }

  let total = 0;

  for (let index = 0; index < left.length; index += 1) {
    const delta = left[index] - right[index];
    total += delta * delta;
  }

  return Math.sqrt(total);
}

// Devolve { vectors: Map<caminho, Float32Array>, metrics: Map<caminho, medidas>,
// revision, failed: [caminhos] }.
export async function computeFeaturePrints(paths) {
  const vectors = new Map();
  const metrics = new Map();
  const failed = [];
  let revision = 0;

  if (!paths.length || !(await isAvailable())) {
    return { vectors, metrics, revision, failed: paths.slice() };
  }

  const output = await new Promise((resolve, reject) => {
    const child = spawn(helperPath, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr.trim() || `o auxiliar Vision terminou com o código ${code}`));
      }
    });

    child.stdin.end(`${paths.join('\n')}\n`);
  });

  output.split('\n').filter(Boolean).forEach((line) => {
    let entry;

    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }

    const vector = entry.data ? decode(entry.data) : null;

    if (!vector) {
      failed.push(entry.path);
      return;
    }

    vectors.set(entry.path, vector);
    revision = entry.revision || revision;
    metrics.set(entry.path, {
      aesthetics: Number.isFinite(entry.aesthetics) ? entry.aesthetics : null,
      isUtility: entry.isUtility ?? null,
      faces: Array.isArray(entry.faces) ? entry.faces.filter(Number.isFinite) : [],
      horizon: Number.isFinite(entry.horizon) ? entry.horizon : null,
      saliency: entry.saliency ?? null
    });
  });

  return { vectors, metrics, revision, failed };
}

// Os vetores ficam na pasta de cache temporária, ao lado dos previews de que
// foram extraídos: são 3 KB por fotografia e não têm lugar na pasta do utilizador.
export async function readVectorCache(cacheDirectory) {
  try {
    const raw = JSON.parse(await readFile(path.join(cacheDirectory, cacheFileName), 'utf8'));

    if (raw.version !== cacheVersion) {
      return { revision: 0, photos: {} };
    }

    return { revision: raw.revision || 0, photos: raw.photos || {} };
  } catch {
    return { revision: 0, photos: {} };
  }
}

export async function writeVectorCache(cacheDirectory, revision, photos) {
  try {
    await mkdir(cacheDirectory, { recursive: true });
    await writeFile(
      path.join(cacheDirectory, cacheFileName),
      JSON.stringify({ version: cacheVersion, revision, photos }),
      'utf8'
    );
  } catch {
    // Sem cache de vetores a análise repete-se na abertura seguinte, mais nada.
  }
}

export function encodeVector(vector) {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('base64');
}

export { decode as decodeVector };
