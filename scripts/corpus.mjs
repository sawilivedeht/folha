#!/usr/bin/env node
// Converte arquivos reais (PDF, EPUB, TXT/MD) com os importadores do app e imprime uma tabela.
// Somente leitura: nada é copiado nem gravado. Nenhum caminho é embutido; passe pastas ou arquivos.
//
//   node scripts/corpus.mjs [opções] <pasta-ou-arquivo>...
//
// Opções:
//   --timeout=SEG   limite por arquivo (padrão 120); estourar vira "TEMPO" e o filho é morto
//   --max-pdf=N --max-epub=N --max-txt=N   máximo por formato (padrão 60 / 40 / 30, variando o tamanho)
//   --min-kb=N      ignora arquivos menores (padrão 10)
//   --json          imprime uma linha JSON por arquivo em vez da tabela
//   --nomes         mostra o nome do arquivo (por padrão só um índice, para não vazar nomes)
//
// Cada arquivo roda num processo filho (limite de tempo real, pico de memória por arquivo).
// Requer Node 22.18+ (carrega TypeScript direto) e as dependências de dev instaladas.

import { spawn } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RAIZ = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const EXT = { '.pdf': 'pdf', '.epub': 'epub', '.txt': 'txt', '.md': 'txt' };
const IGNORAR = new Set(['node_modules', '.git', 'Android', 'cache', 'Cache']);

function opcoes(argv) {
  const o = { timeout: 120, max: { pdf: 60, epub: 40, txt: 30 }, minKb: 10, json: false, nomes: false, worker: null, alvos: [] };
  for (const a of argv) {
    let m;
    if (a === '--json') o.json = true;
    else if (a === '--nomes') o.nomes = true;
    else if ((m = /^--timeout=(\d+)$/.exec(a))) o.timeout = Number(m[1]);
    else if ((m = /^--max-(pdf|epub|txt)=(\d+)$/.exec(a))) o.max[m[1]] = Number(m[2]);
    else if ((m = /^--min-kb=(\d+)$/.exec(a))) o.minKb = Number(m[1]);
    else if ((m = /^--worker=(.+)$/.exec(a))) o.worker = m[1];
    else if (a.startsWith('--')) throw new Error(`Opção desconhecida: ${a}`);
    else o.alvos.push(a);
  }
  return o;
}

async function varrer(alvo, minBytes, saida) {
  const st = await stat(alvo).catch(() => null);
  if (!st) return;
  if (st.isDirectory()) {
    for (const nome of await readdir(alvo)) {
      if (nome.startsWith('.') || IGNORAR.has(nome)) continue;
      await varrer(join(alvo, nome), minBytes, saida);
    }
  } else if (st.isFile() && st.size >= minBytes) {
    const fmt = EXT[extname(alvo).toLowerCase()];
    if (fmt) saida.push({ caminho: resolve(alvo), formato: fmt, bytes: st.size });
  }
}

/** Escolhe até `max` arquivos espalhados por todo o intervalo de tamanhos. */
function amostrar(lista, max) {
  if (lista.length <= max) return lista;
  const ord = [...lista].sort((a, b) => a.bytes - b.bytes);
  const out = [];
  for (let i = 0; i < max; i++) out.push(ord[Math.round((i * (ord.length - 1)) / (max - 1))]);
  return [...new Set(out)];
}

// ---------------------------------------------------------------- processo filho (um arquivo)

function contarBlocos(chapters) {
  let chars = 0;
  let imagens = 0;
  for (const ch of chapters) {
    for (const b of ch.blocks) {
      if (b.t === 'img') imagens++;
      else if (b.t !== 'hr') chars += b.text.length;
    }
  }
  return { chars, imagens };
}

async function converterPdf(bytes, nomeArquivo) {
  const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const layout = await import(pathToFileURL(join(RAIZ, 'src/import/pdf-layout.ts')).href);
  const extract = await import(pathToFileURL(join(RAIZ, 'src/import/pdf-extract.ts')).href);
  const slides = await import(pathToFileURL(join(RAIZ, 'src/import/pdf-slides.ts')).href);
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, disableFontFace: true, verbosity: 0 });
  let doc;
  try {
    doc = await task.promise;
  } catch (err) {
    throw extract.friendlyPdfError(err);
  }
  try {
    if (doc.numPages < 1) throw new Error('O PDF não tem páginas.');
    const info = await extract.readPdfInfo(doc);
    const titulo = info.title || extract.titleFromFileName(nomeArquivo);
    const outline = await extract.extractOutline(doc);
    const pages = [];
    const stats = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      try {
        await extract.measurePageImageCoverage(page, OPS);
        const { pageInput, charCount } = await extract.extractPageText(page, i);
        stats.push({ width: pageInput.width, height: pageInput.height, chars: charCount });
        pages.push(pageInput);
      } finally {
        page.cleanup();
      }
    }
    const kind = slides.classifyPdf(stats);
    let chapters;
    const avisos = [];
    if (kind === 'slides') {
      const sl = layout.extractPdfPageBlocks(pages, { yOrigin: 'top-down' }).map((p) => ({
        pageNumber: p.pageNumber,
        blocks: p.blocks,
        image: { src: `p${String(p.pageNumber).padStart(4, '0')}`, w: 1280, h: 720 },
      }));
      chapters = slides.buildSlideChapters(sl);
      avisos.push('modo slides');
    } else if (kind === 'scanned') {
      chapters = [];
      avisos.push('escaneado (sem canvas no Node: páginas viram imagem só no app)');
    } else {
      chapters = layout.extractPdfChapters(pages, { outline, yOrigin: 'top-down' });
    }
    return { titulo, paginas: doc.numPages, tipo: kind, capitulos: chapters, avisos, titulosOutline: outline.length };
  } finally {
    await task.destroy();
  }
}

async function converterEpub(bytes, nomeArquivo) {
  const { createServer } = await import('vite');
  const { Window } = await import('happy-dom');
  const vite = await createServer({ root: RAIZ, logLevel: 'silent', server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom', optimizeDeps: { noDiscovery: true } });
  try {
    const { parseEpub } = await vite.ssrLoadModule('/src/import/epub.ts');
    const janela = new Window();
    const parseDocument = (html) => {
      const parser = new janela.DOMParser();
      try {
        const x = parser.parseFromString(html, 'application/xhtml+xml');
        if (x.getElementsByTagName('parsererror').length === 0) return x;
      } catch {
        // cai para HTML
      }
      return parser.parseFromString(html, 'text/html');
    };
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const livro = await parseEpub(buf, nomeArquivo, () => {}, { parseDocument });
    await janela.happyDOM.close();
    return { titulo: livro.title, capitulos: livro.chapters, imagensMapa: livro.images.size, capa: Boolean(livro.cover), avisos: livro.warnings ?? [] };
  } finally {
    await vite.close();
  }
}

async function converterTxt(bytes, nomeArquivo) {
  const { createServer } = await import('vite');
  const vite = await createServer({ root: RAIZ, logLevel: 'silent', server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom', optimizeDeps: { noDiscovery: true } });
  try {
    const { decodeText, parseTxt } = await vite.ssrLoadModule('/src/import/txt.ts');
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const livro = parseTxt(decodeText(buf), nomeArquivo);
    return { titulo: livro.title, capitulos: livro.chapters, imagensMapa: 0, avisos: [] };
  } finally {
    await vite.close();
  }
}

async function trabalhar(caminho, formato) {
  const inicio = performance.now();
  const bytes = await readFile(caminho);
  const nome = basename(caminho);
  const r = { formato, ok: false };
  try {
    const saida = formato === 'pdf' ? await converterPdf(bytes, nome) : formato === 'epub' ? await converterEpub(bytes, nome) : await converterTxt(bytes, nome);
    const { chars, imagens } = contarBlocos(saida.capitulos);
    r.ok = true;
    r.titulo = saida.titulo;
    r.capitulos = saida.capitulos.length;
    r.chars = chars;
    r.imagens = imagens;
    r.avisos = saida.avisos;
    r.titulosCap = saida.capitulos.slice(0, 5).map((c) => c.title);
    if (saida.paginas) r.paginas = saida.paginas;
    if (saida.tipo) r.tipo = saida.tipo;
    // Contrato: toda imagem referenciada existe (no PDF as imagens de página só existem no app).
    if (formato === 'epub') {
      const vazios = saida.capitulos.filter((c) => c.blocks.length === 0).length;
      if (vazios) r.avisos.push(`${vazios} capítulo(s) vazio(s)`);
    }
  } catch (err) {
    r.erro = err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err);
  }
  r.ms = Math.round(performance.now() - inicio);
  r.rssMB = Math.round(process.resourceUsage().maxRSS / 1024);
  return r;
}

// ---------------------------------------------------------------- processo pai

function executarFilho(arquivo, timeoutS) {
  return new Promise((ok) => {
    const filho = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url), `--worker=${arquivo.formato}`, arquivo.caminho], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: RAIZ,
    });
    let out = '';
    let err = '';
    let morto = false;
    const t = setTimeout(() => {
      morto = true;
      filho.kill('SIGKILL');
    }, timeoutS * 1000);
    filho.stdout.on('data', (d) => (out += d));
    filho.stderr.on('data', (d) => (err += d));
    filho.on('close', (code) => {
      clearTimeout(t);
      if (morto) return ok({ formato: arquivo.formato, ok: false, erro: `TEMPO: passou de ${timeoutS} s`, ms: timeoutS * 1000 });
      const linha = out.trim().split('\n').filter((l) => l.startsWith('{')).pop();
      if (linha) {
        try {
          return ok(JSON.parse(linha));
        } catch {
          // segue para o erro abaixo
        }
      }
      ok({ formato: arquivo.formato, ok: false, erro: `FILHO: saiu com código ${code}: ${err.trim().split('\n').slice(-2).join(' | ')}`, ms: 0 });
    });
  });
}

function fmtBytes(n) {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)}M` : `${Math.round(n / 1024)}K`;
}

function suspeitas(r, bytes) {
  const s = [];
  if (!r.ok) return s;
  if (r.chars === 0 && r.imagens === 0) s.push('SEM-CONTEÚDO');
  else if (r.chars === 0 && r.formato === 'pdf' && r.tipo !== 'scanned') s.push('0-CHARS');
  if (r.ms > 30000) s.push('LENTO>30s');
  if (r.capitulos > 300) s.push('MUITOS-CAPS');
  if (r.formato !== 'txt' && r.capitulos === 1 && r.chars > 200000) s.push('1-CAP-GIGANTE');
  if (/[\u0000-\u0008�]/.test(r.titulo ?? '') || /^\s*$/.test(r.titulo ?? '') || /^(untitled|sem t[ií]tulo|microsoft word|\w+\.(docx?|indd|pdf|tex))/i.test(r.titulo ?? '')) s.push('TÍTULO-SUSPEITO');
  if (r.rssMB > 1500) s.push('MEM>1,5G');
  if (bytes > 0 && r.chars > 0 && r.chars < bytes / 2000 && r.formato !== 'pdf') s.push('POUCO-TEXTO');
  return s;
}

async function principal() {
  const o = opcoes(process.argv.slice(2));
  if (o.worker) {
    const caminho = o.alvos[0];
    const r = await trabalhar(caminho, o.worker);
    process.stdout.write(`${JSON.stringify(r)}\n`);
    return;
  }
  if (o.alvos.length === 0) {
    console.error('Uso: node scripts/corpus.mjs [--timeout=SEG] [--max-pdf=N] [--max-epub=N] [--max-txt=N] [--json] [--nomes] <pasta-ou-arquivo>...');
    process.exit(1);
  }
  const todos = [];
  for (const a of o.alvos) await varrer(a, o.minKb * 1024, todos);
  const escolhidos = ['pdf', 'epub', 'txt'].flatMap((f) => amostrar(todos.filter((t) => t.formato === f), o.max[f]));
  const linhas = [];
  let idx = 0;
  for (const arq of escolhidos) {
    idx++;
    const r = await executarFilho(arq, o.timeout);
    r.id = `${arq.formato}-${String(idx).padStart(3, '0')}`;
    r.bytes = arq.bytes;
    if (o.nomes) r.arquivo = basename(arq.caminho);
    r.suspeitas = suspeitas(r, arq.bytes);
    linhas.push(r);
    if (o.json) console.log(JSON.stringify(r));
    else {
      const res = r.ok ? 'ok' : 'ERRO';
      console.log(
        [
          r.id.padEnd(8),
          fmtBytes(arq.bytes).padStart(6),
          res.padEnd(4),
          `${(r.ms / 1000).toFixed(1)}s`.padStart(7),
          `cap=${r.capitulos ?? '-'}`.padEnd(8),
          `chars=${r.chars ?? '-'}`.padEnd(13),
          `img=${r.imagens ?? '-'}`.padEnd(7),
          `mem=${r.rssMB ?? '-'}M`.padEnd(9),
          r.ok ? `avisos=${r.avisos.length ? r.avisos.join(';') : '-'}` : r.erro,
          r.suspeitas.length ? `[${r.suspeitas.join(',')}]` : '',
          o.nomes ? `(${r.arquivo})` : '',
        ].join(' '),
      );
    }
  }
  if (!o.json) {
    console.log('\nResumo por formato');
    for (const f of ['pdf', 'epub', 'txt']) {
      const l = linhas.filter((x) => x.formato === f);
      if (l.length === 0) continue;
      const ok = l.filter((x) => x.ok).length;
      const maior = Math.max(...l.map((x) => x.ms ?? 0));
      const mem = Math.max(...l.map((x) => x.rssMB ?? 0));
      console.log(`${f}: ${l.length} arquivos, ${ok} ok, ${l.length - ok} com erro, mais lento ${(maior / 1000).toFixed(1)}s, pico de memória ${mem}M, suspeitos ${l.filter((x) => x.suspeitas.length).length}`);
    }
  }
}

principal().catch((e) => {
  console.error(e);
  process.exit(1);
});
