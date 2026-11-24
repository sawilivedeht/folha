// Conteúdo hostil: e-books são arquivos não confiáveis. Nada do que vem deles pode executar script,
// tocar a rede ou injetar elementos no DOM; metadados e nomes de arquivo aparecem como texto literal.
import { test as testBase, type Page } from '@playwright/test';
import {
  test as testComum,
  expect,
  abrirEstante,
  importar,
  importarEFechar,
  fecharModal,
  abrirLivro,
  arquivo,
  mostrarHud,
  aguardarAssentar,
  lerIndexedDB,
} from './helpers';
import {
  TITULO_MALICIOSO,
  AUTOR_MALICIOSO,
  SUMARIO_MALICIOSO,
  TITULO_TXT_MALICIOSO,
  TITULO_PDF_MALICIOSO,
} from './fixtures/make.mjs';

/**
 * Relatório da CSP esperado: o DOMParser herda a CSP do app, então o `<base href>` externo de um XHTML hostil
 * é bloqueado ao ser analisado (e o Chrome registra isso no console). Qualquer outro console.error continua
 * reprovando o teste, como no `test` comum de helpers.ts.
 */
const CSP_BASE_ESPERADA = /^Setting the document's base URI to 'http:\/\/rastreador\.example\/base\/' violates the following Content Security Policy directive: "base-uri 'none'"/;

const test = testComum.extend<{ erros: string[] }>({
  erros: [
    async ({ page }, use) => {
      const erros: string[] = [];
      page.on('pageerror', (e) => erros.push(`pageerror: ${e.message}`));
      page.on('console', (m) => {
        if (m.type() === 'error' && !CSP_BASE_ESPERADA.test(m.text())) erros.push(`console.error: ${m.text()}`);
      });
      await use(erros);
      expect(erros, 'erros de console/pageerror').toEqual([]);
    },
    { auto: true },
  ],
});

interface Vigia {
  /** Requisições (e janelas, websockets, navegações) que tentaram sair de localhost. */
  externas: string[];
  /** Diálogos (alert/confirm/prompt) abertos pela página. */
  dialogos: string[];
}

function ehLocal(u: string): boolean {
  try {
    const url = new URL(u);
    if (url.protocol === 'blob:' || url.protocol === 'data:' || url.protocol === 'about:') return true;
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

/**
 * Intercepta TODA requisição do contexto (página, workers, popups): o que não for localhost é registrado e
 * abortado. Também arma uma armadilha em `window.__pwned`: qualquer payload que rode grava ali.
 */
async function vigiar(page: Page): Promise<Vigia> {
  const v: Vigia = { externas: [], dialogos: [] };
  const ctx = page.context();
  await ctx.route(/.*/, (route) => {
    const req = route.request();
    if (ehLocal(req.url())) return route.fallback();
    v.externas.push(`${req.method()} ${req.url()} (${req.resourceType()})`);
    return route.abort('blockedbyclient');
  });
  ctx.on('request', (req) => {
    if (!ehLocal(req.url()) && !v.externas.some((e) => e.includes(req.url()))) v.externas.push(`request ${req.url()}`);
  });
  ctx.on('page', (p) => v.externas.push(`nova janela: ${p.url()}`));
  page.on('websocket', (ws) => {
    if (!ehLocal(ws.url())) v.externas.push(`websocket ${ws.url()}`);
  });
  page.on('framenavigated', (f) => {
    if (!ehLocal(f.url())) v.externas.push(`navegação ${f.url()}`);
  });
  page.on('dialog', (d) => {
    v.dialogos.push(`${d.type()}: ${d.message()}`);
    void d.dismiss();
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __pwnLog: string[] };
    w.__pwnLog = [];
    Object.defineProperty(window, '__pwned', {
      configurable: false,
      get: () => (w.__pwnLog.length ? w.__pwnLog.join(',') : undefined),
      set: (val: unknown) => {
        w.__pwnLog.push(String(val));
      },
    });
  });
  return v;
}

async function pwned(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __pwnLog?: string[] }).__pwnLog ?? []);
}

/** Varre o DOM inteiro procurando qualquer coisa que só poderia ter vindo do conteúdo hostil. */
async function auditarDom(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const prob: string[] = [];
    const origem = location.origin;
    const mesmaOrigem = (u: string) => {
      try {
        return new URL(u, location.href).origin === origem;
      } catch {
        return false;
      }
    };
    const proibidos = new Set([
      'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'base', 'portal', 'video', 'audio',
      'source', 'track', 'template', 'noscript', 'math', 'foreignobject', 'param', 'input',
    ]);
    // O único <input> legítimo é o seletor de arquivos da estante.
    const inputsLegitimos = new Set(document.querySelectorAll('input[type=file].sr-only, input.lib-search, input[type=range]'));
    for (const el of document.querySelectorAll('*')) {
      const tag = el.localName.toLowerCase();
      for (const a of el.getAttributeNames()) {
        if (/^on/i.test(a)) prob.push(`<${tag}> com atributo de evento ${a}`);
        if (/^(href|src|xlink:href|action|formaction|data|poster|srcset)$/i.test(a) && /^\s*javascript:/i.test(el.getAttribute(a) ?? ''))
          prob.push(`<${tag} ${a}=javascript:>`);
      }
      if (proibidos.has(tag) && !(tag === 'input' && inputsLegitimos.has(el))) prob.push(`elemento proibido <${tag}>`);
      if (tag === 'script') {
        const s = el as HTMLScriptElement;
        if (!s.src || !mesmaOrigem(s.src) || (s.textContent ?? '').trim()) prob.push(`script inesperado: ${s.src || (s.textContent ?? '').slice(0, 60)}`);
      }
      if (tag === 'style') prob.push(`<style> inesperado: ${(el.textContent ?? '').slice(0, 60)}`);
      if (tag === 'link' && !mesmaOrigem((el as HTMLLinkElement).href)) prob.push(`<link> externo: ${(el as HTMLLinkElement).href}`);
      if (tag === 'meta') {
        const h = el.getAttribute('http-equiv');
        if (h && h.toLowerCase() !== 'content-security-policy') prob.push(`<meta http-equiv=${h}>`);
      }
      if (tag === 'a' && el.hasAttribute('href')) prob.push(`<a href=${el.getAttribute('href')}>`);
      if (tag === 'img') {
        const src = el.getAttribute('src') ?? '';
        if (src && !src.startsWith('blob:') && !mesmaOrigem(src)) prob.push(`<img> externa: ${src.slice(0, 80)}`);
        if (el.hasAttribute('srcset')) prob.push('<img> com srcset');
      }
      if (el.namespaceURI === 'http://www.w3.org/2000/svg' && ['script', 'foreignobject', 'image', 'use', 'a', 'style'].includes(tag))
        prob.push(`<svg> contém <${tag}>`);
      const estilo = el.getAttribute('style');
      if (estilo && /url\(|expression\(|@import/i.test(estilo)) prob.push(`style com recurso: ${estilo.slice(0, 80)}`);
    }
    if (document.querySelectorAll('meta[http-equiv]').length > 1) prob.push('mais de uma <meta http-equiv>');

    // Conteúdo do leitor: só as tags e atributos que o renderizador cria.
    const cols = document.querySelector('.reader-columns');
    if (cols) {
      const tags = new Set(['p', 'h1', 'h2', 'h3', 'blockquote', 'pre', 'hr', 'ul', 'ol', 'li', 'figure', 'img', 'figcaption', 'em', 'strong', 'sup']);
      const attrs = new Set(['class', 'data-i', 'alt', 'src', 'width', 'height', 'style', 'decoding', 'draggable']);
      for (const el of cols.querySelectorAll('*')) {
        if (!tags.has(el.localName)) prob.push(`tag fora da lista no leitor: <${el.localName}>`);
        for (const a of el.getAttributeNames()) if (!attrs.has(a)) prob.push(`atributo fora da lista no leitor: ${a} em <${el.localName}>`);
        if (el.localName === 'img' && el.hasAttribute('src') && !(el.getAttribute('src') ?? '').startsWith('blob:'))
          prob.push(`imagem do leitor fora de blob: ${el.getAttribute('src')}`);
        const st = el.getAttribute('style');
        if (st && !/^visibility: hidden;?$/.test(st.trim())) prob.push(`style inesperado no leitor: ${st}`);
      }
    }
    if (!['localhost', '127.0.0.1'].includes(location.hostname)) prob.push(`a página saiu de localhost: ${location.href}`);
    return prob.slice(0, 20);
  });
}

async function semVestigios(page: Page, v: Vigia, etapa: string): Promise<void> {
  expect(await auditarDom(page), `DOM injetado (${etapa})`).toEqual([]);
  expect(await pwned(page), `script do conteúdo executou (${etapa})`).toEqual([]);
  expect(v.externas, `requisições para fora de localhost (${etapa})`).toEqual([]);
  expect(v.dialogos, `diálogos abertos (${etapa})`).toEqual([]);
}

async function abrirSumario(page: Page): Promise<void> {
  await mostrarHud(page);
  await page.getByRole('button', { name: 'Sumário e marcadores' }).click();
  await expect(page.locator('.reader-toc-item').first()).toBeVisible();
}

const NOME_ARQUIVO_HTML = `"><img src=x onerror="window.__pwned='arquivo'">.epub`;

test.describe('Segurança: conteúdo hostil', () => {
  test('EPUB malicioso: nenhum script roda, nada sai para a rede e nada é injetado no DOM', async ({ page }) => {
    const v = await vigiar(page);
    await abrirEstante(page);
    await importarEFechar(page, [arquivo('malicioso.epub', NOME_ARQUIVO_HTML)]);

    // Estante: título e autor com HTML aparecem como texto literal, sem elementos filhos.
    const card = page.locator('.lib-card');
    await expect(card).toHaveCount(1);
    await expect(card.locator('.lib-card-title')).toHaveText(TITULO_MALICIOSO);
    await expect(card.locator('.lib-card-author')).toHaveText(AUTOR_MALICIOSO);
    expect(await card.locator('.lib-card-title *, .lib-card-author *').count()).toBe(0);
    // A capa SVG hostil vira <img src=blob:>: inerte dentro do <img> (sem script e sem recursos externos).
    // Aberta como documento numa aba nova ela NÃO é inerte: ver o teste "imagem SVG do livro aberta em nova aba".
    await expect(card.locator('img.lib-cover-img')).toHaveAttribute('src', /^blob:/);
    await expect
      .poll(() => card.locator('img.lib-cover-img').evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth))
      .toBeGreaterThan(0);
    await semVestigios(page, v, 'estante');

    // Detalhes: nome do arquivo com HTML aparece literal.
    await card.getByRole('button', { name: /Opções para/ }).click();
    await page.getByRole('button', { name: 'Detalhes' }).click();
    await expect(page.locator('.lib-details-list dd').filter({ hasText: 'onerror' }).first()).toBeVisible();
    await expect(page.locator('.lib-details-list')).toContainText(NOME_ARQUIVO_HTML);
    await expect(page.locator('.lib-details-list')).toContainText(TITULO_MALICIOSO);
    expect(await page.locator('.lib-details-list dd *').count()).toBe(0);
    await semVestigios(page, v, 'detalhes');
    await fecharModal(page);

    // Leitor, capítulo 1 (XHTML válido): só o texto sobrevive.
    await abrirLivro(page, 'Malicioso');
    const colunas = page.locator('.reader-columns');
    await expect(colunas).toContainText('Texto seguro antes do script. Texto depois do script.');
    await expect(colunas).toContainText('Um link javascript no meio.');
    await expect(colunas).toContainText('Parágrafo com atributo gigante.');
    await expect(colunas).toContainText('Fim do capítulo malicioso.');
    await expect(colunas).not.toContainText('__pwned');
    await expect(colunas).not.toContainText('rastreador');
    // Imagens: só as locais do EPUB (blob:); data:, http(s):, // e blob: externos foram descartados.
    const srcs = await colunas.locator('img').evaluateAll((imgs) => imgs.map((i) => i.getAttribute('src') ?? ''));
    expect(srcs.length).toBeGreaterThan(0);
    for (const s of srcs) expect(s).toMatch(/^blob:http:\/\/localhost:\d+\//);
    const alts = await colunas.locator('figure').evaluateAll((fs) => fs.map((f) => f.querySelector('img')?.alt ?? f.textContent ?? ''));
    for (const proibido of ['pixel de rastreamento', 'srcset externo', 'protocolo relativo', 'imagem data', 'imagem blob', 'sem arquivo'])
      expect(alts, `imagem "${proibido}" não deveria existir`).not.toContain(proibido);
    expect(alts).toContain('imagem local');
    await semVestigios(page, v, 'leitor, capítulo 1');

    // Sumário: título com HTML literal.
    await abrirSumario(page);
    await expect(page.locator('.reader-toc-item').first()).toContainText(SUMARIO_MALICIOSO);
    expect(await page.locator('.reader-toc-title *').count()).toBe(0);
    await semVestigios(page, v, 'sumário');

    // Capítulo 2 (HTML malformado, caminho de fallback do parser HTML).
    await page.locator('.reader-toc-item').nth(1).click();
    await aguardarAssentar(page);
    await expect(colunas).toContainText('Capítulo em HTML quebrado');
    await expect(colunas).toContainText('Texto final do HTML quebrado.');
    await expect(colunas).not.toContainText('__pwned');
    await semVestigios(page, v, 'leitor, capítulo 2');

    // A barra superior mostra o título literal.
    await mostrarHud(page);
    await expect(page.locator('.reader-book-title')).toHaveText(TITULO_MALICIOSO);
    await semVestigios(page, v, 'fim');
  });

  test('entidades em profundidade (billion laughs) no OPF e no XHTML não travam nem expandem', async ({ page }) => {
    const v = await vigiar(page);
    await abrirEstante(page);
    const inicio = Date.now();
    await importar(page, ['entidades.epub']);
    const duracao = Date.now() - inicio;
    await fecharModal(page);
    expect(duracao, 'importação deve terminar rápido').toBeLessThan(15_000);

    const card = page.locator('.lib-card');
    await expect(card).toHaveCount(1);
    // O OPF é lido sem expandir entidades declaradas no DTD: a referência fica literal.
    await expect(card.locator('.lib-card-title')).toHaveText('Livro de Entidades &lol9;');
    const ids = await lerIndexedDB<string[]>(page, 'meta');
    const meta = await lerIndexedDB<{ totalChars: number; title: string }>(page, 'meta', ids[0]);
    // 10^9 "lol" ou 20 000 × 50 000 "x" expandidos dariam gigabytes; o livro precisa continuar pequeno.
    expect(meta.totalChars).toBeLessThan(500_000);

    await abrirLivro(page, 'Livro de Entidades');
    await expect(page.locator('.reader-columns')).toContainText('Parágrafo normal depois das entidades.');
    await expect(page.locator('.reader-columns')).not.toContainText('lollollol');
    await semVestigios(page, v, 'entidades');
  });

  test('TXT e PDF com HTML no título e no texto aparecem como texto literal', async ({ page }) => {
    const v = await vigiar(page);
    await abrirEstante(page);
    await importarEFechar(page, [
      arquivo('malicioso.txt', `<svg onload="window.__pwned='nome-txt'">.txt`),
      arquivo('malicioso.pdf', `<img src=x onerror="window.__pwned='nome-pdf'">.pdf`),
    ]);
    await expect(page.locator('.lib-card-title').filter({ hasText: TITULO_TXT_MALICIOSO })).toHaveCount(1);
    await expect(page.locator('.lib-card-title').filter({ hasText: TITULO_PDF_MALICIOSO })).toHaveCount(1);
    expect(await page.locator('.lib-card-title *, .lib-card-author *').count()).toBe(0);
    await semVestigios(page, v, 'estante TXT/PDF');

    await abrirLivro(page, 'Texto hostil');
    const colunas = page.locator('.reader-columns');
    await expect(colunas).toContainText('Capítulo 1');
    await semVestigios(page, v, 'leitor TXT');
    await expect(colunas).toContainText(`Parágrafo com <script>window.__pwned='txt-script'</script> e`);
    await expect(colunas).toContainText('link</a>.');

    await page.goBack();
    await expect(page.locator('.lib-page')).toBeVisible();
    await abrirLivro(page, 'PDF hostil');
    await expect(colunas).toContainText('Segunda linha do PDF hostil');
    await semVestigios(page, v, 'leitor PDF');
    await expect(colunas).toContainText(`Texto do PDF com <script>window.__pwned='pdf-texto'</script> literal.`);
  });

  test('erro de importação mostra o nome do arquivo com HTML como texto', async ({ page }) => {
    const v = await vigiar(page);
    await abrirEstante(page);
    const nome = `<img src=x onerror="window.__pwned='erro'">.docx`;
    await importar(page, [arquivo('invalido.docx', nome)]);
    await expect(page.locator('.lib-modal-error')).toContainText(nome);
    expect(await page.locator('.lib-modal *').evaluateAll((els) => els.filter((e) => e.localName === 'img').length)).toBe(0);
    await semVestigios(page, v, 'erro de importação');
    await fecharModal(page);
  });

  // BUG: as expressões regulares do OPF (`extractFirstTagText` em src/import/epub.ts, e o mesmo padrão em
  // `parseNavToc`) usam `<tag[^>]*>([\s\S]*?)</tag>`; com milhares de aberturas sem fechamento, cada tentativa
  // varre o resto do arquivo (custo quadrático). Um EPUB de 3 KB (OPF de ~900 KB) congela a thread principal
  // por vários segundos (no Android isso vira "o app não responde"). Corrigir em epub.ts.
  test('OPF com milhares de <dc:title> sem fechamento não congela a importação', async ({ page }) => {
    test.setTimeout(240_000);
    const v = await vigiar(page);
    await abrirEstante(page);
    const inicio = Date.now();
    await importar(page, ['redos.epub']);
    const duracao = Date.now() - inicio;
    await fecharModal(page);
    await semVestigios(page, v, 'redos');
    expect(duracao, 'importação de um EPUB de 3 KB').toBeLessThan(2_000);
  });

  // BUG: imagens SVG do EPUB são guardadas como Blob `image/svg+xml` (o tipo vem do manifest ou da extensão,
  // em `registerImage`/capa de src/import/epub.ts) e exibidas por `<img src=blob:>`. Dentro do <img> o SVG é
  // inerte, mas "Abrir imagem em nova guia" (navegador no computador ou Chrome no celular; o WebView do APK
  // não tem esse menu) navega para o blob: como documento: o <script> do SVG roda NA ORIGEM DO APP, sem a CSP
  // (navegação iniciada pelo navegador não herda a política), com acesso ao IndexedDB inteiro e à rede.
  // `window.open(blob)` feito pela página herda a CSP e fica bloqueado; o problema é só a navegação do usuário.
  // Correção sugerida em epub.ts: rasterizar SVG para PNG na importação (ou descartá-lo) e só aceitar tipos de
  // imagem raster conferidos pelos bytes. O teste abre o blob numa aba nova, como faria o menu do navegador.
  test('imagem SVG do livro aberta em nova aba não executa script na origem do app', async ({ page }) => {
    await vigiar(page);
    await abrirEstante(page);
    await importarEFechar(page, ['malicioso.epub']);
    await abrirLivro(page, 'Malicioso');
    const src = await page.locator('.reader-columns img[alt="svg hostil"]').getAttribute('src');
    expect(src).toMatch(/^blob:http:\/\/localhost:\d+\//);
    const aba = await page.context().newPage();
    await aba.goto(src!);
    await aba.waitForLoadState('load');
    const r = await aba.evaluate(() => ({
      pwned: (window as unknown as { __pwned?: string }).__pwned,
      origem: location.origin,
    }));
    await aba.close();
    expect(r.origem).toBe(new URL(page.url()).origin);
    expect(r.pwned, 'script do SVG rodou na origem do app').toBeUndefined();
  });
});

// A CSP do index.html é a segunda camada: mesmo que um dia algum HTML hostil chegue ao DOM, script inline,
// recursos externos, frames, plugins, workers de blob e <style> sem nonce são bloqueados pelo navegador.
// Usa o `test` puro do Playwright porque cada bloqueio gera um console.error de propósito.
testBase.describe('Segurança: Content-Security-Policy', () => {
  testBase('a CSP do app está ativa e bloqueia script inline, rede externa, frames, plugins e estilos inline', async ({ page }) => {
    const externas: string[] = [];
    await page.context().route(/.*/, (route) => {
      if (ehLocal(route.request().url())) return route.fallback();
      externas.push(route.request().url());
      return route.abort('blockedbyclient');
    });
    const errosDePagina: string[] = [];
    page.on('pageerror', (e) => errosDePagina.push(e.message));
    await page.addInitScript(() => {
      const w = window as unknown as { __violacoes: string[] };
      w.__violacoes = [];
      document.addEventListener('securitypolicyviolation', (e) => w.__violacoes.push(`${e.effectiveDirective} ${e.blockedURI}`));
    });
    await page.goto('/');
    await expect(page.locator('.lib-page')).toBeVisible();

    const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*|https?:/);

    const r = await page.evaluate(async () => {
      const w = window as unknown as { __pwned?: string; __violacoes: string[] };
      const res: Record<string, unknown> = {};
      // (eval/new Function não dá para provar daqui: o page.evaluate do Playwright roda com permissão de eval
      // concedida pelo DevTools. A ausência de 'unsafe-eval' é conferida no texto da política acima.)
      const s = document.createElement('script');
      s.textContent = "window.__pwned = 'inline'";
      document.head.append(s);
      const s2 = document.createElement('script');
      s2.src = 'http://rastreador.example/externo.js';
      document.head.append(s2);
      const img = new Image();
      img.src = 'http://rastreador.example/pixel.gif';
      document.body.append(img);
      const dataImg = new Image();
      dataImg.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
      document.body.append(dataImg);
      try {
        await fetch('http://rastreador.example/fetch');
        res.fetch = 'ok';
      } catch (e) {
        res.fetch = (e as Error).name;
      }
      const fr = document.createElement('iframe');
      fr.src = 'http://rastreador.example/quadro.html';
      document.body.append(fr);
      const obj = document.createElement('object');
      obj.data = 'http://rastreador.example/plugin.swf';
      document.body.append(obj);
      res.workerBlob = await new Promise((ok) => {
        try {
          const wk = new Worker(URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' })));
          wk.onmessage = () => ok('rodou');
          wk.onerror = () => ok('bloqueado');
          setTimeout(() => ok('sem resposta'), 1500);
        } catch (e) {
          ok((e as Error).name);
        }
      });
      const st = document.createElement('style');
      st.textContent = 'body { outline: 7px solid rgb(1, 2, 3) !important; }';
      document.head.append(st);
      const div = document.createElement('div');
      div.setAttribute('style', 'outline: 9px solid rgb(4, 5, 6)');
      document.body.append(div);
      // CSSOM (el.style.x = ...) continua permitido: é o que o app usa.
      const viaCssom = document.createElement('div');
      viaCssom.style.width = '17px';
      document.body.append(viaCssom);
      await new Promise((ok) => setTimeout(ok, 300));
      res.pwned = w.__pwned;
      res.styleAplicado = getComputedStyle(document.body).outlineWidth === '7px';
      res.attrAplicado = getComputedStyle(div).outlineWidth === '9px';
      res.cssom = getComputedStyle(viaCssom).width;
      res.violacoes = w.__violacoes;
      for (const el of [s, s2, img, dataImg, fr, obj, st, div, viaCssom]) el.remove();
      return res;
    });

    expect(r.pwned).toBeUndefined();
    expect(r.fetch).toBe('TypeError');
    expect(r.workerBlob, 'worker de blob: não pode rodar').not.toBe('rodou');
    expect(r.styleAplicado, '<style> sem nonce não pode valer').toBe(false);
    expect(r.attrAplicado, 'atributo style= não pode valer').toBe(false);
    expect(r.cssom).toBe('17px');
    const diretivas = new Set((r.violacoes as string[]).map((v) => v.split(' ')[0]));
    for (const d of ['script-src-elem', 'img-src', 'connect-src', 'frame-src', 'object-src', 'worker-src', 'style-src-elem', 'style-src-attr'])
      expect([...diretivas], `violação de ${d} registrada`).toContain(d);
    // Tudo foi barrado pela CSP antes de virar requisição.
    expect(externas).toEqual([]);
    expect(errosDePagina).toEqual([]);
  });
});
