// Compila o auxiliar do framework Vision. Corre no postinstall e nunca faz
// falhar a instalação: sem ele a app volta ao agrupamento por dHash.
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'vision', 'featureprint.swift');
const output = path.join(root, 'vision', 'featureprint');

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', () => resolve({ ok: false, stderr: `${command} não está disponível` }));
    child.on('close', (code) => resolve({ ok: code === 0, stderr: stderr.trim() }));
  });
}

function skip(reason) {
  console.warn(`[vision] ${reason}`);
  console.warn('[vision] O agrupamento vai usar apenas o hash percetual (dHash).');
  process.exit(0);
}

if (process.platform !== 'darwin') {
  skip('O auxiliar Vision só existe no macOS.');
}

if (!(await run('swiftc', ['--version'])).ok) {
  skip('Não encontrei o swiftc. Instala as Command Line Tools com: xcode-select --install');
}

const build = await run('swiftc', ['-O', '-o', output, source]);

if (!build.ok) {
  console.warn(`[vision] A compilação falhou:\n${build.stderr}`);
  skip('Continuo sem o auxiliar.');
}

await access(output);
console.log('[vision] Auxiliar compilado: agrupamento por semelhança visual ativo.');
