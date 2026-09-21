// Gera dist/Photo EXIF Reviewer.app: uma janela nativa em WKWebView com o
// runtime Node e as dependências lá dentro, para não depender do PATH do shell
// (o node deste Mac vem do nvm, que uma app lançada pelo Finder não vê).
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nome = 'Photo EXIF Reviewer';
const bundle = path.join(root, 'dist', `${nome}.app`);
const macos = path.join(bundle, 'Contents', 'MacOS');
const recursos = path.join(bundle, 'Contents', 'Resources');
const destinoApp = path.join(recursos, 'app');

function correr(comando, args, opcoes = {}) {
  return new Promise((resolve, reject) => {
    const filho = spawn(comando, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opcoes });
    let saida = '';
    filho.stdout.on('data', (c) => { saida += c; });
    filho.stderr.on('data', (c) => { saida += c; });
    filho.on('error', reject);
    filho.on('close', (codigo) => {
      if (codigo === 0) {
        resolve(saida.trim());
      } else {
        reject(new Error(`${comando} falhou (${codigo}):\n${saida.trim()}`));
      }
    });
  });
}

const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${nome}</string>
  <key>CFBundleDisplayName</key><string>${nome}</string>
  <key>CFBundleIdentifier</key><string>local.photo-exif-reviewer</string>
  <key>CFBundleExecutable</key><string>PhotoReviewer</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundleVersion</key><string>1.0.0</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>Ferramenta local</string>
  <!-- O servidor corre em http://127.0.0.1 e o WebKit bloqueia http sem isto. -->
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
`;

const svgIcone = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" rx="228" fill="#1b1c18"/>
  <rect x="148" y="264" width="728" height="496" rx="56" fill="none" stroke="#bedc71" stroke-width="42"/>
  <circle cx="512" cy="512" r="132" fill="none" stroke="#bedc71" stroke-width="42"/>
  <circle cx="742" cy="378" r="34" fill="#bedc71"/>
  <path d="M148 640 L342 470 L520 632" fill="none" stroke="#739237" stroke-width="38" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

async function construirIcone() {
  const iconset = await mkdtemp(path.join(tmpdir(), 'photo-reviewer-icon-'));
  const base = Buffer.from(svgIcone);
  const tamanhos = [16, 32, 128, 256, 512];

  await Promise.all(tamanhos.flatMap((tamanho) => [
    sharp(base, { density: 400 }).resize(tamanho, tamanho).png().toFile(path.join(iconset, `icon_${tamanho}x${tamanho}.png`)),
    sharp(base, { density: 400 }).resize(tamanho * 2, tamanho * 2).png().toFile(path.join(iconset, `icon_${tamanho}x${tamanho}@2x.png`))
  ]));

  const comExtensao = `${iconset}.iconset`;
  await cp(iconset, comExtensao, { recursive: true });
  await correr('iconutil', ['-c', 'icns', comExtensao, '-o', path.join(recursos, 'AppIcon.icns')]);
  await rm(iconset, { recursive: true, force: true });
  await rm(comExtensao, { recursive: true, force: true });
}

console.log(`[app] a construir ${nome}.app`);

await rm(path.join(root, 'dist'), { recursive: true, force: true });
await mkdir(macos, { recursive: true });
await mkdir(destinoApp, { recursive: true });

// O auxiliar do Vision tem de existir antes de ser copiado.
await correr('node', [path.join(root, 'scripts', 'build-vision.mjs')]);

console.log('[app] a compilar a janela nativa');
await correr('swiftc', ['-O', '-o', path.join(macos, 'PhotoReviewer'), path.join(root, 'app', 'PhotoReviewer.swift')]);

await writeFile(path.join(bundle, 'Contents', 'Info.plist'), infoPlist, 'utf8');

console.log('[app] a copiar o runtime Node');
await cp(process.execPath, path.join(recursos, 'node'));

console.log('[app] a copiar a aplicação e as dependências');
for (const ficheiro of ['server.js', 'analysis.js', 'featureprint.js', 'package.json']) {
  await cp(path.join(root, ficheiro), path.join(destinoApp, ficheiro));
}
for (const pasta of ['public', 'node_modules']) {
  await cp(path.join(root, pasta), path.join(destinoApp, pasta), { recursive: true });
}
await mkdir(path.join(destinoApp, 'vision'), { recursive: true });
await cp(path.join(root, 'vision', 'featureprint'), path.join(destinoApp, 'vision', 'featureprint'));

console.log('[app] a gerar o ícone');
await construirIcone();

// Assinatura ad-hoc: sem ela o macOS recusa binários arm64 que foram mexidos
// depois de compilados. Como a app é construída aqui, não fica em quarentena e
// não há avisos do Gatekeeper.
console.log('[app] a assinar');
await correr('codesign', ['--force', '--deep', '--sign', '-', bundle]);
await correr('codesign', ['--verify', '--deep', bundle]);

const tamanho = await correr('du', ['-sh', bundle]);
console.log(`[app] pronto: ${bundle}`);
console.log(`[app] tamanho: ${tamanho.split(/\s+/)[0]}`);
console.log('[app] arrasta-a para a pasta Aplicações.');
