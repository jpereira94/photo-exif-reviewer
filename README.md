# Photo EXIF Reviewer

Pequena aplicação local para macOS que permite escolher uma pasta, rever fotografias JPG/JPEG, consultar os principais dados EXIF, comparar imagens e mover fotografias rejeitadas para o Lixo.

## Requisitos

- macOS
- Node.js 18 ou superior

Não é necessário instalar o `exiftool` através do Homebrew: a dependência `exiftool-vendored` instala e utiliza uma versão própria do ExifTool.

Ao escolher uma pasta, a app gera automaticamente:

- thumbnails de 320 × 220 px para a faixa inferior;
- previews com um máximo de 2048 × 1536 px para a vista principal e comparação.

Estes ficheiros são guardados na pasta temporária do macOS, organizados por pasta original e com nomes legíveis, por exemplo `IMG_0248.JPG-thumbnail.jpg` e `IMG_0248.JPG-preview.jpg`. A primeira abertura de uma pasta pode demorar um pouco enquanto são gerados; nas aberturas seguintes são reutilizados enquanto os JPGs originais não tiverem mudado.

## Instalação

Na pasta do projeto, executa:

```bash
npm install
```

## Executar

```bash
npm start
```

Depois abre no browser:

```text
http://127.0.0.1:4173
```

Para parar a aplicação, volta ao Terminal e pressiona `Ctrl+C`.

## Utilização

1. Clica em **Escolher pasta** e seleciona no Finder a pasta com as fotografias. Também podes colar o caminho completo da pasta.
2. Usa os botões **Anterior** e **Seguinte**, ou as teclas `←` e `→`.
3. Usa as miniaturas na parte inferior para saltar diretamente para uma fotografia ou selecionar várias.
4. Com duas ou mais selecionadas, usa **Comparar** para as ver lado a lado.
5. Usa **Só selecionadas** para fazer Anterior/Seguinte percorrer apenas a seleção.
6. Faz duplo clique na fotografia principal ou numa fotografia em comparação para abrir o original em modo zoom. Usa a roda do rato para ampliar e arrasta para fazer pan.
7. Usa **Mover para o Lixo** ou a tecla `Delete`/`Backspace` para rejeitar a fotografia atual. A app pede confirmação antes de mover os ficheiros.

Ao mover um JPG/JPEG para o Lixo, a app procura na mesma pasta ficheiros RAW com o mesmo nome-base e move-os também. Por exemplo, ao eliminar `IMG_0123.JPG`, também será movido `IMG_0123.CR3`, se existir. A confirmação mostra os RAW encontrados antes da operação.

Formatos RAW reconhecidos: ARW, CR2, CR3, DNG, NEF, NRW, ORF, PEF, RAF, RAW, RW2 e SRW.

A leitura da pasta não é recursiva: são apresentadas apenas as fotografias JPG/JPEG diretamente dentro da pasta escolhida.

## Dados apresentados

- FileName
- ExposureProgram
- ExposureMode
- Aperture
- ShutterSpeed
- ISO
- FocalLength
- Model
- LensModel

Campos que não existam no EXIF são apresentados como `—`.
