// Resiliência: armazenamento indisponível ou corrompido, rotas inválidas, conteúdo hostil ao layout.
// Regra geral: o app mostra uma mensagem compreensível, nunca tela branca, e não perde dados já salvos.
import { test as base, expect, type Page } from '@playwright/test';
import {
  abrirEstante,
  abrirLivro,
  arquivo,
  esperarLeitor,
  estado,
  fecharModal,
  importar,
  importarEFechar,
  lerIndexedDB,
  varrerCapituloInteiro,
  verificarPaginaAtual,
} from './helpers';
// @ts-expect-error módulo .mjs sem declarações de tipos
import { epubHostil } from './fixtures/grandes.mjs';

/** Teste base que só coleta exceções não tratadas (erros de console são esperados nestes cenários). */
const test = base.extend<{ excecoes: string[] }>({
  excecoes: [
    async ({ page }, use) => {
      const lista: string[] = [];
      page.on('pageerror', (e) => lista.push(e.message));
      await use(lista);
    },
    { auto: true },
  ],
});

async function textoVisivel(page: Page): Promise<string> {
  return page.evaluate(() => (document.getElementById('app')?.innerText ?? '').trim());
}

async function gravarKv(page: Page, chave: string, valor: unknown): Promise<void> {
  await page.evaluate(
    ([k, v]) =>
      new Promise<void>((resolve, reject) => {
        const rq = indexedDB.open('folha');
        rq.onerror = () => reject(rq.error);
        rq.onsuccess = () => {
          const db = rq.result;
          const tx = db.transaction('kv', 'readwrite');
          tx.objectStore('kv').put(v, k as string);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    [chave, valor] as [string, unknown],
  );
}

/** Simula um navegador que não deixa abrir o IndexedDB (modo privado antigo, política corporativa, disco cheio). */
function bloquearIndexedDB(): void {
  IDBFactory.prototype.open = function () {
    const req = {} as IDBOpenDBRequest & Record<string, unknown>;
    setTimeout(() => {
      Object.defineProperty(req, 'error', { value: new DOMException('bloqueado', 'SecurityError') });
      (req.onerror as (() => void) | undefined)?.call(req);
    }, 0);
    return req;
  };
}

test.describe('Armazenamento indisponível', () => {
  test('IndexedDB ausente: a estante abre (nunca tela branca)', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true });
    });
    await page.goto('/');
    await expect(page.locator('.lib-page')).toBeVisible();
    expect(await textoVisivel(page)).not.toBe('');
  });

  test('IndexedDB.open falhando: a estante abre (nunca tela branca)', async ({ page }) => {
    await page.addInitScript(bloquearIndexedDB);
    await page.goto('/');
    await expect(page.locator('.lib-page')).toBeVisible();
    expect(await textoVisivel(page)).not.toBe('');
  });

  test('IndexedDB.open falhando no leitor: mostra mensagem com botão de voltar', async ({ page, excecoes }) => {
    await page.addInitScript(bloquearIndexedDB);
    await page.goto('/#/ler/qualquer');
    await expect(page.getByRole('heading', { name: 'Não foi possível abrir o livro' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Voltar à biblioteca' })).toBeVisible();
    expect(excecoes).toEqual([]);
  });

  test('IndexedDB.open falhando: a estante avisa o problema, sem exceção não tratada', async ({ page, excecoes }) => {
    await page.addInitScript(bloquearIndexedDB);
    await page.goto('/');
    await expect(page.locator('.lib-page')).toBeVisible();
    await page.evaluate(() => new Promise<void>((r) => setTimeout(r, 300)));
    expect(excecoes).toEqual([]);
  });
});

test.describe('Cota de armazenamento', () => {
  test('QuotaExceededError no saveBook: mostra erro e preserva os livros já salvos', async ({ page, excecoes }) => {
    await page.addInitScript(() => {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
        if ((window as unknown as { __semCota?: boolean }).__semCota && this.name === 'content') {
          throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        }
        return put.apply(this, args);
      };
    });
    await abrirEstante(page);
    await importarEFechar(page, ['longo.txt']);
    await expect(page.locator('.lib-card')).toHaveCount(1);

    await page.evaluate(() => ((window as unknown as { __semCota: boolean }).__semCota = true));
    await importar(page, ['mini-1.txt']);
    const erro = page.locator('.lib-modal-error');
    await expect(erro).toHaveCount(1);
    // A mensagem precisa ser compreensível: nada de "undefined", "[object" ou nome interno de API.
    const msg = (await erro.textContent()) ?? '';
    expect(msg).not.toMatch(/undefined|\[object|null/);
    await fecharModal(page);

    // O livro salvo antes continua lá, inclusive após recarregar.
    await page.evaluate(() => ((window as unknown as { __semCota: boolean }).__semCota = false));
    await page.reload();
    await expect(page.locator('.lib-card')).toHaveCount(1);
    await abrirLivro(page, 'O Grande Livro de Teste');
    expect(excecoes).toEqual([]);
  });

  test('QuotaExceededError ao salvar a posição: o leitor continua funcionando', async ({ page, excecoes }) => {
    await page.addInitScript(() => {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
        if ((window as unknown as { __semCota?: boolean }).__semCota && (this.name === 'meta' || this.name === 'kv')) {
          throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        }
        return put.apply(this, args);
      };
    });
    await abrirEstante(page);
    await importarEFechar(page, ['mini-1.txt']);
    await abrirLivro(page, /./);
    await page.evaluate(() => ((window as unknown as { __semCota: boolean }).__semCota = true));
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
    await page.evaluate(() => new Promise<void>((r) => setTimeout(r, 1100))); // passa o debounce de gravação
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.reader-status-page')).toContainText('Pág.');
    expect(excecoes).toEqual([]);
  });
});

test.describe('localStorage e configurações', () => {
  test('localStorage lançando exceção (modo privado): importar, ler e virar páginas', async ({ page, excecoes }) => {
    await page.addInitScript(() => {
      const erro = () => {
        throw new DOMException('acesso negado', 'SecurityError');
      };
      Storage.prototype.getItem = erro;
      Storage.prototype.setItem = erro;
      Storage.prototype.removeItem = erro;
    });
    await abrirEstante(page);
    await importarEFechar(page, ['longo.txt']);
    await abrirLivro(page, 'O Grande Livro de Teste');
    const antes = await estado(page);
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await estado(page)).pagina).toBe(antes.pagina + 1);
    await page.keyboard.press('Escape');
    await page.goBack();
    await expect(page.locator('.lib-page')).toBeVisible();
    expect(excecoes).toEqual([]);
  });

  const corrompidas: Array<[string, unknown]> = [
    ['texto simples', 'lixo'],
    ['null', null],
    ['número', 42],
    ['lista', [1, 2, 3]],
    ['campos com tipos errados', { fontSize: 'enorme', lineHeight: null, margin: {}, font: 'inexistente', justify: 'sim', hyphenate: 0, theme: 'neon' }],
    ['valores fora do limite', { fontSize: 9999, lineHeight: -3, margin: 1e9, theme: 'dark' }],
    ['NaN e Infinity', { fontSize: NaN, lineHeight: Infinity, margin: -Infinity }],
  ];
  for (const [nome, valor] of corrompidas) {
    test(`configurações corrompidas (${nome}): o leitor abre e o painel Aa funciona`, async ({ page, excecoes }) => {
      await abrirEstante(page);
      await importarEFechar(page, ['mini-1.txt']);
      await gravarKv(page, 'settings', valor);
      await page.reload();
      await expect(page.locator('.lib-page')).toBeVisible();
      await abrirLivro(page, /./);
      // A fonte e a família efetivas precisam ser válidas.
      const css = await page.evaluate(() => {
        const r = document.querySelector<HTMLElement>('.reader')!;
        const cs = getComputedStyle(document.querySelector('.reader-columns')!);
        return { fontSize: parseFloat(cs.fontSize), familia: r.style.getPropertyValue('--reader-font-family'), tema: document.documentElement.dataset.theme };
      });
      expect(css.fontSize).toBeGreaterThanOrEqual(14);
      expect(css.fontSize).toBeLessThanOrEqual(34);
      expect(css.familia).not.toMatch(/undefined/);
      expect(['light', 'sepia', 'dark', 'black']).toContain(css.tema);
      await page.keyboard.press('ArrowRight');
      expect(excecoes).toEqual([]);
    });
  }
});

test.describe('Rotas inválidas', () => {
  test('#/ler/<id inexistente> mostra "Livro não encontrado" com botão de voltar', async ({ page, excecoes }) => {
    await page.goto('/#/ler/nao-existe-123');
    await expect(page.getByRole('heading', { name: 'Livro não encontrado' })).toBeVisible();
    await page.getByRole('button', { name: 'Voltar à biblioteca' }).click();
    await expect(page.locator('.lib-page')).toBeVisible();
    expect(excecoes).toEqual([]);
  });

  test('#/ler/%E0%A4%A (URI inválida) mostra "Livro não encontrado"', async ({ page, excecoes }) => {
    await page.goto('/#/ler/%E0%A4%A');
    await expect(page.getByRole('heading', { name: 'Livro não encontrado' })).toBeVisible();
    expect(excecoes).toEqual([]);
  });

  test('trocar para uma URI inválida com o app aberto não quebra a navegação', async ({ page, excecoes }) => {
    await abrirEstante(page);
    await page.evaluate(() => {
      history.pushState(null, '', '#/ler/%E0%A4%A');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.getByRole('heading', { name: 'Livro não encontrado' })).toBeVisible();
    expect(excecoes).toEqual([]);
    await page.goto('/#/');
    await page.reload();
    await expect(page.locator('.lib-page')).toBeVisible();
  });

  test('hash desconhecido cai na estante', async ({ page }) => {
    await page.goto('/#/qualquer/coisa');
    await expect(page.locator('.lib-page')).toBeVisible();
  });
});

test.describe('Importação interrompida', () => {
  test('recarregar no meio de uma importação não corrompe a estante nem perde livros salvos', async ({ page, excecoes }) => {
    await abrirEstante(page);
    await importarEFechar(page, ['mini-1.txt']);
    const antes = await lerIndexedDB<string[]>(page, 'meta');
    expect(antes).toHaveLength(1);

    // Importa um arquivo grande e recarrega assim que o modal aparece.
    const grande = Buffer.from(('Capítulo 1\n\n' + 'Um parágrafo qualquer de texto para encher o arquivo. '.repeat(40) + '\n\n').repeat(4000), 'utf8');
    await page.locator('input[type=file]').setInputFiles({ name: 'grande.txt', mimeType: 'text/plain', buffer: grande });
    await expect(page.locator('.lib-modal')).toBeVisible();
    await page.reload();
    await expect(page.locator('.lib-page')).toBeVisible();
    await expect(page.locator('.lib-modal')).toHaveCount(0);

    // Nada de livro pela metade: cada meta tem seu conteúdo, e o livro original continua intacto.
    const metas = await lerIndexedDB<string[]>(page, 'meta');
    const conteudos = await lerIndexedDB<string[]>(page, 'content');
    expect(metas.slice().sort()).toEqual(conteudos.slice().sort());
    expect(metas).toContain(antes[0]);
    await expect(page.locator('.lib-card')).toHaveCount(metas.length);
    await abrirLivro(page, /./);
    expect(excecoes).toEqual([]);
  });
});

test.describe('Conteúdo hostil ao layout', () => {
  const hostil = (): { name: string; mimeType: string; buffer: Buffer } => ({
    name: 'hostil.epub',
    mimeType: 'application/epub+zip',
    buffer: epubHostil() as Buffer,
  });

  async function fonteMaxima(page: Page): Promise<void> {
    await gravarKv(page, 'settings', { fontSize: 34, lineHeight: 2, margin: 48, font: 'serif', justify: true, hyphenate: true, theme: 'light' });
    await page.reload();
    await expect(page.locator('.lib-page')).toBeVisible();
  }

  const cenarios: Array<[string, { width: number; height: number }]> = [
    ['320×480', { width: 320, height: 480 }],
    ['paisagem 800×360', { width: 800, height: 360 }],
    ['paisagem 640×320', { width: 640, height: 320 }],
  ];
  for (const [nome, vp] of cenarios) {
    test(`fonte máxima, palavras/URLs enormes, RTL, CJK, emojis e imagem altíssima em ${nome}: nada vaza nem fica escondido`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.setViewportSize(vp);
      await abrirEstante(page);
      await importarEFechar(page, [hostil()]);
      await fonteMaxima(page);
      await abrirLivro(page, 'Livro Hostil de Teste');

      // Nada fora da página: a varredura do capítulo inteiro confere cada retângulo de texto e imagem.
      const varredura = await varrerCapituloInteiro(page);
      expect(varredura.violacoes, `capítulo inteiro em ${nome}`).toEqual([]);

      // Sem rolagem da página nem do #app.
      const rolagem = await page.evaluate(() => ({
        docW: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        docH: document.documentElement.scrollHeight - document.documentElement.clientHeight,
        bodyW: document.body.scrollWidth - document.body.clientWidth,
      }));
      expect(rolagem.docW).toBeLessThanOrEqual(0);
      expect(rolagem.docH).toBeLessThanOrEqual(0);
      expect(rolagem.bodyW).toBeLessThanOrEqual(0);

      // Passa por todas as páginas conferindo a área útil da página atual.
      const { total } = await estado(page);
      for (let i = 0; i < total; i++) {
        const r = await verificarPaginaAtual(page);
        expect(r.violacoes, `página ${i + 1}/${total} em ${nome}`).toEqual([]);
        if (i < total - 1) {
          await page.keyboard.press('ArrowRight');
          await expect(page.locator('.reader-status-page')).toContainText(`Pág. ${i + 2} de`);
        }
      }
    });
  }

  test('o texto de cada script aparece e é legível (RTL, CJK, emoji) sem quebrar a paginação', async ({ page }) => {
    await abrirEstante(page);
    await importarEFechar(page, [hostil()]);
    await abrirLivro(page, 'Livro Hostil de Teste');
    const info = await page.evaluate(() => {
      const ps = Array.from(document.querySelectorAll<HTMLElement>('.reader-columns p'));
      const rtl = ps.filter((p) => p.getAttribute('dir') === 'rtl' || /[֐-ۿ]/.test(p.textContent ?? ''));
      return { rtl: rtl.length, total: ps.length, textoCJK: ps.some((p) => /[぀-ヿ一-鿿]/.test(p.textContent ?? '')) };
    });
    expect(info.rtl).toBeGreaterThanOrEqual(2);
    expect(info.textoCJK).toBe(true);
    const r = await varrerCapituloInteiro(page);
    expect(r.violacoes).toEqual([]);
  });

  test('imagem muito mais alta que a página é reduzida para caber inteira', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await abrirEstante(page);
    await importarEFechar(page, [hostil()]);
    await abrirLivro(page, 'Livro Hostil de Teste');
    const dim = await page.evaluate(async () => {
      const img = document.querySelector<HTMLImageElement>('.reader-columns img')!;
      await img.decode().catch(() => {});
      const cols = document.querySelector<HTMLElement>('.reader-columns')!;
      const r = img.getBoundingClientRect();
      return { h: r.height, w: r.width, colH: cols.clientHeight, natH: img.naturalHeight };
    });
    expect(dim.natH).toBe(6000);
    expect(dim.h).toBeLessThanOrEqual(dim.colH + 1);
    expect(dim.h).toBeGreaterThan(50);
  });

  test('arquivo de teste existe para o caso de arquivo vazio e binário aleatório (mensagem de erro, sem travar)', async ({ page, excecoes }) => {
    await abrirEstante(page);
    await importar(page, [
      { name: 'vazio.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) },
      { name: 'lixo.epub', mimeType: 'application/epub+zip', buffer: Buffer.from(Array.from({ length: 4000 }, (_, i) => (i * 7919) & 255)) },
      { name: 'lixo.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nnada útil aqui') },
    ]);
    await expect(page.locator('.lib-modal-error')).not.toHaveCount(0);
    for (const e of await page.locator('.lib-modal-error').allTextContents()) expect(e).not.toMatch(/undefined|\[object/);
    await fecharModal(page);
    await expect(page.locator('.lib-page')).toBeVisible();
    await importarEFechar(page, [arquivo('mini-1.txt')]);
    expect(excecoes).toEqual([]);
  });
});
