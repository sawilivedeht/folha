// Ciclo de vida e acessibilidade no aparelho: rotação, segundo plano, morte do processo, force-stop,
// trim de memória, tema escuro do sistema, escala de fonte, atualização por cima e "limpar dados".
// Só usa uiautomator/input/dumpsys (funciona em APK release, sem DevTools).
// Uso: node scripts/android-ciclo.mjs [caminho-do-apk-para-o-teste-de-atualização]
// Pré-requisitos: emulador no ar, app instalado e longo.txt em /sdcard/Download (android-fixtures.mjs).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PKG, adb, sh, pid, sleep, tap, tela, ui, esperarUi, importarPeloSeletor, contaLivros, visiveis, virar,
  abrirLivro, noLeitor, logcatErros, ADB,
} from './android-lib.mjs';

const apk = process.argv[2];
const SAIDA = process.env.CAPTURAS ?? join(tmpdir(), 'folha-ciclo');
mkdirSync(SAIDA, { recursive: true });
const resultados = [];
const check = (nome, ok, detalhe = '') => {
  resultados.push({ nome, ok });
  console.log(`${ok ? 'OK   ' : 'FALHA'} ${nome}${detalhe ? ' — ' + detalhe : ''}`);
};
const shot = (nome) => writeFileSync(join(SAIDA, `${nome}.png`), execFileSync(ADB, ['exec-out', 'screencap', '-p'], { maxBuffer: 64 << 20 }));
const mesma = (a, b) => a.some((t) => b.includes(t));
const TITULO = 'O Grande Livro de Teste';

// Estado inicial: dados limpos, retrato, fonte e tema padrão, livro importado e aberto.
sh('settings put system accelerometer_rotation 0');
sh('settings put system user_rotation 0');
sh('settings put system font_scale 1.0');
sh('cmd uimode night no');
sh(`pm clear ${PKG}`);
sh('logcat -c');
sh(`am start -n ${PKG}/.MainActivity`);
await esperarUi(/^Importar/, 20000);
await importarPeloSeletor('longo.txt', (nos) => contaLivros(nos) > 0, 60000);
await abrirLivro(TITULO);
for (let i = 0; i < 5; i++) { virar(1); await sleep(500); }
await sleep(800);
let ref = visiveis();
check('leitor mostra texto após avançar 5 páginas', ref.length > 0, ref[0]);
shot('leitor-referencia');

// 1. Rotação.
sh('settings put system user_rotation 1');
await sleep(2500);
let v = visiveis();
check('rotação para paisagem mantém a posição', mesma(ref, v), `antes "${ref[0]}", depois "${v[0]}"`);
shot('paisagem');
sh('settings put system user_rotation 0');
await sleep(2500);
v = visiveis();
check('volta ao retrato mantém a posição', mesma(ref, v), `"${v[0]}"`);
ref = v;

// 2. Segundo plano e volta.
sh('input keyevent KEYCODE_HOME');
await sleep(3000);
sh(`am start -n ${PKG}/.MainActivity`);
await sleep(1500);
v = visiveis();
check('segundo plano e volta mantêm a página', mesma(ref, v), `"${v[0]}"`);

// Reabre o app depois de uma morte e devolve o texto visível (entrando no livro, se cair na estante).
async function reabrirELer() {
  sh(`am start -n ${PKG}/.MainActivity`);
  await sleep(3500);
  let t = visiveis();
  let naEstante = false;
  if (!noLeitor()) {
    naEstante = true;
    await abrirLivro(TITULO);
    t = visiveis();
  }
  return { t, naEstante };
}

// 3. Morte do processo em segundo plano (am kill) depois de o app salvar a posição.
await sleep(2500);
sh('input keyevent KEYCODE_HOME');
await sleep(2000);
sh(`am kill ${PKG}`);
await sleep(1000);
check('am kill matou o processo', pid() === '', 'pidof vazio');
let r = await reabrirELer();
check('morte do processo: posição restaurada', mesma(ref, r.t), `${r.naEstante ? 'voltou pela estante' : 'abriu direto no leitor'}; "${r.t[0]}"`);

// 4. force-stop.
await sleep(2500);
sh(`am force-stop ${PKG}`);
r = await reabrirELer();
check('force-stop: posição restaurada', mesma(ref, r.t), `${r.naEstante ? 'voltou pela estante' : 'abriu direto no leitor'}; "${r.t[0]}"`);

// 5. Trim de memória.
sh(`am send-trim-memory ${PKG} RUNNING_CRITICAL`);
await sleep(2000);
check('trim RUNNING_CRITICAL: app vivo e com texto', pid() !== '' && mesma(ref, visiveis()));
sh('input keyevent KEYCODE_HOME');
await sleep(1000);
sh(`am send-trim-memory ${PKG} COMPLETE`);
await sleep(1500);
r = await reabrirELer();
check('trim COMPLETE em segundo plano e volta: posição mantida', mesma(ref, r.t), `"${r.t[0]}"`);

// 6. Tema escuro do sistema.
sh('cmd uimode night yes');
await sleep(2500);
v = visiveis();
check('tema escuro do sistema: texto continua na tela', mesma(ref, v), `"${v[0]}"`);
shot('noite-sistema');
sh('cmd uimode night no');
await sleep(1500);

// 7. Escala de fonte do sistema: o texto continua cabendo na página?
const t = tela();
const cabe = () => {
  const nos = ui().filter((x) => x.text.length > 40 && x.x1 >= 0 && x.x1 < t.w - 10 && x.y1 >= 100);
  const fora = nos.filter((x) => x.x2 > t.w + 1 || x.y2 > t.h + 1);
  // Parágrafos que atravessam o fim da página são cortados pelas colunas e reportam y2 grande; só x importa.
  return { n: nos.length, foraX: nos.filter((x) => x.x2 > t.w + 1).length, fora: fora.length };
};
for (const esc of ['1.3', '2.0']) {
  sh(`settings put system font_scale ${esc}`);
  await sleep(3000);
  const expulso = !noLeitor();
  if (expulso) await abrirLivro(TITULO);
  await sleep(500);
  const c = cabe();
  shot(`fonte-${esc}`);
  check(`escala de fonte ${esc}: parágrafos visíveis e dentro da largura`, c.n > 0 && c.foraX === 0, `${c.n} nós, ${c.foraX} passam da largura; ${expulso ? 'a mudança recriou a atividade e levou à estante' : 'ficou no leitor'}`);
  // Compara capturas (com fonte grande um parágrafo pode ocupar a página toda e a árvore de acessibilidade não muda).
  const antes = createHash('md5').update(execFileSync(ADB, ['exec-out', 'screencap', '-p'], { maxBuffer: 64 << 20 })).digest('hex');
  virar(1);
  await sleep(900);
  const depois = createHash('md5').update(execFileSync(ADB, ['exec-out', 'screencap', '-p'], { maxBuffer: 64 << 20 })).digest('hex');
  check(`escala de fonte ${esc}: ainda vira página`, antes !== depois, 'a tela mudou após o toque no terço direito');
}
sh('settings put system font_scale 1.0');
await sleep(2000);

// 8. Atualização por cima mantém a estante.
if (apk) {
  sh('input keyevent KEYCODE_HOME');
  console.log(adb('install', '-r', apk).trim().split('\n').pop());
  sh(`am start -n ${PKG}/.MainActivity`);
  await esperarUi(/^Importar|^Folha$/, 20000);
  await sleep(1500);
  const nos = ui();
  const temLivro = contaLivros(nos) >= 1;
  check('adb install -r mantém a estante', temLivro, `${contaLivros(nos)} livro(s) na estante`);
} else {
  console.log('(pulado: passe o caminho de um APK para testar a atualização por cima)');
}

// 9. Limpar dados.
sh(`pm clear ${PKG}`);
sh(`am start -n ${PKG}/.MainActivity`);
await esperarUi(/^Importar/, 20000);
check('"limpar dados" deixa a estante vazia', contaLivros() === 0);

const q = logcatErros();
check('sem queda nem ANR no logcat', q.length === 0, q.slice(0, 2).join(' | '));
const falhas = resultados.filter((x) => !x.ok);
console.log(`\n${resultados.length - falhas.length}/${resultados.length} verificações ok; capturas em ${SAIDA}`);
process.exit(falhas.length ? 1 : 0);
