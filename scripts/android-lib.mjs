// Utilitários compartilhados pelos scripts android-*.mjs: adb, uiautomator, medidas.
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const SDK = process.env.ANDROID_HOME ?? join(homedir(), 'Android/Sdk');
export const ADB = join(SDK, 'platform-tools/adb');
export const PKG = 'app.folha.leitor';

export const adb = (...a) => execFileSync(ADB, a, { encoding: 'utf8', maxBuffer: 256 << 20 }).replace(/\r/g, '');
export const sh = (cmd) => adb('shell', cmd);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const tap = (x, y) => sh(`input tap ${Math.round(x)} ${Math.round(y)}`);
export const back = () => sh('input keyevent KEYCODE_BACK');
export const pid = () => { try { return sh(`pidof ${PKG}`).trim(); } catch { return ''; } };

/** Tamanho da tela física em pixels. */
export function tela() {
  const m = sh('wm size').match(/(\d+)x(\d+)/g).pop().split('x').map(Number);
  return { w: m[0], h: m[1] };
}

/** Lê a hierarquia de views (uiautomator) como lista de nós com texto, descrição e centro. */
export function ui() {
  let xml = '';
  for (let i = 0; i < 4 && !xml.includes('<hierarchy'); i++) {
    try {
      sh('uiautomator dump /sdcard/ui.xml');
      xml = adb('exec-out', 'cat', '/sdcard/ui.xml');
    } catch { /* o uiautomator às vezes morre (137) logo após mudanças de tela; tenta de novo */ }
  }
  const nos = [];
  const un = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#10;/g, '\n');
  for (const m of xml.matchAll(/<node [^>]*>/g)) {
    const g = (k) => m[0].match(new RegExp(` ${k}="([^"]*)"`))?.[1] ?? '';
    const b = g('bounds').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!b) continue;
    const [x1, y1, x2, y2] = b.slice(1).map(Number);
    nos.push({ text: un(g('text')), desc: un(g('content-desc')), id: g('resource-id'), x: (x1 + x2) / 2, y: (y1 + y2) / 2, x1, y1, x2, y2 });
  }
  return nos;
}

const casaNo = (casa) => (x) => (casa instanceof RegExp ? casa.test(x.text) || casa.test(x.desc) : x.text === casa || x.desc === casa);

/** Espera aparecer um nó cujo texto ou descrição casa; devolve o nó. */
export async function esperarUi(casa, ms = 20000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const n = ui().find(casaNo(casa));
    if (n) return n;
    await sleep(300);
  }
  throw new Error(`timeout esperando "${casa}" na tela`);
}
export async function tocarUi(casa, ms) {
  const n = await esperarUi(casa, ms);
  tap(n.x, n.y);
  return n;
}

/** Memória: TOTAL PSS (kB) do app e VmHWM (pico de RSS, kB) do processo principal. */
export function memoria() {
  const p = pid();
  const linha = sh(`dumpsys meminfo ${PKG}`).split('\n').find((l) => /^\s*TOTAL(\s+PSS:)?\s+\d+/.test(l));
  const pss = Number(linha?.match(/\d+/)?.[0] ?? NaN);
  const hwm = p ? Number(sh(`cat /proc/${p}/status`).match(/VmHWM:\s+(\d+)/)?.[1] ?? NaN) : NaN;
  return { pssKb: pss, picoRssKb: hwm };
}

/**
 * Picos de memória (VmHWM, kB) do processo do app e do renderer do WebView. O VmHWM já é o pico
 * desde a criação do processo, então basta ler no fim (sem amostragem). Os renderers de outros
 * apps que usam WebView entram na conta; por isso o script de importação encerra o app do Drive antes.
 */
export function picos() {
  const hwm = (p) => Number(sh(`cat /proc/${p}/status 2>/dev/null`).match(/VmHWM:\s+(\d+)/)?.[1] ?? 0);
  const app = pid() ? hwm(pid()) : 0;
  const renderer = sh('ps -A -o PID,NAME').split('\n').filter((l) => /sandboxed_process/.test(l)).map((l) => hwm(l.trim().split(/\s+/)[0]));
  return { appKb: app, rendererKb: Math.max(0, ...renderer) };
}

export const emPrimeiroPlano = () => /ResumedActivity.*app\.folha\.leitor/.test(sh('dumpsys activity activities'));

/** Importa um arquivo de /sdcard/Download pelo seletor do sistema. `pronto(nos)` diz quando a importação terminou; devolve os ms gastos. */
export async function importarPeloSeletor(nomeArquivo, pronto, ms = 300000, aCadaSegundo = () => {}) {
  const imp = await esperarUi(/^Importar/, 15000);
  tap(imp.x, imp.y);
  await sleep(1500);
  if (!ui().some((n) => n.text === nomeArquivo)) {
    const raizes = ui().find((n) => n.desc === 'Show roots');
    if (raizes) { tap(raizes.x, raizes.y); await sleep(900); }
    const dl = ui().find((n) => n.text === 'Downloads' && n.id === 'android:id/title');
    if (dl) { tap(dl.x, dl.y); await sleep(1200); }
  }
  const arq = await esperarUi(nomeArquivo, 10000);
  const t0 = Date.now();
  tap(arq.x, arq.y);
  while (Date.now() - t0 < ms) {
    await sleep(500);
    aCadaSegundo();
    if (pronto(ui())) return Date.now() - t0;
  }
  throw new Error(`timeout importando ${nomeArquivo}`);
}

/** Quantidade de cartões de livro na estante (um botão "Opções para ..." por livro). */
export const contaLivros = (nos = ui()) => nos.filter((n) => /^Opções para /.test(n.text || n.desc)).length;

/** Impressão digital da página visível: início do primeiro parágrafo dentro da tela (via acessibilidade do WebView). */
export function trechoVisivel(nos = ui(), larg = tela().w) {
  const n = nos.find((x) => x.text.length > 40 && x.x1 >= 0 && x.x1 < larg - 10 && x.y1 >= 100);
  return n ? n.text.slice(0, 48) : null;
}

/** Quedas e ANRs do app (buffer "crash" do logcat e linhas de ANR). */
export const logcatErros = () => [
  ...adb('logcat', '-d', '-b', 'crash').split('\n').filter((l) => /Process: app\.folha\.leitor/.test(l)),
  ...sh('logcat -d').split('\n').filter((l) => /ANR in app\.folha|am_anr.*app\.folha/.test(l)),
];

/** Trechos (48 primeiros caracteres) dos parágrafos visíveis na tela, lidos pela acessibilidade do WebView. */
export function visiveis(nos = ui(), t = tela()) {
  return nos.filter((x) => x.text.length > 40 && x.x1 >= 0 && x.x1 < t.w - 10 && x.y1 >= 100 && x.y1 < t.h - 100).map((x) => x.text.slice(0, 48));
}

/** Toque no terço direito (avança) ou esquerdo (volta) da tela, na altura do meio. */
export const virar = (dir = 1, t = tela()) => tap(t.w * (dir > 0 ? 0.85 : 0.15), t.h * 0.5);

/** Abre o app (se preciso) e espera a estante ou o leitor aparecer. */
export async function abrirApp() {
  sh(`am start -n ${PKG}/.MainActivity`);
  await esperarUi(/^Importar|^Folha$/, 20000);
}

/** Abre na estante o livro cujo título casa e espera o primeiro parágrafo aparecer. */
export async function abrirLivro(titulo) {
  const c = await esperarUi(titulo, 15000);
  tap(c.x, c.y);
  for (let i = 0; i < 30; i++) { await sleep(400); if (noLeitor()) return; }
  throw new Error('leitor não mostrou texto');
}

/** Está no leitor (e não na estante)? Na estante há botões "Opções para ..."; no leitor, não. */
export const noLeitor = (nos = ui()) => contaLivros(nos) === 0 && visiveis(nos).length > 0;
