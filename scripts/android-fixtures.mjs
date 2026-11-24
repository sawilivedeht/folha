// Gera TXT/EPUB/PDF pequenos (reaproveita e2e/fixtures/make.mjs) e os envia para /sdcard/Download.
// Uso: node scripts/android-fixtures.mjs [diretório-de-saída]
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adb } from './android-lib.mjs';
import { gerarFixtures } from '../e2e/fixtures/make.mjs';

const dir = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'folha-fx-'));
const arqs = await gerarFixtures(dir);
for (const n of ['longo.txt', 'epub3.epub', 'texto.pdf']) {
  adb('push', arqs[n], '/sdcard/Download/');
  console.log('enviado', n);
}
