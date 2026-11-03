// Compila os auxiliares nativos em Swift. Corre no postinstall e nunca faz
// falhar a instalação: sem o do Vision a app volta ao agrupamento por dHash, e
// sem o do Lixo o apagar continua a funcionar mas deixa de poder ser anulado.
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const auxiliares = [
  {
    nome: 'Vision',
    source: path.join(root, 'vision', 'featureprint.swift'),
    output: path.join(root, 'vision', 'featureprint'),
    semEle: 'O agrupamento vai usar apenas o hash percetual (dHash).'
  },
  {
    nome: 'Lixo',
    source: path.join(root, 'native', 'trashitem.swift'),
    output: path.join(root, 'native', 'trashitem'),
    semEle: 'Apagar continua a funcionar, mas sem a opção de anular.'
  }
];

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

function desistir(motivo) {
  console.warn(`[nativo] ${motivo}`);
  auxiliares.forEach((a) => console.warn(`[nativo] ${a.semEle}`));
  process.exit(0);
}

if (process.platform !== 'darwin') {
  desistir('Os auxiliares nativos só existem no macOS.');
}

if (!(await run('swiftc', ['--version'])).ok) {
  desistir('Não encontrei o swiftc. Instala as Command Line Tools com: xcode-select --install');
}

for (const auxiliar of auxiliares) {
  const build = await run('swiftc', ['-O', '-o', auxiliar.output, auxiliar.source]);

  if (!build.ok) {
    console.warn(`[nativo] A compilação do auxiliar ${auxiliar.nome} falhou:\n${build.stderr}`);
    console.warn(`[nativo] ${auxiliar.semEle}`);
    continue;
  }

  await access(auxiliar.output);
  console.log(`[nativo] Auxiliar ${auxiliar.nome} compilado.`);
}
