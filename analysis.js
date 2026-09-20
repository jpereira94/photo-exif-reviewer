import { readFile, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { distance as featurePrintDistance } from './featureprint.js';

// Numa pasta grande percorremos cada ficheiro uma só vez: a cache interna do
// libvips não é reaproveitada e só ocuparia memória.
sharp.cache({ memory: 192, files: 0, items: 128 });
// Uma thread de libvips por pipeline e várias imagens em paralelo rende mais
// do que uma imagem de cada vez espalhada por todos os cores.
sharp.concurrency(1);

export const poolSize = Math.max(2, Math.min(8, availableParallelism()));

const cacheFileName = '.photo-reviewer.json';
const cacheVersion = 3;
// Largura a que a luminância é analisada. Fixa, para que a nitidez de duas
// fotografias seja comparável independentemente da resolução original.
const analysisWidth = 1024;
const hashWidth = 9;
const hashHeight = 8;

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

export async function runPool(items, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function consume() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(poolSize, items.length) }, consume));
  return results;
}

function boxDownsample(grey, width, height, stride, targetWidth, targetHeight) {
  const output = new Float64Array(targetWidth * targetHeight);

  for (let ty = 0; ty < targetHeight; ty += 1) {
    const startY = Math.floor((ty * height) / targetHeight);
    const endY = Math.max(startY + 1, Math.floor(((ty + 1) * height) / targetHeight));

    for (let tx = 0; tx < targetWidth; tx += 1) {
      const startX = Math.floor((tx * width) / targetWidth);
      const endX = Math.max(startX + 1, Math.floor(((tx + 1) * width) / targetWidth));
      let sum = 0;

      for (let y = startY; y < endY; y += 1) {
        const row = y * width * stride;

        for (let x = startX; x < endX; x += 1) {
          sum += grey[row + x * stride];
        }
      }

      output[ty * targetWidth + tx] = sum / ((endY - startY) * (endX - startX));
    }
  }

  return output;
}

function differenceHash(grey, width, height, stride) {
  const reduced = boxDownsample(grey, width, height, stride, hashWidth, hashHeight);
  let hash = '';

  for (let y = 0; y < hashHeight; y += 1) {
    let byte = 0;

    for (let x = 0; x < hashWidth - 1; x += 1) {
      byte = (byte << 1) | (reduced[y * hashWidth + x] > reduced[y * hashWidth + x + 1] ? 1 : 0);
    }

    hash += byte.toString(16).padStart(2, '0');
  }

  // Quando a imagem reduzida é quase plana (céu liso, parede, nevoeiro) o hash
  // resume-se ao sinal de diferenças mínimas e cenas distintas colidem. Guardar
  // a dispersão permite desconfiar dele nesses casos.
  const mean = reduced.reduce((total, value) => total + value, 0) / reduced.length;
  const structure = Math.sqrt(
    reduced.reduce((total, value) => total + (value - mean) ** 2, 0) / reduced.length
  );

  return { hash, structure };
}

export function hammingDistance(left, right) {
  if (!left || !right || left.length !== right.length) {
    return 64;
  }

  let distance = 0;

  for (let index = 0; index < left.length; index += 2) {
    let bits = parseInt(left.slice(index, index + 2), 16) ^ parseInt(right.slice(index, index + 2), 16);

    while (bits) {
      bits &= bits - 1;
      distance += 1;
    }
  }

  return distance;
}

// Variância do Laplaciano: a medida clássica de foco. Calculada à mão sobre a
// luminância porque o convolve do sharp corta os valores negativos a zero.
function laplacianVariance(grey, width, height, stride) {
  let sum = 0;
  let sumSquares = 0;
  let count = 0;

  for (let y = 1; y < height - 1; y += 1) {
    const row = y * width * stride;
    const previousRow = row - width * stride;
    const nextRow = row + width * stride;

    for (let x = 1; x < width - 1; x += 1) {
      const offset = x * stride;
      const value = 4 * grey[row + offset]
        - grey[previousRow + offset]
        - grey[nextRow + offset]
        - grey[row + offset - stride]
        - grey[row + offset + stride];

      sum += value;
      sumSquares += value * value;
      count += 1;
    }
  }

  if (!count) {
    return 0;
  }

  const mean = sum / count;
  return Math.max(0, sumSquares / count - mean * mean);
}

function luminanceStatistics(grey, width, height, stride) {
  const histogram = new Uint32Array(256);
  const total = width * height;

  for (let y = 0; y < height; y += 1) {
    const row = y * width * stride;

    for (let x = 0; x < width; x += 1) {
      histogram[grey[row + x * stride]] += 1;
    }
  }

  let sum = 0;
  let clippedShadows = 0;
  let clippedHighlights = 0;

  for (let value = 0; value < 256; value += 1) {
    sum += value * histogram[value];

    if (value <= 4) {
      clippedShadows += histogram[value];
    }

    if (value >= 251) {
      clippedHighlights += histogram[value];
    }
  }

  const mean = sum / total;
  let variance = 0;

  for (let value = 0; value < 256; value += 1) {
    variance += histogram[value] * (value - mean) ** 2;
  }

  return {
    mean,
    contrast: Math.sqrt(variance / total),
    clippedShadows: clippedShadows / total,
    clippedHighlights: clippedHighlights / total
  };
}

export async function measurePreview(previewPath) {
  const { data, info } = await sharp(previewPath, { failOn: 'none' })
    .resize({ width: analysisWidth, withoutEnlargement: true })
    .toColourspace('b-w')
    .raw()
    .toBuffer({ resolveWithObject: true });
  const stride = info.channels;

  return {
    sharpness: laplacianVariance(data, info.width, info.height, stride),
    ...differenceHash(data, info.width, info.height, stride),
    ...luminanceStatistics(data, info.width, info.height, stride)
  };
}

// Nitidez medida só na zona do assunto que a saliência do Vision indicou. O
// recorte é reduzido pelo mesmo fator que o fotograma inteiro, para que os dois
// valores sejam comparáveis: caso contrário o assunto saía ampliado e a sua
// variância de Laplaciano vinha inflacionada.
export async function measureSubject(previewPath, saliency) {
  if (!saliency || !(saliency.w > 0.05) || !(saliency.h > 0.05)) {
    return null;
  }

  const image = sharp(previewPath, { failOn: 'none' });
  const { width, height } = await image.metadata();

  if (!width || !height) {
    return null;
  }

  // A origem da caixa do Vision é em baixo à esquerda; a do sharp é em cima.
  const left = Math.max(0, Math.round(saliency.x * width));
  const top = Math.max(0, Math.round((1 - saliency.y - saliency.h) * height));
  const cropWidth = Math.min(width - left, Math.round(saliency.w * width));
  const cropHeight = Math.min(height - top, Math.round(saliency.h * height));

  if (cropWidth < 16 || cropHeight < 16) {
    return null;
  }

  const scale = Math.min(1, analysisWidth / width);
  const { data, info } = await image
    .extract({ left, top, width: cropWidth, height: cropHeight })
    .resize({ width: Math.max(8, Math.round(cropWidth * scale)), withoutEnlargement: true })
    .toColourspace('b-w')
    .raw()
    .toBuffer({ resolveWithObject: true });

  return laplacianVariance(data, info.width, info.height, info.channels);
}

function exposureSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const fraction = value.match(/^1\/([\d.]+)$/);

  if (fraction) {
    return 1 / Number(fraction[1]);
  }

  const seconds = Number.parseFloat(value);
  return Number.isFinite(seconds) ? seconds : null;
}

function numericValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// Mapeia a overallScore do Vision (aproximadamente -1..1) para 0..1.
// PROVISÓRIO: calibrado numa só fotografia degradada de propósito — nítida 0,74,
// desfoque forte -0,05, sobrexposta 0,47, subexposta -0,04.
function aestheticsScore(value) {
  return clamp01((value + 0.25) / 1);
}

export function scorePhoto(measurements, exif, vision = {}) {
  // Quando a saliência indicou o assunto, é aí que a nitidez conta; medir no
  // fotograma inteiro faz um céu liso passar por desfocado.
  const laplacian = Number.isFinite(vision.sharpnessSubject)
    ? vision.sharpnessSubject
    : measurements.sharpness;
  // 10 → desfocada, ~2000 → muito nítida. Escala logarítmica porque a variância
  // do Laplaciano cresce por ordens de grandeza entre uma e outra.
  const sharpness = clamp01((Math.log10(laplacian + 1) - 1) / 2.3);
  const highlightPenalty = clamp01((measurements.clippedHighlights - 0.002) / 0.05);
  const shadowPenalty = clamp01((measurements.clippedShadows - 0.02) / 0.15);
  const exposure = clamp01(1 - 0.65 * highlightPenalty - 0.35 * shadowPenalty);
  const contrast = measurements.contrast < 40
    ? clamp01(measurements.contrast / 40)
    : clamp01(1 - (measurements.contrast - 70) / 60);

  const iso = numericValue(exif.iso);
  const focal = numericValue(exif.focalLength);
  const shutter = exposureSeconds(exif.exposureTime);
  const isoPenalty = iso && iso > 800 ? clamp01(Math.log2(iso / 800) / 4) : 0;
  // Regra do 1/distância focal: abaixo dela cresce o risco de tremido.
  const shakePenalty = focal && shutter && shutter * focal > 1
    ? clamp01(Math.log2(shutter * focal) / 3)
    : 0;
  const technical = clamp01(1 - 0.5 * isoPenalty - 0.5 * shakePenalty);

  const faceQualities = Array.isArray(vision.faces) ? vision.faces : [];
  const faces = faceQualities.length
    ? clamp01(faceQualities.reduce((total, value) => total + value, 0) / faceQualities.length)
    : null;
  const aesthetics = Number.isFinite(vision.aesthetics) ? aestheticsScore(vision.aesthetics) : null;

  const flags = [];

  if (sharpness < 0.35) {
    flags.push('desfocada');
  }

  if (faceQualities.length && Math.min(...faceQualities) < 0.3) {
    flags.push(faceQualities.length === 1 ? 'rosto com pouca qualidade' : 'algum rosto com pouca qualidade');
  }

  // O horizonte nem sempre é detetado; quando é, um desvio acima de 3° nota-se.
  if (Number.isFinite(vision.horizon) && Math.abs(vision.horizon) > 3 * (Math.PI / 180)) {
    flags.push(`horizonte torto (${(vision.horizon * 180 / Math.PI).toFixed(1)}°)`);
  }

  if (highlightPenalty > 0.5) {
    flags.push('altas luzes queimadas');
  }

  if (shadowPenalty > 0.5) {
    flags.push('sombras esmagadas');
  }

  if (isoPenalty > 0.5) {
    flags.push('ISO alto');
  }

  if (shakePenalty > 0.5) {
    flags.push('risco de tremido');
  }

  // Os pesos são renormalizados pelas componentes disponíveis, para que uma
  // fotografia sem rostos, ou analisada sem o Vision, continue comparável.
  const components = [
    { key: 'sharpness', value: sharpness, weight: 0.28 },
    { key: 'exposure', value: exposure, weight: 0.18 },
    { key: 'contrast', value: contrast, weight: 0.09 },
    { key: 'technical', value: technical, weight: 0.15 },
    { key: 'aesthetics', value: aesthetics, weight: 0.3 },
    { key: 'faces', value: faces, weight: 0.15 }
  ].filter((component) => component.value !== null);

  const totalWeight = components.reduce((total, component) => total + component.weight, 0);
  const score = components.reduce((total, component) => total + component.weight * component.value, 0) / totalWeight;
  const parts = {};

  components.forEach((component) => {
    parts[component.key] = Math.round(100 * component.value);
  });

  return { score: Math.round(100 * score), parts, flags };
}

const burstGapMs = 2500;
const burstDistance = 18;
const sceneGapMs = 180_000;
const sceneDistance = 10;
const sceneLookahead = 6;
// Abaixo disto a imagem reduzida não tem estrutura suficiente para o hash
// distinguir cenas: só agrupamos por proximidade temporal.
const minimumStructure = 4;
// Limiares para os vetores do Vision (distância euclidiana, 0 = idêntico).
// PROVISÓRIOS: calibrados apenas contra um par real conhecido (duas fotografias
// do mesmo avião a rolar, que dão 0,24) e um par não relacionado (~1,28). Faltam
// pares negativos reais para os fixar com confiança.
const visionBurstDistance = 0.6;
const visionSceneDistance = 0.35;

export function buildGroups(entries) {
  const ordered = [...entries]
    .filter((entry) => entry.measurements)
    .sort((left, right) => (left.capturedAt ?? 0) - (right.capturedAt ?? 0) || left.name.localeCompare(right.name));
  const parent = ordered.map((_entry, index) => index);

  function find(index) {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }

    return index;
  }

  function union(left, right) {
    const leftRoot = find(left);
    const rightRoot = find(right);

    if (leftRoot !== rightRoot) {
      parent[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
    }
  }

  for (let index = 0; index < ordered.length; index += 1) {
    for (let ahead = 1; ahead <= sceneLookahead && index + ahead < ordered.length; ahead += 1) {
      const current = ordered[index];
      const other = ordered[index + ahead];
      const gap = current.capturedAt && other.capturedAt
        ? Math.abs(other.capturedAt - current.capturedAt)
        : Number.POSITIVE_INFINITY;

      if (gap > sceneGapMs) {
        break;
      }

      // Os vetores do Vision descrevem a cena e aguentam o assunto mudar de
      // sítio no enquadramento, coisa que o dHash não faz. Quando existem, mandam.
      if (current.vector && other.vector) {
        const visionGap = featurePrintDistance(current.vector, other.vector);

        if (visionGap <= (gap <= burstGapMs ? visionBurstDistance : visionSceneDistance)) {
          union(index, index + ahead);
        }

        continue;
      }

      const distance = hammingDistance(current.measurements.hash, other.measurements.hash);
      const reliableHash = Math.min(current.measurements.structure ?? 0, other.measurements.structure ?? 0) >= minimumStructure;

      if (gap <= burstGapMs && (!reliableHash || distance <= burstDistance)) {
        union(index, index + ahead);
      } else if (reliableHash && distance <= sceneDistance) {
        union(index, index + ahead);
      }
    }
  }

  const groups = new Map();

  ordered.forEach((entry, index) => {
    const root = find(index);

    if (!groups.has(root)) {
      groups.set(root, []);
    }

    groups.get(root).push(entry);
  });

  const result = new Map();

  [...groups.values()]
    .sort((left, right) => (left[0].capturedAt ?? 0) - (right[0].capturedAt ?? 0))
    .forEach((members, groupIndex) => {
      const best = members.reduce((winner, entry) => (entry.score > winner.score ? entry : winner));

      members.forEach((entry) => {
        result.set(entry.name, {
          groupId: groupIndex,
          groupSize: members.length,
          isGroupBest: entry.name === best.name,
          groupRank: [...members].sort((left, right) => right.score - left.score).findIndex((item) => item.name === entry.name) + 1
        });
      });
    });

  return result;
}

export async function readCache(folder) {
  try {
    const raw = JSON.parse(await readFile(path.join(folder, cacheFileName), 'utf8'));
    return raw.version === cacheVersion && raw.photos ? raw.photos : {};
  } catch {
    return {};
  }
}

export async function writeCache(folder, photos) {
  try {
    await writeFile(
      path.join(folder, cacheFileName),
      `${JSON.stringify({ version: cacheVersion, updatedAt: new Date().toISOString(), photos }, null, 2)}\n`,
      'utf8'
    );
  } catch {
    // A pasta pode ser só de leitura: a análise continua a valer para a sessão.
  }
}
