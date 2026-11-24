// Monkey: eventos aleatórios por várias sementes com um livro aberto; procura queda, ANR e tela branca.
// Uso: node scripts/android-monkey.mjs [sementes separadas por vírgula] [eventos]   (padrão: 11,22,33 e 5000)
// Pré-requisitos: emulador no ar, app instalado e longo.txt em /sdcard/Download (android-fixtures.mjs).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ADB, PKG, sh, sleep, ui, esperarUi, importarPeloSeletor, contaLivros, abrirLivro, logcatErros, pid, picos } from './android-lib.mjs';

const sementes = (process.argv[2] ?? '11,22,33').split(',');
const eventos = process.argv[3] ?? '5000';

sh('settings put system accelerometer_rotation 0');
sh('settings put system user_rotation 0');
sh(`pm clear ${PKG}`);
sh(`am start -n ${PKG}/.MainActivity`);
await esperarUi(/^Importar/, 20000);
await importarPeloSeletor('longo.txt', (nos) => contaLivros(nos) > 0, 60000);
await abrirLivro('O Grande Livro de Teste');

let falhas = 0;
for (const semente of sementes) {
  sh('logcat -c');
  const t0 = Date.now();
  let saida;
  try {
    saida = execFileSync(ADB, ['shell', 'monkey', '-p', PKG, '--pct-syskeys', '0', '-s', semente, '--throttle', '40', '-v', eventos], { encoding: 'utf8', maxBuffer: 256 << 20, timeout: 20 * 60 * 1000 });
  } catch (e) {
    saida = String(e.stdout ?? '') + String(e.message);
  }
  const s = (Date.now() - t0) / 1000;
  const completo = /Events injected: \d+/.test(saida) && !/\/\/ CRASH|ANR in|\/\/ Monkey aborted/.test(saida);
  const quedas = logcatErros();
  // O monkey pode ter saído do app (seletor de arquivos, etc.); volta e confere se a tela tem conteúdo.
  sh(`am start -n ${PKG}/.MainActivity`);
  await sleep(2500);
  // O uiautomator às vezes devolve uma árvore vazia logo após a volta; tenta por até ~8 s antes de acusar tela vazia.
  let nos = ui();
  for (let i = 0; i < 8 && !nos.some((n) => n.text || n.desc); i++) { await sleep(1000); nos = ui(); }
  const conteudo = nos.some((n) => n.text || n.desc);
  const png = execFileSync(ADB, ['exec-out', 'screencap', '-p'], { maxBuffer: 64 << 20 });
  const branca = png.length < 8000; // um PNG 1080x2400 de uma cor só comprime para poucos kB
  const p = picos();
  const ok = completo && quedas.length === 0 && !!pid() && conteudo && !branca;
  if (!ok) falhas++;
  console.log(`${ok ? 'OK   ' : 'FALHA'} semente ${semente}: ${saida.match(/Events injected: \d+/)?.[0] ?? 'sem resumo'} em ${s.toFixed(0)} s; quedas/ANR no logcat: ${quedas.length}; processo vivo: ${!!pid()}; conteúdo na tela: ${conteudo}; tela branca: ${branca}; pico de memória app ${(p.appKb / 1024).toFixed(0)} MB + renderer ${(p.rendererKb / 1024).toFixed(0)} MB`);
  quedas.slice(0, 3).forEach((l) => console.log('   ' + l));
  console.log('   hash da tela final:', createHash('md5').update(png).digest('hex').slice(0, 8));
}
process.exit(falhas ? 1 : 0);
