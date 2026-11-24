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

As capturas vão para `docs/capturas-android/`. As versionadas foram reduzidas para 540 px de largura e 128 cores (Pillow) para ficarem abaixo de 130 KB.

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
| Voltar na estante sai do app no 1º toque | FALHA (precisa de 2 toques) |

Números: abertura a frio 0,9 a 1,5 s (TotalTime, variando entre execuções); memória TOTAL PSS cerca de 98 a 100 MB.

### Problemas encontrados

- **Voltar na estante exige dois toques depois de ter lido** (`src/main.ts`). O Voltar do leitor usa `navigate('#/', true)`
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
