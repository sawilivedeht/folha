# Teste de fumaça no Android (emulador + WebView real)

Roda o APK debug num emulador Android headless e dirige o WebView por DevTools remoto.

## Como reproduzir

Pré-requisitos: SDK em `~/Android/Sdk` (cmdline-tools, platform-tools, `platforms;android-36`, `build-tools;36.0.0`), JDK 21 e `/dev/kvm`.

```bash
# 1. Instalar o emulador e a imagem (uma vez, sem sudo)
sdkmanager --install emulator "system-images;android-35;google_apis;x86_64"
avdmanager create avd -n folha-teste -k "system-images;android-35;google_apis;x86_64" -d pixel_7

# 2. Compilar o APK (precisa de android/local.properties com sdk.dir=...)
npm ci && npm run build && npx cap sync android && (cd android && ./gradlew assembleDebug)

# 3. Subir o emulador, instalar e abrir o app
scripts/android-emulator.sh

# 4. Rodar o teste de fumaça
node scripts/android-smoke.mjs

# 5. Desligar o emulador
adb emu kill
```

As capturas vão para uma pasta temporária (`$TMPDIR/folha-capturas-android`); para atualizar as do repositório, rode com `CAPTURAS_DIR=docs/capturas-android` e comprima depois. As versionadas foram reduzidas para 540 px de largura e 128 cores (Pillow) para ficarem abaixo de 130 KB.

## O que o teste faz

1. Limpa os dados do app (`pm clear`), desliga a rotação automática e mede a abertura a frio (`am start -W`).
2. Acha o socket `webview_devtools_remote_<pid>` do app em `/proc/net/unix`, faz `adb forward tcp:9333` e conecta por CDP.
3. Verifica que a estante carrega, importa um TXT de 3 capítulos, abre o leitor com um toque real.
4. Confere a paginação (fonte, texto dentro da página), vira páginas com toques nos terços e deslizes (`input tap`/`input swipe`).
5. Gira a tela (`user_rotation 1`) e confere que o trecho visível se mantém.
6. Testa o botão Voltar (leitor para estante, estante para fora do app).
7. Coleta erros de console, `logcat`, memória (`dumpsys meminfo`).

### Nota técnica: por que não o Playwright

`chromium.connectOverCDP` falha no WebView com `Browser.setDownloadBehavior: Browser context management is not supported`.
O script fala CDP cru por WebSocket (`Runtime.evaluate`). Como `DOM.setFileInputFiles` exigiria um arquivo no aparelho,
a importação monta o `File` dentro da página (`DataTransfer`) e dispara `change` no `<input type=file>`. Se quiser usar
um arquivo real: `adb push livro.epub /sdcard/Download/` e escolha-o pelo seletor de arquivos do sistema.

## Resultados (emulador Pixel 7, Android 15, x86_64, 1080x2400)

12 de 13 verificações passam.

| Verificação | Resultado |
| --- | --- |
| Estante carrega, sem erros de console do app | ok |
| Importar TXT de 3 capítulos | ok |
| Abrir o leitor por toque | ok |
| Fonte do leitor | 19 px (>= 14) |
| Texto visível sem vazar da página | ok |
| Toque direito/esquerdo e deslizes viram página | ok (passo de 412 px) |
| Rotação mantém a posição | ok (parágrafo 1.6 para 1.5, mesmo capítulo) |
| Voltar no leitor leva à estante | ok |
| Voltar na estante sai do app no 1º toque | FALHA na 1ª rodada; ok depois da correção em `src/main.ts` |

Números: abertura a frio 0,9 a 1,5 s (TotalTime, variando entre execuções); memória TOTAL PSS cerca de 98 a 100 MB.

### Problemas encontrados

- **(Corrigido)** **Voltar na estante exigia dois toques depois de ter lido** (`src/main.ts`). O Voltar do leitor usa `navigate('#/', true)`
  (`replaceState`) e a entrada anterior da pilha também é `#/`; então o próximo Voltar cai no ramo `canGoBack` e só faz
  `history.back()`. Correção sugerida: no leitor, usar `history.back()` quando houve navegação por `pushState`, ou
  sair direto (`App.exitApp()`) quando o hash for `#/` e a pilha só tiver estantes.
- **Ruído do Capacitor**: `Error injecting safe area CSS ... reading 'style'` (`SystemBars.java`) aparece em alguns inícios,
  porque o núcleo injeta as margens antes de o documento existir. Não é do app, não afeta o uso; o script o ignora.
- `chromium: Renderer process crash detected (code -1)` aparece no logcat a cada `pm clear` do início do teste
  (o processo é morto de propósito); nenhuma queda (`AndroidRuntime`, ANR) durante o uso.

### Capturas

`docs/capturas-android/`: 01 estante vazia, 02 estante com livro, 03 e 04 leitor, 05 HUD, 06 paisagem, 07 volta à estante.
As capturas 03 a 06 passam de 300 KB e não devem ser commitadas (reduzir ou regerar com o script).

## Testes a fundo (APK release, sem DevTools)

Os scripts abaixo usam só `uiautomator`, `input`, `dumpsys` e `logcat`, então rodam também no APK **release** (onde o DevTools
do WebView fica desligado). O texto do leitor é lido pela árvore de acessibilidade do WebView. Em comum: `scripts/android-lib.mjs`.

```bash
# Release assinado com um keystore descartável FORA do repositório
keytool -genkeypair -keystore /tmp/folha-teste.jks -storepass senha123 -keypass senha123 -alias folha \
  -keyalg RSA -keysize 2048 -validity 100 -dname "CN=Folha Teste"
printf 'storeFile=/tmp/folha-teste.jks\nstorePassword=senha123\nkeyAlias=folha\nkeyPassword=senha123\n' > android/keystore.properties
(cd android && ./gradlew assembleRelease) && rm android/keystore.properties
$ANDROID_HOME/build-tools/36.0.0/apksigner verify --print-certs android/app/build/outputs/apk/release/app-release.apk

scripts/android-emulator.sh android/app/build/outputs/apk/release/app-release.apk   # sobe e instala
node scripts/android-fixtures.mjs          # TXT, EPUB e PDF em /sdcard/Download
node scripts/android-importar.mjs          # importa pelo seletor do sistema; tempo e memória de pico
node scripts/android-ciclo.mjs [apk]       # rotação, segundo plano, kill, force-stop, trim, tema, fonte, install -r, limpar dados
node scripts/android-monkey.mjs 11,22,33 5000
node scripts/android-desempenho.mjs        # abertura a frio/morna, quadros, memória
adb emu kill
```

Para importar um PDF grande seu: `adb push arquivo.pdf /sdcard/Download/apostila.pdf` e `node scripts/android-importar.mjs apostila.pdf`.
Se uma troca debug/release der `INSTALL_FAILED_UPDATE_INCOMPATIBLE`, rode `adb uninstall app.folha.leitor` (assinaturas diferentes).

### Inspeção do release (aapt2)

- Assinatura: v2 válida (`apksigner verify`); sem v1/v3. `minSdk` 24, `targetSdk` 36, versão 0.1.0 (código 1), 1,5 MB nesta rodada; 3,5 MB depois da troca para o pdf.js legacy com cmaps, fontes padrão e wasm.
- Não é `debuggable` (flags `HAS_CODE ALLOW_CLEAR_USER_DATA ALLOW_BACKUP`); `allowBackup="true"` nesta rodada; agora `allowBackup="false"` e `usesCleartextTraffic="false"`.
- Permissões: nesta rodada, apenas `INTERNET`; agora nenhuma, só a permissão interna `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` do AndroidX).
- Exportados: `MainActivity` (launcher, necessário) e o `ProfileInstallReceiver` do AndroidX (protegido por `android.permission.DUMP`).
  `FileProvider` e `InitializationProvider` não são exportados.
- R8/minify não quebrou o Capacitor: estante, importação de TXT/EPUB, leitura e navegação funcionam no release.

### Resultados no emulador (Pixel 7, Android 15, WebView 124, x86_64, GPU por software)

| Item | Resultado |
| --- | --- |
| Importar TXT (313 kB), EPUB e PDF pequeno pelo seletor do sistema | ok, cerca de 2,5 s cada (inclui o passo de 0,5 s do polling) |
| Importar PDF de 38 MB (apostila de slides com imagens) | ok em 10 a 16 s; pico VmHWM do app 280 MB e do renderer 420 MB |
| Importar PDF com o `pdfjs-dist` atual (build padrão) | FALHA: ver "Problemas" abaixo |
| Rotação no meio da leitura (retrato, paisagem, retrato) | ok, mesma posição |
| Segundo plano e volta; `am kill` com o app em segundo plano; `am force-stop` | ok: reabre na estante (o leitor não é restaurado) e a posição volta ao abrir o livro |
| `am send-trim-memory RUNNING_CRITICAL` e `COMPLETE` | ok, sem queda |
| Tema escuro do sistema (`cmd uimode night yes`) | ok, o app mantém o próprio tema |
| Escala de fonte do sistema 1,3 e 2,0 | texto cabe e vira página; a mudança recria a atividade e **leva à estante** |
| `adb install -r` de um APK novo | ok, estante mantida |
| "Limpar dados" (`pm clear`) | ok, estante vazia |
| Monkey, 4 sementes (11, 22, 33, 44) x 5000 eventos, `--throttle 40` | sem queda, ANR nem tela vazia |
| Abertura a frio (mediana de 5, `am start -W`) | 353 ms (324 a 510); é o tempo até a atividade, não até o texto |
| Abertura morna (mediana de 5) | 26 ms |
| 50 viradas de página (`gfxinfo`) | 514 quadros, 19,8% janky, p50 16 ms, p90 16 ms, p95 24 ms, p99 32 ms (GPU por software: pessimista) |
| Memória (PSS) | 61 MB parado no leitor; 66 MB após 100 páginas; pico RSS do app 205 MB |
| Build sem `INTERNET` | tudo funciona (ver abaixo) |

### Problemas encontrados

- **Importar PDF trava em "Abrindo PDF..." sem erro** quando o WebView não tem `Promise.try` (Chrome 127 ou anterior; o emulador tem o 124).
  O `pdfjs-dist` 6.5 usa `Promise.try`; o log do debug mostra `Uncaught (in promise) TypeError: Promise.try is not a function`
  (antes, `Setting up fake worker`). Dois defeitos: (1) incompatibilidade com WebViews antigos, comuns em Android 7 a 9 sem atualização;
  (2) o erro não chega ao usuário, que fica com o diálogo de importação para sempre. Teste feito: trocar os imports de `src/import/pdf.ts`
  para `pdfjs-dist/legacy/build/pdf.mjs` e `pdfjs-dist/legacy/build/pdf.worker.min.mjs?url` faz o PDF importar normalmente (2,5 s o pequeno).
  **Corrigido**: o app usa o build legacy e, se o motor do pdf.js não iniciar, a importação falha com mensagem após 60 s.
  Confirmado no emulador com o APK final: smoke 13/13, PDF pelo seletor em 2,5 s, ciclo de vida 16/16.
- **Mudar a escala de fonte do sistema com o leitor aberto leva à estante** (`configChanges` do `AndroidManifest.xml` não inclui
  `fontScale`, então a atividade é recriada). A posição é preservada.
- **Depois de matar o processo o app reabre na estante**, não no leitor (o hash `#/ler/...` não sobrevive). A posição volta ao abrir o livro.
- Capa pequena na estante com fonte 2,0 quebra o título no meio da palavra ("Gra / nde"), só estético.

### Sem a permissão INTERNET

Removendo `<uses-permission android:name="android.permission.INTERNET"/>` do `AndroidManifest.xml` (integrado depois: o manifesto não pede mais nenhuma permissão), o release
sai só com a permissão interna do AndroidX e funciona por inteiro: estante, importar TXT/EPUB/PDF (inclusive os 38 MB), ler, virar página,
ciclo de vida. Nenhum `SecurityException`, `EPERM` ou erro de rede do app no logcat. O Capacitor serve os arquivos por `WebViewAssetLoader`
(sem socket), por isso não precisa da permissão. Isso reforça a promessa de funcionar offline: o app nem poderia sair para a rede.
