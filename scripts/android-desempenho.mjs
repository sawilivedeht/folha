// Desempenho no aparelho: abertura a frio e morna, quadros (gfxinfo) em 50 viradas de página e memória
// (PSS) parada e depois de ler 100 páginas. Atenção: o emulador usa GPU por software (swiftshader),
// então os números de quadros são pessimistas em relação a um aparelho real.
// Uso: node scripts/android-desempenho.mjs
// Pré-requisitos: emulador no ar, app instalado e longo.txt em /sdcard/Download (android-fixtures.mjs).
import { PKG, sh, sleep, esperarUi, importarPeloSeletor, contaLivros, abrirLivro, memoria, virar, tela, pid } from './android-lib.mjs';

const mediana = (v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
const partida = (extra = '') => Number(sh(`am start -W ${extra} -n ${PKG}/.MainActivity`).match(/TotalTime:\s*(\d+)/)?.[1]);

sh('settings put system accelerometer_rotation 0');
sh('settings put system user_rotation 0');
sh(`pm clear ${PKG}`);
sh(`am start -n ${PKG}/.MainActivity`);
await esperarUi(/^Importar/, 20000);
await importarPeloSeletor('longo.txt', (nos) => contaLivros(nos) > 0, 60000);

// Abertura a frio (processo morto) e morna (processo vivo em segundo plano), 5 repetições cada.
const frio = [];
const morno = [];
for (let i = 0; i < 5; i++) {
  sh('input keyevent KEYCODE_HOME');
  sh(`am force-stop ${PKG}`);
  await sleep(1500);
  frio.push(partida());
  await sleep(2500);
}
for (let i = 0; i < 5; i++) {
  sh('input keyevent KEYCODE_HOME');
  await sleep(1500);
  morno.push(partida());
  await sleep(1500);
}
console.log(`Abertura a frio (TotalTime, ms): ${frio.join(', ')}; mediana ${mediana(frio)}`);
console.log(`Abertura morna (TotalTime, ms): ${morno.join(', ')}; mediana ${mediana(morno)}`);

await abrirLivro('O Grande Livro de Teste');
await sleep(2000);
const parado = memoria();
console.log(`Memória parada no leitor: PSS ${(parado.pssKb / 1024).toFixed(0)} MB`);

// 50 viradas de página medidas pelo gfxinfo.
sh(`dumpsys gfxinfo ${PKG} reset`);
const t = tela();
for (let i = 0; i < 50; i++) {
  virar(1, t);
  await sleep(350);
}
await sleep(500);
const g = sh(`dumpsys gfxinfo ${PKG}`);
const pega = (re) => g.match(re)?.[1];
console.log('Quadros em 50 viradas:',
  `renderizados ${pega(/Total frames rendered:\s*(\d+)/)},`,
  `janky ${pega(/Janky frames:\s*(\d+ \([\d.]+%\))/)},`,
  `p50 ${pega(/50th percentile:\s*(\d+ms)/)}, p90 ${pega(/90th percentile:\s*(\d+ms)/)},`,
  `p95 ${pega(/95th percentile:\s*(\d+ms)/)}, p99 ${pega(/99th percentile:\s*(\d+ms)/)}`);

// Mais 50 viradas (100 no total) e a memória depois de ler.
for (let i = 0; i < 50; i++) {
  virar(1, t);
  await sleep(250);
}
await sleep(1500);
const lido = memoria();
console.log(`Memória após 100 páginas: PSS ${(lido.pssKb / 1024).toFixed(0)} MB (parado: ${(parado.pssKb / 1024).toFixed(0)} MB); pico RSS do app ${(lido.picoRssKb / 1024).toFixed(0)} MB; processo vivo: ${!!pid()}`);
