import { spawn } from 'node:child_process';
import { access, copyFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDirectory = path.dirname(fileURLToPath(import.meta.url));
const helperPath = path.join(appDirectory, 'native', 'trashitem');

let availability = null;

export async function isAvailable() {
  if (availability === null) {
    availability = await access(helperPath).then(() => true).catch(() => false);
  }

  return availability;
}

// Devolve [{ path, trashed }] ou [{ path, error }] por ficheiro. O caminho de
// destino no Lixo é o que permite anular: o macOS renomeia em caso de colisão,
// com um sufixo de hora que não é possível adivinhar.
export async function trashItems(paths) {
  if (!paths.length || !(await isAvailable())) {
    return null;
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
        reject(new Error(stderr.trim() || `o auxiliar do Lixo terminou com o código ${code}`));
      }
    });

    child.stdin.end(`${paths.join('\n')}\n`);
  });

  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// Repõe um ficheiro que está no Lixo. Recusa-se a sobrescrever: se já existe algo
// no destino, o ficheiro fica no Lixo e quem chama decide o que dizer.
export async function restoreItem(from, to) {
  await access(from);

  if (await access(to).then(() => true).catch(() => false)) {
    throw new Error(`já existe um ficheiro em ${path.basename(to)}`);
  }

  try {
    await rename(from, to);
  } catch (error) {
    // O Lixo pode estar noutro volume, e aí o rename falha com EXDEV.
    if (error.code !== 'EXDEV') {
      throw error;
    }

    await copyFile(from, to);
    await unlink(from);
  }
}
