// Importa TXT, EPUB e PDFs de /sdcard/Download pelo seletor de arquivos do sistema (DocumentsUI),
// medindo o tempo e a memória de pico de cada conversão. Funciona em APK debug ou release.
// Uso: node scripts/android-importar.mjs [arquivo ...]   (padrão: longo.txt epub3.epub texto.pdf)
// Antes: scripts/android-emulator.sh e node scripts/android-fixtures.mjs (e, se quiser, push de um PDF grande).
import { PKG, sh, sleep, esperarUi, importarPeloSeletor, contaLivros, picos, memoria, logcatErros } from './android-lib.mjs';

const arquivos = process.argv.slice(2);
if (!arquivos.length) arquivos.push('longo.txt', 'epub3.epub', 'texto.pdf');

sh('am force-stop com.google.android.apps.docs');
sh(`pm clear ${PKG}`);
sh('logcat -c');
sh(`am start -n ${PKG}/.MainActivity`);
await esperarUi(/^Importar/, 20000);

let falhas = 0;
for (const nome of arquivos) {
  const antes = contaLivros();
  let ms;
  try {
    ms = await importarPeloSeletor(nome, (nos) => contaLivros(nos) > antes, 600000,);
  } catch (e) {
    falhas++;
    console.log(`FALHA ${nome}: ${e.message}`);
    continue;
  }
  const m = memoria();
  const p = picos();
  console.log(`OK    ${nome}: ${(ms / 1000).toFixed(1)} s até o cartão aparecer; pico acumulado: app ${(p.appKb / 1024).toFixed(0)} MB + renderer ${(p.rendererKb / 1024).toFixed(0)} MB (VmHWM); PSS do app agora ${(m.pssKb / 1024).toFixed(0)} MB`);
  await sleep(1000);
}
const l = logcatErros();
console.log(`Logcat (crash/ANR): ${l.length} linhas`);
l.slice(0, 8).forEach((x) => console.log('  ' + x));
process.exit(falhas || l.length ? 1 : 0);
