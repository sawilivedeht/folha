// Gera as capturas de tela do README em docs/capturas/*.png.
// Uso: npm run build && node docs/capturas.mjs
// Sobe `vite preview` na porta 4319, importa docs/exemplo.txt e fotografa a interface em viewport Pixel 7.
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from '@playwright/test';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const saida = resolve(raiz, 'docs/capturas');
const porta = 4319;
const url = `http://localhost:${porta}/`;

await mkdir(saida, { recursive: true });
const servidor = spawn(resolve(raiz, 'node_modules/.bin/vite'), ['preview', '--port', String(porta), '--strictPort'], { cwd: raiz, stdio: 'ignore' });

async function aguardarServidor() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* ainda subindo */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('vite preview não respondeu');
}

try {
  await aguardarServidor();
  const navegador = await chromium.launch();
  const contexto = await navegador.newContext({ ...devices['Pixel 7'], deviceScaleFactor: 1.25, locale: 'pt-BR', reducedMotion: 'reduce' });
  const pagina = await contexto.newPage();
  await pagina.goto(url);

  // O mesmo texto vira alguns livros com títulos diferentes, para a estante parecer real.
  const texto = await readFile(resolve(raiz, 'docs/exemplo.txt'), 'utf8');
  const titulos = ['Contos do Farol', 'O Jardim das Marés', 'Cartas de Inverno', 'A Biblioteca Esquecida'];
  await pagina.setInputFiles(
    'input[type=file]',
    titulos.map((t) => ({
      name: `${t}.txt`,
      mimeType: 'text/plain',
      buffer: Buffer.from(texto.replace('Contos do Farol', t), 'utf8'),
    })),
  );
  await pagina.locator('.lib-card').nth(titulos.length - 1).waitFor({ timeout: 15000 });
  await pagina.waitForTimeout(500);
  await pagina.screenshot({ path: resolve(saida, 'estante.png') });

  await pagina.locator('.lib-card .lib-cover-wrap').first().click();
  await pagina.locator('.reader-columns').waitFor({ timeout: 15000 });
  await pagina.waitForTimeout(800);
  // Avança algumas páginas para a captura não mostrar só o título.
  for (let i = 0; i < 2; i++) await pagina.keyboard.press('ArrowRight');
  await pagina.waitForTimeout(400);
  await pagina.screenshot({ path: resolve(saida, 'leitor.png') });

  const tamanho = pagina.viewportSize();
  await pagina.mouse.click(tamanho.width / 2, tamanho.height / 2);
  await pagina.getByLabel('Configurações de leitura').first().click();
  await pagina.waitForTimeout(500);
  await pagina.screenshot({ path: resolve(saida, 'painel-aa.png') });

  await pagina.getByRole('button', { name: 'Escuro' }).click();
  await pagina.waitForTimeout(300);
  await pagina.getByLabel('Fechar configurações').click();
  await pagina.waitForTimeout(500);
  await pagina.screenshot({ path: resolve(saida, 'tema-escuro.png') });

  await navegador.close();
} finally {
  servidor.kill();
}
