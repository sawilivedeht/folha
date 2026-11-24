// Estante: ordenação por autor, filtro ao excluir, modal em lote, importação de borda,
// ciclo de vida com dois livros e resiliência do banco local.
import { test as base, type Page } from '@playwright/test';
import {
  test,
  expect,
  abrirEstante,
  abrirLivro,
  arquivo,
  esperarLeitor,
  estado,
  fecharModal,
  importar,
  importarEFechar,
  lerIndexedDB,
  mostrarHud,
  type ArquivoMemoria,
} from './helpers';

interface MetaResumida {
  id: string;
  title: string;
  author?: string;
  lastOpenedAt?: number;
  percent: number;
  position: { chapter: number; block: number };
  bookmarks: Array<{ chapter: number; block: number; label: string; at: number }>;
}

/** Variante para testes com injeção de falha no IndexedDB (verifica ausência de pageerror). */
const testFalha = base.extend<{ excecoes: string[] }>({
  excecoes: [
    async ({ page }, use) => {
      const lista: string[] = [];
      page.on('pageerror', (e) => lista.push(e.message));
      await use(lista);
    },
    { auto: true },
  ],
});

async function listarMetas(page: Page): Promise<MetaResumida[]> {
  const ids = await lerIndexedDB<string[]>(page, 'meta');
  const metas: MetaResumida[] = [];
  for (const id of ids) {
    const m = await lerIndexedDB<MetaResumida>(page, 'meta', id);
    if (m) metas.push(m);
  }
  return metas;
}

async function metaPorTitulo(page: Page, titulo: string): Promise<MetaResumida | undefined> {
  const metas = await listarMetas(page);
  return metas.find((m) => m.title === titulo);
}

async function definirAutorNoBanco(page: Page, titulo: string, autor: string): Promise<void> {
  await page.evaluate(
    ([alvo, novoAutor]) =>
      new Promise<void>((resolve, reject) => {
        const rq = indexedDB.open('folha');
        rq.onerror = () => reject(rq.error);
        rq.onsuccess = () => {
          const db = rq.result;
          const tx = db.transaction('meta', 'readwrite');
          const st = tx.objectStore('meta');
          const all = st.getAll();
          all.onsuccess = () => {
            const lista = all.result as MetaResumida[];
            const item = lista.find((m) => m.title === alvo);
            if (item) {
              st.put({ ...item, author: novoAutor }, item.id);
            }
          };
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    [titulo, autor] as [string, string],
  );
}

async function avancarPaginas(page: Page, passos: number): Promise<number> {
  let atual = await estado(page);
  const limite = Math.min(passos, Math.max(0, atual.total - atual.pagina));
  for (let i = 0; i < limite; i++) {
    const esperada = atual.pagina + 1;
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await estado(page)).pagina).toBe(esperada);
    atual = await estado(page);
  }
  return atual.pagina;
}

async function excluirCard(page: Page, titulo: string): Promise<void> {
  const card = page.locator('.lib-grid .lib-card', { hasText: titulo }).first();
  await card.getByRole('button', { name: /Opções para/ }).click();
  await page.getByRole('button', { name: 'Excluir' }).click();
  await page.locator('.lib-modal .lib-btn-danger').click();
  await expect(page.locator('.lib-modal')).toHaveCount(0);
}

test.describe('Estante — ordenação, busca e modal', () => {
  test('ordenação por autor envia livros sem autor para o fim e desempata por título', async ({ page }) => {
    await abrirEstante(page);
    await importarEFechar(page, ['mini-2.txt', 'mini-1.txt', 'mini-3.txt', 'epub2.epub', 'epub3.epub']);
    await definirAutorNoBanco(page, 'Livro C3', 'Autora Exemplar');
    await page.reload();
    await expect(page.locator('.lib-page')).toBeVisible();

    await page.getByLabel('Ordenar livros').selectOption('author');
    await expect(page.locator('.lib-grid .lib-card-title')).toHaveText([
      'Livro C3',
      'Livro EPUB Três',
      'Livro EPUB Dois',
      'Livro A1',
      'Livro B2',
    ]);
  });

  test('excluir livro filtrado ao cair de 9 para 8 livros limpa o filtro e exibe os restantes', async ({ page }) => {
    await abrirEstante(page);
    const nove: ArquivoMemoria[] = [];
    for (let i = 1; i <= 8; i++) nove.push(arquivo(`mini-${i}.txt`));
    nove.push(arquivo('epub3.epub'));
    await importarEFechar(page, nove);

    const busca = page.getByLabel('Buscar livros por título ou autor');
    await expect(busca).toBeVisible();
    await busca.fill('exemplar');
    await expect(page.locator('.lib-grid .lib-card')).toHaveCount(1);

    await excluirCard(page, 'Livro EPUB Três');

    await expect(busca).toHaveCount(0);
    await expect(page.locator('.lib-no-results')).toHaveCount(0);
    await expect(page.locator('.lib-grid .lib-card')).toHaveCount(8);
  });

  test('muitos erros em lote no celular pequeno mantêm modal rolável, ocultam nome do último arquivo e fecham pelo fundo', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await abrirEstante(page);

    const lote: ArquivoMemoria[] = [arquivo('mini-1.txt')];
    for (let i = 1; i <= 9; i++) {
      lote.push({
        name: `invalido-${i}.docx`,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        buffer: Buffer.from(`PK\x03\x04falso-${i}`),
      });
    }
    // Último arquivo do lote é válido: o resumo final não deve exibir o nome dele sob "Importação com erro".
    lote.push(arquivo('mini-2.txt'));

    await importar(page, lote);
    await expect(page.locator('.lib-modal-title')).toHaveText('Importação com erro');
    await expect(page.locator('.lib-modal-error')).toHaveCount(9);
    await expect(page.locator('.lib-modal .lib-modal-text', { hasText: 'mini-2.txt' })).toBeHidden();

    const geom = await page.evaluate(() => {
      const m = document.querySelector<HTMLElement>('.lib-modal')!;
      const r = m.getBoundingClientRect();
      return {
        altura: r.height,
        clientH: m.clientHeight,
        scrollH: m.scrollHeight,
        overflowY: getComputedStyle(m).overflowY,
      };
    });
    expect(geom.altura).toBeLessThanOrEqual(640);
    expect(geom.overflowY).toBe('auto');
    expect(geom.scrollH).toBeGreaterThan(geom.clientH);

    const fecharBtn = page.locator('.lib-modal').getByRole('button', { name: 'Fechar' });
    await fecharBtn.scrollIntoViewIfNeeded();
    await expect(fecharBtn).toBeVisible();

    // Depois que a importação termina, tocar no backdrop fecha o modal.
    await page.locator('.lib-backdrop').click({ position: { x: 4, y: 4 } });
    await expect(page.locator('.lib-modal')).toHaveCount(0);
    await expect(page.locator('.lib-grid .lib-card')).toHaveCount(2);
  });
});

test.describe('Estante — importação de borda (lacuna 3)', () => {
  test('lote misto com EPUB, Markdown, TXT vazio e arquivos corrompidos importa os válidos e lista cada erro', async ({ page }) => {
    await abrirEstante(page);
    await importar(page, [
      arquivo('epub3.epub'),
      { name: 'vazio.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) },
      {
        name: 'notas.md',
        mimeType: 'text/plain',
        buffer: Buffer.from('Notas de Estudo\n\nCapítulo 1\n\nParágrafo inicial das notas em formato Markdown.\n'),
      },
      {
        name: 'corrompido.epub',
        mimeType: 'application/epub+zip',
        buffer: Buffer.from('PK\x03\x04conteudo epub quebrado'),
      },
      arquivo('corrompido.pdf'),
    ]);

    await expect(page.locator('.lib-modal-title')).toHaveText('Importação com erro');
    const erros = page.locator('.lib-modal-error');
    await expect(erros).toHaveCount(3);
    const textosErro = await erros.allTextContents();
    expect(textosErro.some((t) => t.includes('vazio.txt'))).toBe(true);
    expect(textosErro.some((t) => t.includes('corrompido.epub'))).toBe(true);
    expect(textosErro.some((t) => t.includes('corrompido.pdf'))).toBe(true);
    for (const t of textosErro) expect(t).not.toMatch(/undefined|\[object|TypeError/);

    await fecharModal(page);
    await expect(page.locator('.lib-grid .lib-card')).toHaveCount(2);

    await abrirLivro(page, 'Notas de Estudo');
    await expect(page.locator('.reader-columns')).toContainText('Parágrafo inicial das notas');
    await mostrarHud(page);
    await page.getByRole('button', { name: 'Voltar à biblioteca' }).click();
    await expect(page.locator('.lib-page')).toBeVisible();

    await abrirLivro(page, 'Livro EPUB Três');
    await expect(page.locator('.reader-columns')).toContainText('A casa na colina');
  });

  test('arrastar e soltar arquivo na estante exibe overlay e importa o livro', async ({ page }) => {
    await abrirEstante(page);

    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(
        new File(
          ['Livro Arrastado\n\nCapítulo 1\n\nTexto importado por arrastar e soltar na estante.\n'],
          'arrastado.txt',
          { type: 'text/plain' },
        ),
      );
      window.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    await expect(page.locator('.lib-drop-overlay')).toBeVisible();

    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(
        new File(
          ['Livro Arrastado\n\nCapítulo 1\n\nTexto importado por arrastar e soltar na estante.\n'],
          'arrastado.txt',
          { type: 'text/plain' },
        ),
      );
      window.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      window.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    });

    await expect(page.locator('.lib-drop-overlay')).toBeHidden();
    await expect(page.locator('.lib-grid .lib-card', { hasText: 'Livro Arrastado' })).toHaveCount(1);
    await abrirLivro(page, 'Livro Arrastado');
    await expect(page.locator('.reader-columns')).toContainText('Texto importado por arrastar e soltar');
  });

  test('reimportar o mesmo livro e excluir a cópia nova preserva posição e blobs da primeira cópia', async ({ page }) => {
    await abrirEstante(page);
    await importarEFechar(page, ['epub3.epub']);
    await abrirLivro(page, 'Livro EPUB Três');

    const paginaLida = await avancarPaginas(page, 2);
    expect(paginaLida).toBeGreaterThan(1);
    await mostrarHud(page);
    await page.getByRole('button', { name: 'Voltar à biblioteca' }).click();
    await expect(page.locator('.lib-page')).toBeVisible();

    const metaOriginal = (await metaPorTitulo(page, 'Livro EPUB Três'))!;
    expect(metaOriginal.percent).toBeGreaterThan(0);

    // Reimporta o mesmo arquivo: cria uma segunda entrada marcada como "Novo".
    await importarEFechar(page, ['epub3.epub']);
    await expect(page.locator('.lib-grid .lib-card')).toHaveCount(2);

    const copiaNova = page.locator('.lib-grid .lib-card', {
      has: page.locator('.lib-progress-label', { hasText: 'Novo' }),
    });
    await expect(copiaNova).toHaveCount(1);
    await copiaNova.getByRole('button', { name: /Opções para/ }).click();
    await page.getByRole('button', { name: 'Excluir' }).click();
    await page.locator('.lib-modal .lib-btn-danger').click();
    await expect(page.locator('.lib-grid .lib-card')).toHaveCount(1);

    // Os blobs (capa + ilustração) e o progresso da primeira cópia continuam intactos.
    const blobs = await lerIndexedDB<string[]>(page, 'blobs');
    expect(blobs.filter((k) => k.startsWith(`${metaOriginal.id}/`)).length).toBeGreaterThanOrEqual(2);
    const capa = page.locator('.lib-grid .lib-cover-img').first();
    await expect(capa).toBeVisible();
    await expect.poll(() => capa.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);

    await abrirLivro(page, 'Livro EPUB Três');
    expect((await estado(page)).pagina).toBe(paginaLida);
  });
});

test.describe('Estante — ciclo de vida com dois livros (lacuna 4)', () => {
  test('Mais recentes por leitura, conteúdo de Detalhes, Continuar lendo após exclusão e isolamento de dados', async ({ page }) => {
    await abrirEstante(page);
    await importarEFechar(page, ['epub2.epub']);
    await importarEFechar(page, ['epub3.epub']);

    // Lê epub2 e cria marcador.
    await abrirLivro(page, 'Livro EPUB Dois');
    const pagEpub2 = await avancarPaginas(page, 2);
    expect(pagEpub2).toBeGreaterThan(1);
    await mostrarHud(page);
    await page.getByRole('button', { name: 'Marcar esta página' }).click();
    await expect.poll(async () => (await metaPorTitulo(page, 'Livro EPUB Dois'))?.bookmarks.length ?? 0).toBe(1);
    await page.getByRole('button', { name: 'Voltar à biblioteca' }).click();
    await expect(page.locator('.lib-page')).toBeVisible();

    // Lê epub3 e cria marcador.
    await abrirLivro(page, 'Livro EPUB Três');
    const pagEpub3 = await avancarPaginas(page, 2);
    expect(pagEpub3).toBeGreaterThan(1);
    await mostrarHud(page);
    await page.getByRole('button', { name: 'Marcar esta página' }).click();
    await expect.poll(async () => (await metaPorTitulo(page, 'Livro EPUB Três'))?.bookmarks.length ?? 0).toBe(1);
    await page.getByRole('button', { name: 'Voltar à biblioteca' }).click();
    await expect(page.locator('.lib-page')).toBeVisible();

    // epub3 foi o último aberto: aparece primeiro em "Mais recentes" e em "Continuar lendo".
    await expect(page.locator('.lib-continue-card')).toContainText('Livro EPUB Três');
    await expect(page.locator('.lib-grid .lib-card-title')).toHaveText(['Livro EPUB Três', 'Livro EPUB Dois']);

    // Reabrir epub2 move epub2 para o topo de "Mais recentes" e para "Continuar lendo".
    await abrirLivro(page, 'Livro EPUB Dois');
    await mostrarHud(page);
    await page.getByRole('button', { name: 'Voltar à biblioteca' }).click();
    await expect(page.locator('.lib-page')).toBeVisible();
    await expect(page.locator('.lib-continue-card')).toContainText('Livro EPUB Dois');
    await expect(page.locator('.lib-grid .lib-card-title')).toHaveText(['Livro EPUB Dois', 'Livro EPUB Três']);

    // Conteúdo completo do modal "Detalhes" de epub3.
    const cardEpub3 = page.locator('.lib-grid .lib-card', { hasText: 'Livro EPUB Três' });
    await cardEpub3.getByRole('button', { name: /Opções para/ }).click();
    await page.getByRole('button', { name: 'Detalhes' }).click();
    await expect(page.locator('.lib-modal-title')).toHaveText('Detalhes do livro');

    const detalhes = await page.evaluate(() => {
      const dl = document.querySelector('.lib-details-list')!;
      const dts = Array.from(dl.querySelectorAll('dt')).map((n) => (n.textContent ?? '').trim());
      const dds = Array.from(dl.querySelectorAll('dd')).map((n) => (n.textContent ?? '').trim());
      const mapa: Record<string, string> = {};
      for (let i = 0; i < dts.length; i++) mapa[dts[i]] = dds[i] ?? '';
      return mapa;
    });
    expect(detalhes['Título']).toBe('Livro EPUB Três');
    expect(detalhes['Autor']).toBe('Autora Exemplar');
    expect(detalhes['Formato']).toBe('EPUB');
    expect(detalhes['Arquivo']).toBe('epub3.epub');
    expect(detalhes['Capítulos']).toBe('3');
    expect(detalhes['Adicionado em']).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    expect(detalhes['Última leitura']).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    expect(detalhes['Progresso']).toMatch(/^\d+%$/);
    for (const v of Object.values(detalhes)) expect(v).not.toMatch(/undefined|NaN/);
    await fecharModal(page);

    // Excluir o livro de "Continuar lendo" (epub2) promove epub3 sem corromper posição, marcador ou blobs.
    const metaEpub3 = (await metaPorTitulo(page, 'Livro EPUB Três'))!;
    await excluirCard(page, 'Livro EPUB Dois');
    await expect(page.locator('.lib-continue-card')).toContainText('Livro EPUB Três');
    await expect(page.locator('.lib-grid .lib-card')).toHaveCount(1);

    const blobsRestantes = await lerIndexedDB<string[]>(page, 'blobs');
    expect(blobsRestantes.filter((k) => k.startsWith(`${metaEpub3.id}/`)).length).toBeGreaterThanOrEqual(2);

    // Retomar epub3 pelo cartão "Continuar lendo" mantém página e marcador intactos.
    await page.locator('.lib-continue-card').click();
    await esperarLeitor(page);
    expect((await estado(page)).pagina).toBe(pagEpub3);
    await mostrarHud(page);
    await expect(page.getByRole('button', { name: 'Remover marcador desta página' })).toBeVisible();

    await page.getByRole('button', { name: 'Voltar à biblioteca' }).click();
    await expect(page.locator('.lib-page')).toBeVisible();

    // Excluir o último livro remove "Continuar lendo" e volta ao estado vazio.
    await excluirCard(page, 'Livro EPUB Três');
    await expect(page.locator('.lib-continue-card')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Sua estante está vazia' })).toBeVisible();
  });

  test('rota #/ler/ sem ID cai na estante (alinhada à regex do roteador)', async ({ page }) => {
    await page.goto('/#/ler/');
    await expect(page.locator('.lib-page')).toBeVisible();
    await expect(page.locator('.reader')).toHaveCount(0);
  });
});

testFalha.describe('Estante e banco — resiliência e recuperação', () => {
  testFalha('falha ao abrir IndexedDB exibe alerta na estante e recupera ao clicar em "Tentar novamente"', async ({ page, excecoes }) => {
    await page.addInitScript(() => {
      const origOpen = IDBFactory.prototype.open;
      (window as unknown as { __falharIdb: boolean }).__falharIdb = true;
      IDBFactory.prototype.open = function (this: IDBFactory, ...args: Parameters<IDBFactory['open']>) {
        if ((window as unknown as { __falharIdb: boolean }).__falharIdb) {
          const req = {} as IDBOpenDBRequest & Record<string, unknown>;
          setTimeout(() => {
            Object.defineProperty(req, 'error', { value: new DOMException('bloqueado', 'SecurityError') });
            (req.onerror as (() => void) | undefined)?.call(req);
          }, 0);
          return req;
        }
        return origOpen.apply(this, args);
      };
    });

    await page.goto('/');
    await expect(page.getByRole('alert')).toContainText('Não foi possível acessar o armazenamento');
    await expect(page.getByRole('heading', { name: 'Sua estante está vazia' })).toHaveCount(0);

    // Quando o banco volta a responder, "Tentar novamente" recupera sem recarregar a página.
    await page.evaluate(() => {
      (window as unknown as { __falharIdb: boolean }).__falharIdb = false;
    });
    await page.getByRole('button', { name: 'Tentar novamente' }).click();
    await expect(page.getByRole('heading', { name: 'Sua estante está vazia' })).toBeVisible();
    expect(excecoes).toEqual([]);
  });

  testFalha('QuotaExceededError na importação mostra mensagem clara de armazenamento cheio', async ({ page, excecoes }) => {
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
    await importarEFechar(page, ['mini-1.txt']);
    await page.evaluate(() => {
      (window as unknown as { __semCota: boolean }).__semCota = true;
    });
    await importar(page, ['mini-2.txt']);

    const erro = page.locator('.lib-modal-error');
    await expect(erro).toContainText('Armazenamento cheio');
    await expect(erro).not.toContainText('quota has been exceeded');
    expect(excecoes).toEqual([]);
  });

  testFalha('erro ao excluir livro exibe aviso no modal e reabilita o botão Excluir', async ({ page, excecoes }) => {
    await page.addInitScript(() => {
      const del = IDBObjectStore.prototype.delete;
      IDBObjectStore.prototype.delete = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['delete']>) {
        if ((window as unknown as { __falharExclusao?: boolean }).__falharExclusao && this.name === 'meta') {
          throw new DOMException('falha ao excluir', 'UnknownError');
        }
        return del.apply(this, args);
      };
    });

    await abrirEstante(page);
    await importarEFechar(page, ['mini-1.txt']);

    await page.locator('.lib-grid .lib-card').first().getByRole('button', { name: /Opções para/ }).click();
    await page.getByRole('button', { name: 'Excluir' }).click();
    await page.evaluate(() => {
      (window as unknown as { __falharExclusao: boolean }).__falharExclusao = true;
    });

    const confirmar = page.locator('.lib-modal .lib-btn-danger');
    await confirmar.click();
    await expect(page.locator('.lib-modal .lib-modal-error')).toContainText('Não foi possível excluir o livro');
    await expect(confirmar).toBeEnabled();

    // Ao limpar a falha, tentar novamente conclui a exclusão.
    await page.evaluate(() => {
      (window as unknown as { __falharExclusao: boolean }).__falharExclusao = false;
    });
    await confirmar.click();
    await expect(page.locator('.lib-modal')).toHaveCount(0);
    await expect(page.locator('.lib-grid .lib-card')).toHaveCount(0);
    expect(excecoes).toEqual([]);
  });

  testFalha('db.ts fecha a conexão em onversionchange para não bloquear migração de esquema', async ({ page, excecoes }) => {
    await abrirEstante(page);
    await importarEFechar(page, ['mini-1.txt']);

    const resultado = await page.evaluate(
      () =>
        new Promise<{ bloqueado: boolean; versao: number }>((resolve, reject) => {
          let bloqueado = false;
          const req = indexedDB.open('folha', 2);
          req.onblocked = () => {
            bloqueado = true;
          };
          req.onsuccess = () => {
            const db = req.result;
            const versao = db.version;
            db.close();
            resolve({ bloqueado, versao });
          };
          req.onerror = () => reject(req.error);
        }),
    );
    expect(resultado).toEqual({ bloqueado: false, versao: 2 });
    expect(excecoes).toEqual([]);
  });

  testFalha('db.ts rejeita abertura bloqueada (onblocked) em vez de travar a inicialização', async ({ page, excecoes }) => {
    await page.addInitScript(() => {
      IDBFactory.prototype.open = function () {
        const req = {} as IDBOpenDBRequest & Record<string, unknown>;
        setTimeout(() => {
          (req.onblocked as (() => void) | undefined)?.call(req);
        }, 0);
        return req;
      };
    });

    await page.goto('/');
    await expect(page.getByRole('alert')).toContainText('Não foi possível acessar o armazenamento');
    expect(excecoes).toEqual([]);
  });

  testFalha('db.ts descarta conexão fechada em onclose e reabre o banco na operação seguinte', async ({ page, excecoes }) => {
    await page.addInitScript(() => {
      const origOpen = IDBFactory.prototype.open;
      const dbs: IDBDatabase[] = [];
      (window as unknown as { __dbs: IDBDatabase[] }).__dbs = dbs;
      IDBFactory.prototype.open = function (this: IDBFactory, ...args: Parameters<IDBFactory['open']>) {
        const req = origOpen.apply(this, args);
        req.addEventListener('success', () => {
          dbs.push(req.result);
        });
        return req;
      };
    });

    await abrirEstante(page);
    await importarEFechar(page, ['mini-1.txt']);

    await page.evaluate(() => {
      const dbs = (window as unknown as { __dbs: IDBDatabase[] }).__dbs;
      const db = dbs[dbs.length - 1];
      db.close();
      db.dispatchEvent(new Event('close'));
    });

    await importarEFechar(page, ['mini-2.txt']);
    await expect(page.locator('.lib-grid .lib-card')).toHaveCount(2);
    const totalAberturas = await page.evaluate(() => (window as unknown as { __dbs: IDBDatabase[] }).__dbs.length);
    expect(totalAberturas).toBeGreaterThanOrEqual(2);
    expect(excecoes).toEqual([]);
  });
});
