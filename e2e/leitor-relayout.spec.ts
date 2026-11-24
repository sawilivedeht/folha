import {
  test,
  expect,
  abrirEstante,
  importarEFechar,
  abrirLivro,
  abrirConfig,
  fecharConfig,
  mostrarHud,
  esconderHud,
  estado,
  esperarLeitor,
  blocoVisivel,
  lerIndexedDB,
} from './helpers';
import type { Page } from '@playwright/test';
import type { Block, BookContent, BookMeta } from '../src/types';

interface ImageSpec {
  key: string;
  width: number;
  height: number;
}

/** Intercepta atribuições de blob: em img.src para controlar o momento em que imagens assíncronas carregam. */
async function instalarTravaDeImagens(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    if (!desc?.set || !desc.get) return;
    const nativeSet = desc.set;
    const nativeGet = desc.get;
    const win = window as unknown as {
      __holdImages?: boolean;
      __heldImages?: Array<{ img: HTMLImageElement; url: string }>;
      __releaseImages?: () => void;
    };
    win.__holdImages = false;
    win.__heldImages = [];
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      configurable: true,
      get() {
        return nativeGet.call(this);
      },
      set(val: string) {
        if (win.__holdImages && typeof val === 'string' && val.startsWith('blob:')) {
          win.__heldImages!.push({ img: this as HTMLImageElement, url: val });
          return;
        }
        nativeSet.call(this, val);
      },
    });
    win.__releaseImages = () => {
      win.__holdImages = false;
      const fila = win.__heldImages!.splice(0);
      for (const item of fila) {
        if (item.img.isConnected) nativeSet.call(item.img, item.url);
      }
    };
  });
}

async function gravarLivroNoDb(
  page: Page,
  meta: BookMeta,
  content: BookContent,
  imagens: readonly ImageSpec[] = [],
): Promise<void> {
  await page.evaluate(
    async ({ bookMeta, bookContent, imgSpecs }) => {
      const blobs = new Map<string, Blob>();
      for (const spec of imgSpecs) {
        const blob = await new Promise<Blob>((resolve, reject) => {
          const canvas = document.createElement('canvas');
          canvas.width = spec.width;
          canvas.height = spec.height;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.fillStyle = '#3b6d9c';
            ctx.fillRect(0, 0, spec.width, spec.height);
          }
          canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Falha ao criar PNG'))), 'image/png');
        });
        blobs.set(`${bookMeta.id}/img/${spec.key}`, blob);
      }

      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('folha');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['meta', 'content', 'blobs'], 'readwrite');
          tx.objectStore('meta').put(bookMeta, bookMeta.id);
          tx.objectStore('content').put(bookContent, bookMeta.id);
          const blobStore = tx.objectStore('blobs');
          for (const [k, v] of blobs) blobStore.put(v, k);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => {
            db.close();
            reject(tx.error);
          };
        };
      });
    },
    { bookMeta: meta, bookContent: content, imgSpecs: imagens },
  );
}

async function navegarParaLivro(page: Page, bookId: string): Promise<void> {
  await page.evaluate((id) => {
    history.pushState({ folha: true }, '', `#/ler/${encodeURIComponent(id)}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, bookId);
  await expect(page.locator('.reader-columns')).toBeVisible();
  await expect(page.locator('.reader-status-page')).toContainText('Pág.');
}

test.describe('Leitor — relayout, âncoras e marcadores', () => {
  test('relayout assíncrono de imagem reposiciona o bloco âncora mesmo quando totalPages não muda', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await instalarTravaDeImagens(page);
    await abrirEstante(page);

    const paragrafos: Block[] = Array.from({ length: 120 }, (_, i) => ({
      t: 'p',
      text: `Parágrafo ${i + 1} de verificação da paginação com texto suficiente para preencher linhas na coluna atual.`,
    }));
    const blocosSonda: Block[] = [
      { t: 'h', level: 1, text: 'Capítulo com imagem assíncrona' },
      { t: 'img', src: 'foto.png', alt: 'Imagem de teste' },
      ...paragrafos,
    ];

    const sondaId = 'relayout-sonda';
    await gravarLivroNoDb(
      page,
      {
        id: sondaId,
        title: 'Sonda de Relayout',
        format: 'epub',
        fileName: 'sonda.epub',
        addedAt: Date.now(),
        hasCover: false,
        chapterChars: [8000],
        totalChars: 8000,
        chapterTitles: ['Capítulo 1'],
        position: { chapter: 0, block: 0 },
        percent: 0,
        bookmarks: [],
      },
      { chapters: [{ title: 'Capítulo 1', blocks: blocosSonda }] },
      [{ key: 'foto.png', width: 200, height: 200 }],
    );

    await page.evaluate(() => {
      const win = window as unknown as { __holdImages?: boolean; __heldImages?: unknown[] };
      win.__holdImages = true;
      win.__heldImages = [];
    });
    await navegarParaLivro(page, sondaId);
    await page.waitForFunction(
      () => ((window as unknown as { __heldImages?: unknown[] }).__heldImages?.length ?? 0) >= 1,
    );

    // Descobre o último bloco da página 1 nesta tela e calcula uma altura de imagem que cabe na folga da página 2.
    const medicao = await page.evaluate(() => {
      const columns = document.querySelector<HTMLElement>('.reader-columns')!;
      const cs = getComputedStyle(columns);
      const step = parseFloat(cs.width) + (parseFloat(cs.columnGap) || 0);
      const els = Array.from(columns.querySelectorAll<HTMLElement>('[data-i]'));
      let ultimoNaPagina1 = 2;
      for (const el of els) {
        const idx = Number(el.dataset.i);
        if (el.offsetLeft < step - 2) {
          ultimoNaPagina1 = idx;
        } else {
          break;
        }
      }
      return { ultimoNaPagina1, colH: columns.clientHeight };
    });

    const blocoAncora = medicao.ultimoNaPagina1;
    const imgHeight = Math.max(140, Math.min(240, Math.floor(medicao.colH * 0.38)));
    // Deixa apenas 1 parágrafo curto na página 2: ao carregar a imagem, o bloco âncora passa para a página 2,
    // mas a página 2 absorve o deslocamento e totalPages continua 2.
    const blocosAlvo = blocosSonda.slice(0, blocoAncora + 2);
    const alvoId = 'relayout-mesmo-total';

    await gravarLivroNoDb(
      page,
      {
        id: alvoId,
        title: 'Relayout Mesmo Total',
        format: 'epub',
        fileName: 'relayout.epub',
        addedAt: Date.now(),
        hasCover: false,
        chapterChars: [2000],
        totalChars: 2000,
        chapterTitles: ['Capítulo 1'],
        position: { chapter: 0, block: blocoAncora },
        percent: 0,
        bookmarks: [],
      },
      { chapters: [{ title: 'Capítulo 1', blocks: blocosAlvo }] },
      [{ key: 'foto.png', width: 200, height: imgHeight }],
    );

    await page.evaluate(() => {
      const win = window as unknown as { __holdImages?: boolean; __heldImages?: unknown[] };
      win.__holdImages = true;
      win.__heldImages = [];
    });
    await navegarParaLivro(page, alvoId);
    await page.waitForFunction(
      () => ((window as unknown as { __heldImages?: unknown[] }).__heldImages?.length ?? 0) >= 1,
    );

    // Antes do carregamento da imagem: 2 páginas no total, bloco âncora na página 1.
    const antes = await estado(page);
    expect(antes.total).toBe(2);
    expect(antes.pagina).toBe(1);
    expect(await blocoVisivel(page, blocoAncora)).toBe(true);

    // Libera a imagem e aguarda o relayout assíncrono assentar.
    await page.evaluate(() => {
      (window as unknown as { __releaseImages?: () => void }).__releaseImages?.();
    });
    await esperarLeitor(page);

    const depois = await estado(page);
    expect(depois.total).toBe(2);
    expect(depois.pagina).toBe(2);
    expect(await blocoVisivel(page, blocoAncora)).toBe(true);
  });

  test('relayout assíncrono de imagens no fim do capítulo persiste posição para reabertura', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await instalarTravaDeImagens(page);
    await abrirEstante(page);

    const bookId = 'relayout-fim-capitulo';
    const blocosCap1: Block[] = [
      { t: 'h', level: 1, text: 'Primeiro capítulo ilustrado' },
      { t: 'img', src: 'alta.png', alt: 'Ilustração 1' },
      { t: 'p', text: 'Primeiro parágrafo depois da primeira imagem.' },
      { t: 'img', src: 'alta.png', alt: 'Ilustração 2' },
      { t: 'p', text: 'Segundo parágrafo depois da segunda imagem.' },
      { t: 'img', src: 'alta.png', alt: 'Ilustração 3' },
      { t: 'p', text: 'Parágrafo final exclusivo do primeiro capítulo.' },
    ];
    const blocosCap2: Block[] = [
      { t: 'h', level: 1, text: 'Segundo capítulo' },
      { t: 'p', text: 'Texto inicial do segundo capítulo.' },
    ];

    await gravarLivroNoDb(
      page,
      {
        id: bookId,
        title: 'Fim do Capítulo com Imagens',
        format: 'epub',
        fileName: 'fim-cap.epub',
        addedAt: Date.now(),
        hasCover: false,
        chapterChars: [1000, 1000],
        totalChars: 2000,
        chapterTitles: ['Primeiro capítulo ilustrado', 'Segundo capítulo'],
        position: { chapter: 1, block: 0 },
        percent: 50,
        bookmarks: [],
      },
      {
        chapters: [
          { title: 'Primeiro capítulo ilustrado', blocks: blocosCap1 },
          { title: 'Segundo capítulo', blocks: blocosCap2 },
        ],
      },
      [{ key: 'alta.png', width: 300, height: 900 }],
    );

    await page.evaluate(() => {
      const win = window as unknown as { __holdImages?: boolean; __heldImages?: unknown[] };
      win.__holdImages = true;
      win.__heldImages = [];
    });
    await navegarParaLivro(page, bookId);
    await expect(page.locator('.reader-columns')).toContainText('Segundo capítulo');

    // Volta para o fim do capítulo anterior enquanto as imagens ainda não carregaram.
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.reader-columns')).toContainText('Primeiro capítulo ilustrado');
    await page.waitForFunction(
      () => ((window as unknown as { __heldImages?: unknown[] }).__heldImages?.length ?? 0) === 3,
    );
    expect((await estado(page)).total).toBe(1);

    // Libera as imagens: o capítulo expande para múltiplas páginas e a posição final precisa ser persistida.
    await page.evaluate(() => {
      (window as unknown as { __releaseImages?: () => void }).__releaseImages?.();
    });
    await esperarLeitor(page);

    const aposRelayout = await estado(page);
    expect(aposRelayout.total).toBeGreaterThanOrEqual(2);
    expect(aposRelayout.pagina).toBe(aposRelayout.total);
    expect(await blocoVisivel(page, 6)).toBe(true);

    // O stash em localStorage deve ter sido atualizado com o novo bloco da última página.
    await expect
      .poll(async () =>
        page.evaluate((id) => {
          const raw = localStorage.getItem(`folha:pos:${id}`);
          return raw ? (JSON.parse(raw) as { block: number }).block : -1;
        }, bookId),
      )
      .toBeGreaterThan(0);

    // Recarrega sem virar página: deve reabrir na última página do capítulo 1.
    await page.reload();
    await esperarLeitor(page);
    const aposRecarregar = await estado(page);
    expect(aposRecarregar.total).toBe(aposRelayout.total);
    expect(aposRecarregar.pagina).toBe(aposRecarregar.total);
    expect(await blocoVisivel(page, 6)).toBe(true);
  });

  test('repaginar estando no fim do capítulo atualiza currentBlock para marcadores', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await abrirEstante(page);
    await importarEFechar(page, ['epub2.epub']);
    await abrirLivro(page, 'Livro EPUB Dois');

    // Vai para o capítulo 2 e volta uma página para entrar no fim do capítulo 1 (anchorMode === 'end').
    await mostrarHud(page);
    await page.getByRole('button', { name: 'Sumário e marcadores' }).click();
    await page.locator('.reader-toc-item', { hasText: 'Parte Beta' }).click();
    await expect(page.locator('.reader-columns')).toContainText('Parte Beta');

    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.reader-columns')).toContainText('Parte Alfa');
    const antes = await estado(page);
    expect(antes.pagina).toBe(antes.total);

    // Aumenta a fonte para gerar páginas extras enquanto ancorado no fim do capítulo.
    await abrirConfig(page);
    const btnAumentar = page.getByRole('button', { name: 'A+, aumentar fonte' });
    for (let i = 0; i < 10; i++) {
      await btnAumentar.click();
    }
    await fecharConfig(page);

    await expect.poll(async () => (await estado(page)).total).toBeGreaterThan(antes.total);
    const depois = await estado(page);
    expect(depois.pagina).toBe(depois.total);

    // Salva um marcador nessa nova última página, sai dela e retorna pelo painel de marcadores.
    await mostrarHud(page);
    await page.getByRole('button', { name: 'Marcar esta página' }).click();
    await expect(page.getByRole('button', { name: 'Remover marcador desta página' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await page.getByRole('button', { name: 'Sumário e marcadores' }).click();
    await page.locator('.reader-toc-item', { hasText: 'Parte Beta' }).click();
    await expect(page.locator('.reader-columns')).toContainText('Parte Beta');

    await mostrarHud(page);
    await page.getByRole('button', { name: 'Sumário e marcadores' }).click();
    await page.getByRole('tab', { name: 'Marcadores' }).click();
    await page.locator('.reader-bm-main').first().click();
    await expect(page.locator('.reader-sheet-overlay.is-open')).toHaveCount(0);

    // A posição é ancorada no bloco: se a última página começa no meio de um parágrafo, o marcador leva à
    // página onde esse parágrafo começa (uma antes). O bug antigo (bloco obsoleto) errava por várias páginas.
    await expect
      .poll(async () => (await estado(page)).pagina)
      .toBeGreaterThanOrEqual(depois.total - 1);
    expect((await estado(page)).total).toBe(depois.total);
  });

  test('marcador em bloco dividido entre duas páginas continua reconhecido e não recria SVG ao virar página', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await abrirEstante(page);

    const bookId = 'marcador-bloco-dividido';
    const textoLongo = Array.from({ length: 420 }, (_, i) => `termo${i}`).join(' ');
    await gravarLivroNoDb(
      page,
      {
        id: bookId,
        title: 'Bloco Dividido',
        format: 'epub',
        fileName: 'dividido.epub',
        addedAt: Date.now(),
        hasCover: false,
        chapterChars: [textoLongo.length + 60],
        totalChars: textoLongo.length + 60,
        chapterTitles: ['Capítulo 1'],
        position: { chapter: 0, block: 0 },
        percent: 0,
        bookmarks: [{ chapter: 0, block: 2, label: 'Bloco longo dividido', at: Date.now() }],
      },
      {
        chapters: [
          {
            title: 'Capítulo 1',
            blocks: [
              { t: 'h', level: 1, text: 'Título breve' },
              { t: 'p', text: 'Introdução curta no início da primeira página.' },
              { t: 'p', text: textoLongo },
            ],
          },
        ],
      },
    );

    await navegarParaLivro(page, bookId);
    await esperarLeitor(page);

    const est = await estado(page);
    expect(est.pagina).toBe(1);
    expect(est.total).toBeGreaterThanOrEqual(2);

    // Confirma que o bloco 2 começa na página 1 mas continua na página seguinte.
    const blocoDividido = await page.evaluate(() => {
      const vp = document.querySelector<HTMLElement>('.reader-viewport')!;
      const el = document.querySelector<HTMLElement>('.reader-columns [data-i="2"]')!;
      const vr = vp.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      return { offsetLeft: el.offsetLeft, ultrapassaDireita: er.right > vr.right + 1 };
    });
    expect(blocoDividido.offsetLeft).toBe(0);
    expect(blocoDividido.ultrapassaDireita).toBe(true);

    // O botão de marcador deve reconhecer o bloco 2 já marcado e removê-lo em vez de duplicar.
    await mostrarHud(page);
    const btnRemover = page.getByRole('button', { name: 'Remover marcador desta página' });
    await expect(btnRemover).toHaveAttribute('aria-pressed', 'true');
    await btnRemover.click();
    await expect(page.getByRole('button', { name: 'Marcar esta página' })).toHaveAttribute('aria-pressed', 'false');

    const metaAtualizada = await lerIndexedDB<BookMeta>(page, 'meta', bookId);
    expect(metaAtualizada.bookmarks).toHaveLength(0);

    // Sem alteração do estado marcado, virar página não deve substituir o nó SVG do botão de marcador.
    await esconderHud(page);
    await page.evaluate(() => {
      const svg = document.querySelector('.reader-topbar button[aria-pressed] svg');
      (window as unknown as { __bmSvgAntes?: Element | null }).__bmSvgAntes = svg;
    });
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await estado(page)).pagina).toBe(2);

    const mesmoSvg = await page.evaluate(() => {
      const antes = (window as unknown as { __bmSvgAntes?: Element | null }).__bmSvgAntes;
      const depois = document.querySelector('.reader-topbar button[aria-pressed] svg');
      return Boolean(antes && antes === depois);
    });
    expect(mesmoSvg).toBe(true);
  });

  test('quebras de linha de <br> (poemas) aparecem em linhas separadas', async ({ page }) => {
    await abrirEstante(page);
    const id = 'poema-br';
    await gravarLivroNoDb(
      page,
      {
        id,
        title: 'Poema com quebras',
        format: 'epub',
        fileName: 'poema.epub',
        addedAt: Date.now(),
        hasCover: false,
        chapterChars: [60],
        totalChars: 60,
        chapterTitles: ['Poema'],
        position: { chapter: 0, block: 0 },
        percent: 0,
        bookmarks: [],
      },
      { chapters: [{ title: 'Poema', blocks: [{ t: 'p', text: 'Verso um\nVerso dois\nVerso três' }] }] },
    );
    await navegarParaLivro(page, id);
    const linhas = await page.evaluate(() => {
      const p = document.querySelector<HTMLElement>('.reader-columns .reader-p')!;
      const range = document.createRange();
      range.selectNodeContents(p);
      const tops = new Set(Array.from(range.getClientRects()).map((r) => Math.round(r.top)));
      return tops.size;
    });
    expect(linhas).toBe(3);
  });
});
