# Photo EXIF Reviewer

Pequena aplicação local para macOS que permite escolher uma pasta, rever fotografias JPG/JPEG, consultar os principais dados EXIF, comparar imagens e mover fotografias rejeitadas para o Lixo. Analisa também cada fotografia para agrupar rajadas e quase-duplicados e atribuir uma pontuação de qualidade, para chegares mais depressa às melhores.

## Requisitos

- macOS em Apple Silicon
- Node.js 20.9 ou superior (exigido pelo `sharp`), necessário para construir; a app instalada já traz o seu

Não é necessário instalar o `exiftool` através do Homebrew: a dependência `exiftool-vendored` instala e utiliza uma versão própria do ExifTool.

O agrupamento por semelhança visual usa o framework **Vision** do macOS, através de um pequeno auxiliar em Swift compilado durante o `npm install`. Não há modelos para descarregar — o modelo é o do sistema. Se as Command Line Tools não estiverem instaladas (`xcode-select --install`), a instalação não falha: o aviso é impresso e a app passa a agrupar apenas pelo hash percetual. Para compilar mais tarde, corre `npm run build:vision`.

Ao escolher uma pasta, a app gera automaticamente:

- thumbnails de 320 × 220 px para a faixa inferior;
- previews com um máximo de 2048 × 1536 px para a vista principal e comparação.

Estes ficheiros são guardados na pasta temporária do macOS, organizados por pasta original e com nomes legíveis, por exemplo `IMG_0248.JPG-thumbnail.jpg` e `IMG_0248.JPG-preview.jpg`. A primeira abertura de uma pasta pode demorar um pouco enquanto são gerados; nas aberturas seguintes são reutilizados enquanto os JPGs originais não tiverem mudado.

## Ajuda à escolha

Depois de preparar as imagens, a app analisa cada fotografia em segundo plano (o estado aparece por baixo do caminho da pasta) e produz duas coisas.

**Grupos de fotografias parecidas.** Rajadas e enquadramentos repetidos são reunidos num grupo, para poderes escolher a melhor de cada um em vez de percorreres tudo. O agrupamento cruza sempre a hora de captura do EXIF com uma medida de semelhança visual: só são comparadas fotografias a menos de 3 minutos umas das outras. Passado esse intervalo não há agrupamento, por mais parecidas que sejam.

A medida de semelhança vem do framework **Vision** do macOS. Para cada fotografia é extraído um vetor de características de 768 dimensões a partir do preview já em cache, e duas fotografias são parecidas se a distância euclidiana entre os vetores for pequena.

O vetor é extraído com `imageCropAndScaleOption = .centerCrop`, ou seja, de um quadrado no centro da imagem. Isto é essencial para a orientação: com a omissão (`.scaleFill`, que espreme a imagem inteira para um quadrado) a mesma cena fotografada na horizontal e na vertical dá distâncias de 0,53 a 0,56, e não agrupa. Com `centerCrop` as mesmas fotografias descem para 0,31 a 0,37. A opção só se aplica ao vetor de semelhança — os restantes pedidos precisam da imagem inteira. É um modelo de visão do sistema e corre na Neural Engine. Na mesma passagem saem também a pontuação estética, a qualidade dos rostos, o ângulo do horizonte e a caixa do assunto, tudo com um só pedido por imagem: cerca de 10 ms por fotografia.

A vantagem sobre um hash percetual é concreta: o hash é um descritor global da *imagem*, e basta o assunto mudar de sítio no enquadramento para ele deixar de reconhecer a cena. Em duas fotografias do mesmo avião a rolar na pista, com o avião deslocado cerca de 10% da largura do enquadramento, o dHash dá uma distância de Hamming de 30 (o limite para "mesma cena" é 10, portanto não agrupava) enquanto o vetor do Vision dá 0,32 — bem dentro do limite.

Sem o auxiliar Vision, o agrupamento recorre ao *perceptual hash* (dHash): fotografias quase idênticas continuam a ser agrupadas, mas casos com o assunto em movimento passam ao lado. Numa imagem sem estrutura de grande escala (céu liso, nevoeiro, parede) o hash também não distingue cenas, e aí só a proximidade temporal agrupa. O estado por baixo do caminho da pasta diz qual dos dois está em uso.

O limiar está em **0,42**, em `analysis.js`. Foi calibrado sobre três cenas reais do mesmo aeroporto, com a mesma luz e a poucos minutos de intervalo: um avião em plano próximo, dois aviões a rolar (cena fotografada na horizontal e na vertical) e um avião a descolar.

| | distância |
|---|---|
| dentro da mesma cena, máximo | **0,3732** (a mesma cena na horizontal vs na vertical) |
| entre cenas diferentes, **mínimo** | **0,4848** (descolagem vs rolagem) |
| entre cenas visualmente distantes | 0,79 – 0,95 |

A margem é estreita, e o par que a define é instrutivo: descolagem e rolagem partilham o enquadramento, o fundo, a luz e o tipo de assunto, e ficam a 0,48 — quase tão perto como duas fotografias da mesma cena. O limiar está deliberadamente **abaixo** do meio da folga, porque as duas falhas não custam o mesmo: como o agrupamento é transitivo, um falso positivo funde dois grupos inteiros, enquanto um falso negativo apenas deixa um par por juntar.

Não há um limiar mais tolerante para rajadas. As janelas de tempo decidem *se* duas fotografias chegam a ser comparadas — passados 3 minutos não há agrupamento — mas não mexem no quão parecidas têm de ser: nada do que medi sustenta ser mais permissivo dentro de uma rajada.

A amostra continua pequena (8 fotografias, 3 grupos), e por isso o limiar está exposto na barra de ferramentas em **Agrupar**, com três níveis:

| nível | limiar | efeito |
|---|---|---|
| Apertado | 0,34 | Abaixo do máximo medido dentro da mesma cena. Só junta o que é claramente igual |
| **Normal** | **0,42** | O calibrado |
| Solto | 0,52 | Acima do 0,4848 de propósito: junta cenas distintas que partilhem enquadramento e luz |

Mudar de nível **reagrupa sem reanalisar** — os vetores já estão calculados, só a comparação é refeita, por isso é instantâneo. Experimenta os três na tua pasta para ver qual corresponde ao teu critério.

Vale a pena notar que o agrupamento é **transitivo**: no conjunto de teste, o Apertado dá os mesmos grupos que o Normal, porque as fotografias se ligam em cadeia (A–B, B–C) mesmo quando o par mais afastado do grupo está acima do limiar.

**Pontuação de 0 a 100.** Combina componentes transparentes com o modelo de estética do Vision:

- **Estética** (peso 30%) — `VNCalculateImageAestheticsScoresRequest`, o modelo de estética do macOS;
- **Nitidez** (28%) — variância do Laplaciano, medida na zona do assunto quando a saliência do Vision a indica, e no fotograma inteiro quando não;
- **Exposição** (18%) — percentagem de píxeis queimados nas altas luzes e esmagados nas sombras;
- **Técnica** (15%) — penaliza ISO alto e velocidades abaixo da regra de 1/distância focal;
- **Rostos** (15%) — `faceCaptureQuality` médio dos rostos detetados, só quando existem rostos;
- **Contraste** (9%) — desvio-padrão da luminância.

Os pesos são **renormalizados pelas componentes disponíveis**: uma fotografia sem rostos, ou uma pasta analisada sem o auxiliar Vision, continua a produzir pontuações comparáveis. O painel *Qualidade* mostra sempre que componentes entraram.

Por medição, a estética acompanha a degradação de forma monótona — numa fotografia nítida a 0,74, com desfoque moderado 0,60 e com desfoque forte −0,05; sobrexposta 0,47 e subexposta −0,04. Vale a pena notar o que isto acrescenta: uma fotografia escurecida não tem píxeis a zero, por isso a componente de exposição não a penaliza, e é a estética que a apanha.

Marcas adicionais vindas do Vision: **horizonte torto** acima de 3° (`VNDetectHorizonRequest`; numa imagem rodada 7° mediu 7,0°) e **rosto com pouca qualidade** quando algum rosto fica abaixo de 0,3.

> **Dois avisos honestos.** A estética é uma **caixa preta**: mostrei que reage a degradações que eu próprio introduzi, não que ordena fotografias diferentes como tu ordenarias — pode penalizar escolhas deliberadas como desfoque de movimento ou uma imagem propositadamente escura. E a componente de **rostos não foi validada**: as fotografias de teste não tinham pessoas. O mapeamento da `overallScore` para 0–100 (`(valor + 0,25)`, limitado a 0–1, em `analysis.js`) é igualmente provisório.

A nitidez guiada por saliência rendeu pouco na fotografia de referência (+12% com a caixa, porque ela cobre 81% × 45% do fotograma e ainda apanha muito céu). Fica na mesma porque é conceptualmente a medida certa, mas não é a melhoria que parecia.

Na faixa de miniaturas, cada fotografia mostra a sua pontuação e a melhor de cada grupo leva uma estrela e o nome a negrito. Cada grupo tem uma cor própria, que aparece numa barra por baixo das suas miniaturas em qualquer ordenação — fotografias sem parecidas não têm barra.

Na barra de ferramentas podes **Ordenar** por pasta, por grupo ou por pontuação, e usar **Só as melhores** para esconder as repetidas. Em **Ordenar: Grupo**, cada grupo passa a ser uma caixa própria, com a cor do grupo, um cabeçalho a dizer quantas parecidas tem e um botão **Selecionar repetidas** que marca de uma vez todas menos a melhor — daí podes ir a **Comparar** ou a **Só selecionadas** antes de decidir. As fotografias sem parecidas aparecem em caixas discretas marcadas como *Sem parecidas*.

O que a pontuação mede bem é o objetivo — foco, exposição, risco técnico. Não sabe nada de expressões, do momento ou da composição, e a nitidez só é diretamente comparável entre fotografias da mesma cena: uma paisagem com nevoeiro tem pouca variância de Laplaciano sem estar desfocada. Usa-a para reduzir centenas de fotografias a algumas dezenas de candidatas, não para decidir por ti.

A análise é guardada num ficheiro `.photo-reviewer.json` dentro da própria pasta das fotografias, validado pelo tamanho e data de cada ficheiro. Podes apagá-lo sem problema: é recalculado na abertura seguinte. Se a pasta for só de leitura, a análise continua a valer durante a sessão mas não é guardada.

Os vetores do Vision e as medidas que vêm com eles ocupam cerca de 4 KB por fotografia e não têm lugar na pasta do utilizador: ficam num `featureprints.json` na pasta temporária, ao lado dos previews de que foram extraídos. A cache regista a revisão do `FeaturePrint` usada, porque vetores de revisões diferentes não são comparáveis entre si — se o macOS mudar de revisão, são todos recalculados.

## Desempenho

O processamento de imagem usa `sharp`/libvips, que no Apple Silicon corre nativamente em arm64 com SIMD (NEON). A app tira partido dos vários núcleos assim:

- cada fotografia é tratada por um pipeline libvips de uma só thread (`sharp.concurrency(1)`) e são processadas várias fotografias em paralelo, tantas quantos os núcleos disponíveis até ao máximo de 8 — num M4 (4 P-cores + 6 E-cores) isso enche a máquina melhor do que espalhar uma imagem de cada vez por todas as threads;
- o original é descodificado uma só vez: o preview é gerado a partir dele (com *shrink-on-load*) e a miniatura sai do preview já reduzido;
- a análise reutiliza o preview e faz uma única leitura da luminância, de onde saem a nitidez, o histograma e o hash.

Medido neste Mac (M4, 40 ficheiros JPEG de 12 MP): a geração de miniaturas e previews passou de ~1,3 s para ~0,8 s com estas mudanças, e a análise dos 40 ficheiros leva ~0,3 s. A passagem completa do Vision — vetor, estética, rostos, horizonte e saliência — mediu ~10 ms por fotografia (60 previews em 0,61 s), o que dá cerca de 5 s numa pasta de 500. Só o vetor de semelhança custava ~3,7 ms. Na segunda abertura da mesma pasta tudo vem da cache e é instantâneo. Ficheiros de máquinas com mais resolução demoram proporcionalmente mais.

Nota medida: o vetor extraído do preview de 2048 px dá praticamente a mesma distância que o extraído do original (0,2421 contra 0,2406 no par de referência), por isso a análise reutiliza o preview. Já a miniatura não serve — é um recorte `cover` e muda o conteúdo.

## Instalação

Na pasta do projeto, executa:

```bash
npm install
```

## Instalar como app do macOS

```bash
npm run build:app
```

Isto gera `dist/Photo EXIF Reviewer.app`. Arrasta-a para a pasta **Aplicações** e abre como qualquer outra app. Volta a correr o comando sempre que mexeres no código.

A app é uma janela nativa em `WKWebView` — usa o WebKit do sistema, não traz um segundo motor de browser — e arranca por dentro o servidor Node que está empacotado com ela. Por isso:

- **não precisa do Node instalado** para correr. O runtime vai dentro do pacote, o que aqui é indispensável: este Mac tem o Node no `nvm`, e uma app lançada pelo Finder não herda o `PATH` da shell, logo não encontraria o `node` do sistema;
- **escolhe uma porta livre** a cada arranque, em vez da 4173 fixa, e só carrega a página quando o servidor responde;
- **não deixa processos pendentes**: ao sair, manda `SIGTERM` ao servidor para o `exiftool` fechar em condições, e mata-o se não sair em meio segundo;
- usa o **painel de pastas nativo** do macOS em vez do `osascript`, através de uma ponte do `WKWebView`. No modo browser (`npm start`) a ponte não existe e continua a usar-se o `osascript`.

Como é construída no teu Mac, **não fica em quarentena** e não aparecem os avisos do Gatekeeper. Vai assinada ad-hoc (`codesign --sign -`), que é o necessário para o macOS aceitar binários arm64 alterados depois de compilados.

Duas limitações a saber: a app pesa cerca de **184 MB** (106 MB só do runtime Node) e é **exclusiva de Apple Silicon** — o runtime, a janela, o auxiliar Vision e o binário do `sharp` são todos arm64. Para um Mac Intel teria de ser reconstruída nessa máquina.

## Executar sem instalar

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
3. Usa as miniaturas na parte inferior para saltar diretamente para uma fotografia ou selecionar várias, ou a tecla `Espaço` para selecionar e desselecionar a fotografia atual sem tirar as mãos do teclado.
4. Com duas ou mais selecionadas, usa **Comparar** para as ver lado a lado.
5. Usa **Só selecionadas** para fazer Anterior/Seguinte percorrer apenas a seleção.
6. Faz duplo clique na fotografia principal ou numa fotografia em comparação para abrir o original em modo zoom. Usa a roda do rato para ampliar e arrasta para fazer pan.
7. Usa **Mover para o Lixo** ou a tecla `Delete`/`Backspace` para rejeitar a fotografia atual. A app pede confirmação antes de mover os ficheiros.
8. Usa **Ordenar** e **Só as melhores** para percorrer primeiro as candidatas com melhor pontuação. Ver a secção *Ajuda à escolha*.
9. Usa **Agrupar** para apertar ou alargar o critério de semelhança, e **Grelha** para sobrepor a grelha dos terços à fotografia. A grelha é desenhada sobre a área realmente ocupada pela imagem, não sobre a caixa à volta, e a preferência fica guardada entre sessões.

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

O painel **Qualidade**, por cima dos dados EXIF, mostra a pontuação da fotografia atual, a posição dela dentro do grupo de fotografias parecidas, as componentes que entraram no cálculo e os avisos detetados (desfocada, altas luzes queimadas, sombras esmagadas, ISO alto, risco de tremido, horizonte torto, rosto com pouca qualidade).
