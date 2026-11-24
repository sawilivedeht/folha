// Teste de fumaça do Folha no WebView real do Android (emulador), via DevTools remoto + Playwright.
// O connectOverCDP do Playwright falha no WebView ("Browser context management is not supported"),
// então falamos CDP cru por WebSocket (Node >= 22 tem WebSocket global).
// Uso: node scripts/android-smoke.mjs   (com o emulador já no ar: scripts/android-emulator.sh)
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ADB = join(process.env.ANDROID_HOME ?? join(homedir(), 'Android/Sdk'), 'platform-tools/adb');
const PKG = 'app.folha.leitor';
const PORT = 9333;
const OUT = join(dirname(fileURLToPath(import.meta.url)), '../docs/capturas-android');
mkdirSync(OUT, { recursive: true });

const adb = (...a) => execFileSync(ADB, a, { encoding: 'utf8', maxBuffer: 64 << 20 }).replace(/\r/g, '');
const sh = (cmd) => adb('shell', cmd);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (nome, ok, detalhe = '') => {
  results.push({ nome, ok });
  console.log(`${ok ? 'OK   ' : 'FALHA'} ${nome}${detalhe ? ' — ' + detalhe : ''}`);
};
function shot(nome) {
  const png = execFileSync(ADB, ['exec-out', 'screencap', '-p'], { maxBuffer: 64 << 20 });
  writeFileSync(join(OUT, `${nome}.png`), png);
  return png.length;
}
const tap = (x, y) => sh(`input tap ${x} ${y}`);
const back = () => sh('input keyevent KEYCODE_BACK');
const pidApp = () => sh(`pidof ${PKG}`).trim();

// TXT de teste com 3 capítulos (texto longo o bastante para várias páginas cada).
const par = 'Era uma vez uma folha que flutuava sobre o rio, levada pela correnteza mansa da manhã, enquanto os pássaros cantavam nas margens e a luz atravessava a neblina. ';
const cap = (n) => `Capítulo ${n}\n\n` + Array.from({ length: 40 }, (_, i) => `${par.repeat(3)}(${n}.${i + 1})`).join('\n\n');
const txt = [1, 2, 3].map(cap).join('\n\n');

// Estado inicial: rotação automática desligada, retrato, app limpo.
sh('settings put system accelerometer_rotation 0');
sh('settings put system user_rotation 0');
sh(`pm clear ${PKG}`);
const tempoFrio = sh(`am start -W -n ${PKG}/.MainActivity`).match(/TotalTime:\s*(\d+)/)?.[1];
console.log(`Abertura a frio (TotalTime): ${tempoFrio} ms`);
await sleep(3000);

const pid = pidApp();
const socket = sh('cat /proc/net/unix').split('\n').map((l) => l.match(/@(webview_devtools_remote_(\d+))/)).find((m) => m && m[2] === pid)?.[1];
if (!socket) throw new Error(`Socket do DevTools do pid ${pid} não encontrado`);
adb('forward', `tcp:${PORT}`, `localabstract:${socket}`);

const alvos = await (await fetch(`http://localhost:${PORT}/json`)).json();
const alvo = alvos.find((t) => t.type === 'page');
const ws = new WebSocket(alvo.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0;
const pend = new Map();
const erros = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id) { const p = pend.get(msg.id); pend.delete(msg.id); msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result); return; }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') erros.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
  if (msg.method === 'Runtime.exceptionThrown') erros.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
};
// Se o WebView fechar a conexão (renderer reiniciado, página recarregada), falha as chamadas
// pendentes em vez de deixar o script sair calado com um await nunca resolvido.
let fechado = false;
ws.onclose = (ev) => {
  fechado = true;
  for (const p of pend.values()) p.rej(new Error(`conexão DevTools fechada (código ${ev.code})`));
  pend.clear();
};
const cdp = (method, params = {}) => new Promise((res, rej) => {
  if (fechado) return rej(new Error('conexão DevTools fechada'));
  const id = ++seq; pend.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params }));
});
await cdp('Runtime.enable');
// Avalia uma função no contexto da página (serializada) e devolve o valor.
const evalPage = async (fn, arg) => {
  const r = await cdp('Runtime.evaluate', { expression: `(${fn})(${JSON.stringify(arg ?? null)})`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
async function waitFor(sel, timeout = 15000) {
  const t = Date.now();
  while (Date.now() - t < timeout) { if (await evalPage((s) => !!document.querySelector(s), sel)) return; await sleep(250); }
  throw new Error(`timeout esperando ${sel}`);
}
// Shim mínimo com a mesma forma do Playwright usada abaixo.
const page = {
  url: () => '',
  async refreshUrl() { this._u = await evalPage(() => location.href); return this._u; },
  evaluate: (fn, arg) => evalPage(fn, arg),
  waitForSelector: (s, o) => waitFor(s, o?.timeout),
  textContent: (s) => evalPage((q) => document.querySelector(q)?.textContent, s),
  title: () => evalPage(() => document.title),
  count: (s) => evalPage((q) => document.querySelectorAll(q).length, s),
  boundingBox: (s) => evalPage((q) => { const r = document.querySelector(q).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }, s),
  // Equivalente ao setInputFiles: monta o File na página e dispara "change" no <input type=file>.
  setInputFile: (s, nome, tipo, texto) => evalPage(({ s, nome, tipo, texto }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([texto], nome, { type: tipo }));
    const i = document.querySelector(s);
    i.files = dt.files;
    i.dispatchEvent(new Event('change', { bubbles: true }));
  }, { s, nome, tipo, texto }),
};
console.log('Página:', alvo.url);

try {
  // 1. Estante vazia carregou.
  await page.waitForSelector('.lib-page', { timeout: 15000 });
  check('estante carregou', true, await page.title());
  shot('01-estante-vazia');

  // 2. Importa o TXT pelo <input type=file>.
  await page.setInputFile('input[type=file]', 'livro-teste.txt', 'text/plain', txt);
  await page.waitForSelector('.lib-card', { timeout: 20000 });
  const titulo = await page.textContent('.lib-card-title');
  check('livro importado aparece na estante', true, `título: ${titulo}`);
  await sleep(1500);
  shot('02-estante-com-livro');

  // 3. Abre o leitor (toque real no cartão).
  const box = await page.boundingBox('.lib-card');
  const escala = await page.evaluate(() => window.devicePixelRatio);
  tap(Math.round((box.x + box.width / 2) * escala), Math.round((box.y + box.height / 2) * escala));
  await page.waitForSelector('.reader-columns', { timeout: 15000 });
  await sleep(1500);
  check('leitor aberto', (await page.evaluate(() => location.hash)).startsWith('#/ler/'), await page.evaluate(() => location.hash));
  shot('03-leitor-pagina1');

  // 4. Paginação: texto dentro da página, fonte >= 14 px.
  const medida = () => page.evaluate(() => {
    const c = document.querySelector('.reader-columns');
    const v = document.querySelector('.reader-viewport').getBoundingClientRect();
    const p = c.querySelector('p, div, span') ?? c;
    const fs = parseFloat(getComputedStyle(p).fontSize);
    const cr = c.getBoundingClientRect();
    return { fs, vw: v.width, vh: v.height, vx: v.x, scrollW: c.scrollWidth, tx: getComputedStyle(c).transform, left: cr.left, w: window.innerWidth };
  });
  const m1 = await medida();
  check('fonte >= 14 px', m1.fs >= 14, `${m1.fs}px`);
  const fora = await page.evaluate(() => {
    const v = document.querySelector('.reader-viewport').getBoundingClientRect();
    let n = 0;
    for (const p of document.querySelectorAll('.reader-columns p')) {
      for (const r of p.getClientRects()) {
        // Só conta o que está visível na página atual e vaza para os lados/vertical.
        if (r.right > v.left + 1 && r.left < v.right - 1 && (r.bottom > v.bottom + 1 || r.top < v.top - 1)) n++;
      }
    }
    return n;
  });
  check('texto visível não vaza da página', fora === 0, `${fora} retângulos fora`);
  const pagina = () => page.evaluate(() => document.querySelector('.reader-columns').style.transform);
  const t0 = await pagina();

  // 5. Vira páginas por toque nos terços e por deslize.
  const W = 1080, H = 2400;
  tap(Math.round(W * 0.85), Math.round(H * 0.5));
  await sleep(700);
  const t1 = await pagina();
  check('toque no terço direito avança', t1 !== t0, `${t0} → ${t1}`);
  shot('04-leitor-pagina2');
  tap(Math.round(W * 0.15), Math.round(H * 0.5));
  await sleep(700);
  const t2 = await pagina();
  check('toque no terço esquerdo volta', t2 === t0, t2);
  sh(`input swipe ${W * 0.8} ${H * 0.5} ${W * 0.2} ${H * 0.5} 150`);
  await sleep(700);
  const t3 = await pagina();
  check('deslize para a esquerda avança', t3 !== t0, t3);
  sh(`input swipe ${W * 0.2} ${H * 0.5} ${W * 0.8} ${H * 0.5} 150`);
  await sleep(700);
  check('deslize para a direita volta', (await pagina()) === t0);
  // Toque central mostra o HUD.
  tap(W / 2, H / 2);
  await sleep(600);
  shot('05-leitor-hud');
  tap(W / 2, H / 2);
  await sleep(400);

  // 6. Rotação: avança 3 páginas, gira e confere a posição (trecho do texto visível).
  for (let i = 0; i < 3; i++) { tap(Math.round(W * 0.85), Math.round(H * 0.5)); await sleep(600); }
  const trecho = () => page.evaluate(() => {
    const v = document.querySelector('.reader-viewport').getBoundingClientRect();
    for (const p of document.querySelectorAll('.reader-columns p')) {
      for (const r of p.getClientRects()) {
        if (r.left >= v.left - 1 && r.right <= v.right + 1 && r.top >= v.top && r.bottom <= v.bottom) return p.textContent.match(/\((\d+\.\d+)\)/)?.[1] ?? p.textContent.slice(0, 30);
      }
    }
    return null;
  });
  const antes = await trecho();
  sh('settings put system user_rotation 1');
  await sleep(3000);
  shot('06-leitor-paisagem');
  const depois = await trecho();
  const mesmoCap = antes && depois && antes.split('.')[0] === depois.split('.')[0];
  check('posição mantida após girar (mesmo capítulo e parágrafo próximo)', !!mesmoCap && Math.abs(Number(antes.split('.')[1]) - Number(depois.split('.')[1])) <= 2, `antes ${antes}, depois ${depois}`);
  sh('settings put system user_rotation 0');
  await sleep(2500);

  // 7. Botão Voltar: leitor → estante; estante → sai do app.
  back();
  await sleep(1500);
  check('Voltar no leitor leva à estante', !(await page.evaluate(() => location.hash)).startsWith('#/ler/') && (await page.count('.lib-page')) > 0, await page.evaluate(() => location.hash || '#/'));
  shot('07-volta-estante');
  // BUG conhecido (src/main.ts): o Voltar do leitor usa replaceState('#/'), e a entrada anterior da pilha
  // também é '#/'; então o primeiro Voltar na estante só faz history.back() e é preciso um segundo para sair.
  const resumido = () => /ResumedActivity.*app\.folha\.leitor/.test(sh('dumpsys activity activities'));
  let toques = 0, fechou = false;
  while (toques < 3 && !fechou) {
    back(); toques++;
    for (let i = 0; i < 4 && !fechou; i++) { await sleep(700); fechou = !resumido(); }
  }
  check('Voltar na estante sai do app no 1º toque', fechou && toques === 1, `${toques} toque(s) necessário(s)`);

  // 8. Erros de console.
  // O Capacitor 8 (SystemBars.java) injeta as margens seguras antes de o documento existir e registra
  // este erro inofensivo; ele vem do núcleo, não do app, então é contado à parte.
  const ruido = (e) => e.includes('Error injecting safe area CSS');
  const reais = erros.filter((e) => !ruido(e));
  check('sem erros de console do app', reais.length === 0, reais.slice(0, 3).join(' | '));
  console.log(`(ignorados do núcleo do Capacitor: ${erros.length - reais.length} ocorrências de "Error injecting safe area CSS")`);
} catch (e) {
  check('execução sem exceção', false, String(e).split('\n')[0]);
  try { shot('erro'); } catch {}
} finally {
  try { ws.close(); } catch {}
  adb('forward', '--remove', `tcp:${PORT}`);
}

// Logcat e métricas.
const log = sh('logcat -d').split('\n').filter((l) => /chromium|Capacitor|AndroidRuntime|ANR in/i.test(l) && /\b[EF]\b|FATAL|ANR/.test(l) && !l.includes('Error injecting safe area CSS'));
console.log(`\nLogcat (erros chromium|Capacitor|AndroidRuntime): ${log.length} linhas`);
log.slice(0, 15).forEach((l) => console.log('  ' + l));
sh(`am start -n ${PKG}/.MainActivity`);
await sleep(3000);
const mem = sh(`dumpsys meminfo ${PKG}`).split('\n').find((l) => /^\s*TOTAL/.test(l));
console.log('Memória:', mem?.trim());
console.log(`Abertura a frio: ${tempoFrio} ms`);
const falhas = results.filter((r) => !r.ok);
console.log(`\n${results.length - falhas.length}/${results.length} verificações ok`);
process.exit(falhas.length ? 1 : 0);
