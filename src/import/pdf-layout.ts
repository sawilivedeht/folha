// Algoritmo puro de reconstrução de layout de PDF para blocos refluíveis.
// Sem dependências de pdfjs-dist ou DOM — executável diretamente no Node e em testes vitest.
// Mantém apenas sintaxe TypeScript apagável (compatível com `node --experimental-strip-types`).
import type { Block, Chapter, Run } from '../types';

export interface PdfTextItem {
  str: string;
  x: number;
  /** Coordenada Y: por padrão em espaço PDF (origem embaixo, cresce para cima). Use yOrigin: 'top-down' se Y cresce para baixo. */
  y: number;
  w: number;
  /** Altura da fonte (em pontos/px na mesma escala de width/height). */
  h: number;
  fontName: string;
  bold?: boolean;
  italic?: boolean;
}

export interface PdfPageInput {
  /** Número da página (1-based). */
  pageNumber: number;
  width: number;
  height: number;
  items: PdfTextItem[];
  /** Imagem da página inteira: páginas sem texto (figura/mapa) ou de texto com figura grande (vem depois do texto). */
  fallbackImage?: { src: string; w: number; h: number; alt?: string };
}

export interface PdfOutlineEntry {
  title: string;
  /** Página de destino (1-based). */
  pageNumber: number;
  /** Nível no sumário (0 = raiz). */
  level?: number;
}

export interface PdfLayoutOptions {
  /** Sumário do PDF; tem prioridade sobre títulos detectados para cortar capítulos. */
  outline?: PdfOutlineEntry[];
  /** Limite aproximado de caracteres por capítulo antes de dividir em "(cont.)". Padrão: 60000. */
  maxChapterChars?: number;
  /** Páginas por capítulo quando não há títulos nem sumário. Padrão: 15. */
  pagesPerChapter?: number;
  /** Origem do eixo Y dos itens. Padrão: 'pdf' (cresce para cima). */
  yOrigin?: 'pdf' | 'top-down';
}

interface NormItem {
  str: string;
  rawWhitespaceOnly: boolean;
  x: number;
  yTop: number;
  w: number;
  h: number;
  bold: boolean;
  italic: boolean;
}

interface TextSpan {
  s: string;
  b?: 1;
  i?: 1;
  sup?: 1;
}

interface LayoutLine {
  pageNumber: number;
  pageHeight: number;
  text: string;
  spans: TextSpan[];
  x: number;
  xEnd: number;
  yTop: number;
  fontSize: number;
  allBold: boolean;
  allItalic: boolean;
  colLeft: number;
  colRight: number;
  column: number; // 0 = largura total, 1 = coluna esquerda, 2 = coluna direita
}

interface TaggedBlock {
  block: Block;
  pageNumber: number;
}

const DEFAULT_MAX_CHAPTER_CHARS = 60_000;
const DEFAULT_PAGES_PER_CHAPTER = 15;
const MAX_HEADING_LENGTH = 120;

const LIGATURES: Record<string, string> = {
  '\uFB00': 'ff',
  '\uFB01': 'fi',
  '\uFB02': 'fl',
  '\uFB03': 'ffi',
  '\uFB04': 'ffl',
  '\uFB05': 'st',
  '\uFB06': 'st',
};

const LIGATURE_RE = /[\uFB00-\uFB06]/g;
const WEIRD_SPACE_RE = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\t\r\n]+/g;
const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF]/g;
// Remove caracteres de controle mantendo \u00AD (soft hyphen) até a etapa de desifenização.
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

const BOLD_FONT_RE = /(?:bold|black|heavy|semibold|demibold|extrabold|ultrabold|(?:^|[-_+])(?:bd|demi)(?:$|[-_+]|mt|it|ob)|^cmbx)/i;
const ITALIC_FONT_RE = /(?:italic|oblique|slant|(?:^|[-_+])(?:it|ob|ital)(?:$|[-_+]|mt)|^cm(?:ti|sl))/i;

// Prefixos portugueses que sempre mantêm hífen segundo o Acordo Ortográfico
// e não aparecem como sílaba inicial comum de palavras sem hífen.
const ALWAYS_HYPHEN_PREFIXES = new Set([
  'vice',
  'recém',
  'além',
  'aquém',
  'grão',
  'grã',
  'soto',
  'bem',
]);

// Exceções raras sem hífen iniciadas por "pós-".
const POS_NON_COMPOUND_SUFFIXES = new Set(['tero', 'tera', 'teros', 'teras', 'tumo', 'tuma', 'tumos', 'tumas']);

// Prefixos que mantêm hífen apenas antes de 'h' ou da mesma vogal final.
const SAME_VOWEL_OR_H_PREFIXES = new Set([
  'anti',
  'auto',
  'contra',
  'extra',
  'infra',
  'intra',
  'macro',
  'micro',
  'mini',
  'neo',
  'proto',
  'pseudo',
  'semi',
  'sobre',
  'supra',
  'ultra',
]);

// Prefixos terminados em 'r' que mantêm hífen antes de 'r' ou 'h'.
const R_OR_H_PREFIXES = new Set(['inter', 'hiper', 'super']);

// Pares compostos frequentes em português (prefixo -> sufixos conhecidos).
const KNOWN_COMPOUND_PAIRS: Record<string, Set<string>> = {
  ex: new Set([
    'presidente', 'presidentes', 'ministro', 'ministra', 'ministros', 'governador', 'governadora',
    'prefeito', 'prefeita', 'senador', 'senadora', 'deputado', 'deputada', 'diretor', 'diretora',
    'aluno', 'aluna', 'alunos', 'alunas', 'marido', 'esposa', 'mulher', 'namorado', 'namorada',
    'companheiro', 'companheira', 'cônjuge', 'chefe', 'funcionário', 'funcionária', 'jogador',
    'jogadora', 'técnico', 'treinador', 'professor', 'professora', 'colega', 'amigo', 'amiga',
    'sócio', 'sócia', 'membro', 'combatente', 'detento', 'presidiário', 'fumante', 'militar',
    'policial', 'agente', 'secretário', 'secretária', 'juiz', 'juíza', 'procurador', 'embaixador',
    'rei', 'rainha', 'imperador', 'papa', 'padre', 'líder', 'campeão', 'campeã', 'titular',
    'morador', 'moradora', 'dono', 'dona', 'proprietário', 'cliente', 'parceiro', 'parceira',
    'patrão', 'empregado', 'servidor', 'escravo', 'colônia', 'colônias', 'república',
  ]),
  pré: new Set([
    'história', 'histórico', 'histórica', 'históricos', 'históricas', 'natal', 'escolar', 'escola',
    'vestibular', 'requisito', 'requisitos', 'pago', 'paga', 'pagos', 'pagas', 'venda', 'vendas',
    'estreia', 'estréia', 'lançamento', 'candidato', 'candidata', 'candidatos', 'candidatura',
    'temporada', 'olímpico', 'olímpica', 'adolescente', 'adolescência', 'primário', 'sal',
    'colombiano', 'colombiana', 'moderno', 'moderna', 'industrial', 'guerra', 'operatório',
    'operatória', 'existente', 'existentes', 'estabelecido', 'estabelecida', 'definido', 'definida',
    'determinado', 'determinada', 'aprovado', 'aprovada', 'selecionado', 'selecionada', 'seleção',
    'moldado', 'moldada', 'fabricado', 'fabricada', 'cozido', 'cozida', 'aquecido', 'aquecida',
    'datado', 'datada', 'socrático', 'socrática', 'socráticos', 'clássico', 'clássica',
    'científico', 'científica', 'conceito', 'conceitos', 'julgamento', 'aviso', 'acordo',
    'contrato', 'projeto', 'texto', 'fixo', 'diabetes', 'eclâmpsia', 'menstrual', 'parto',
    'teste', 'treino', 'jogo', 'eliminatória', 'final', 'festa', 'carnaval', 'campanha',
    'eleitoral', 'registro', 'inscrição', 'matrícula', 'reserva', 'análise', 'diagnóstico',
    'tratamento', 'consulta', 'exame', 'alta', 'crise', 'reforma', 'revolução', 'pandemia',
  ]),
  pró: new Set([
    'vida', 'aborto', 'ativo', 'ativa', 'ativos', 'ativas', 'atividade', 'reitor', 'reitora',
    'reitoria', 'labore', 'forma', 'rata', 'memória', 'tempore', 'democracia', 'governo',
    'mercado', 'europa', 'europeu', 'americano', 'americana', 'ocidental', 'independência',
    'ambiente', 'família', 'imigrante', 'ciência', 'vacina', 'direitos', 'saúde', 'cota', 'cotas',
    'reforma', 'trabalho', 'trabalhador',
  ]),
  sem: new Set([
    'terra', 'teto', 'vergonha', 'fim', 'número', 'cerimônia', 'abrigo', 'sal', 'sabor',
    'pulo', 'família', 'pátria', 'jeito', 'noção', 'razão', 'rumo', 'senso', 'volta', 'saída',
  ]),
  mal: new Set(['me', 'cheiroso']),
  sota: new Set(['piloto', 'mestre', 'capitão', 'patrão']),
  beija: new Set(['flor', 'flores', 'mão', 'mãos']),
  couve: new Set(['flor', 'flores', 'manteiga']),
  arco: new Set(['íris']),
  quebra: new Set([
    'cabeça', 'cabeças', 'mar', 'mares', 'nozes', 'molas', 'mola', 'galho', 'galhos',
    'queixo', 'sol', 'luz', 'vento', 'gelo', 'costela', 'ossos', 'pedra', 'pedras', 'pau',
    'prato', 'quebra',
  ]),
  saca: new Set(['rolhas', 'rolha', 'rabo', 'trapo', 'buxa', 'fundo', 'moedas', 'pregos']),
  tira: new Set([
    'gosto', 'gostos', 'teima', 'teimas', 'manchas', 'mancha', 'dúvidas', 'dúvida',
    'linhas', 'prosa', 'cisma', 'pó', 'leite', 'fino', 'onda', 'peles', 'olhos',
  ]),
  bate: new Set([
    'papo', 'papos', 'boca', 'bocas', 'volta', 'estaca', 'estacas', 'bate', 'bola',
    'chapa', 'coxa', 'fundo', 'entope', 'folha', 'pau', 'pé', 'orelha',
  ]),
  pica: new Set(['pau', 'paus', 'fumo', 'flor', 'pedra', 'peixe', 'osso', 'boi']),
  vira: new Set(['lata', 'latas', 'casaca', 'casacas', 'mundo', 'folha', 'mão', 'cara', 'copos', 'olhos', 'saia']),
  segunda: new Set(['feira', 'feiras']),
  terça: new Set(['feira', 'feiras']),
  quarta: new Set(['feira', 'feiras']),
  quinta: new Set(['feira', 'feiras']),
  sexta: new Set(['feira', 'feiras']),
  guarda: new Set([
    'chuva',
    'chuvas',
    'roupa',
    'roupas',
    'sol',
    'costas',
    'livros',
    'noturno',
    'pó',
    'vidas',
    'mato',
    'florestal',
  ]),
  porta: new Set([
    'voz',
    'vozes',
    'aviões',
    'bandeira',
    'malas',
    'retrato',
    'retratos',
    'luvas',
    'chaves',
    'joias',
    'jóias',
  ]),
  matéria: new Set(['prima', 'primas']),
  obra: new Set(['prima', 'primas']),
  meio: new Set(['dia', 'fio', 'termo']),
  meia: new Set(['noite', 'luz', 'volta', 'idade', 'entrada']),
  alto: new Set(['falante', 'falantes', 'mar', 'relevo']),
  curto: new Set(['circuito', 'circuitos']),
  primeiro: new Set(['ministro', 'ministros']),
  primeira: new Set(['ministra', 'dama', 'mão']),
  salário: new Set(['mínimo', 'família']),
  seguro: new Set(['desemprego', 'saúde', 'vida']),
  mão: new Set(['dupla', 'única', 'cheia']),
  ponto: new Set(['final', 'chave', 'morto']),
  livre: new Set(['arbítrio', 'docente', 'pensador', 'comércio']),
  longa: new Set(['metragem', 'metragens']),
  curta: new Set(['metragem', 'metragens']),
  recém: new Set(['nascido', 'nascidos', 'casado', 'casados', 'chegado', 'formado']),
};

const CLITIC_LO_SET = new Set(['lo', 'la', 'los', 'las']);
const CLITIC_LHE_SET = new Set(['lhe', 'lhes']);
const CLITIC_ME_TE_SET = new Set(['me', 'te']);
const CLITIC_NOS_VOS_SET = new Set(['nos', 'vos']);

// Palavras inteiras terminadas em -se/-lhe/-te/-nos/-me/-vos que não são verbo + clítico.
const NON_CLITIC_SE_WORDS = new Set([
  'fase', 'base', 'frase', 'crase', 'quase', 'ênfase', 'êxtase',
  'atrase', 'arrase', 'embase', 'defase', 'converse', 'disperse',
  'paráfrase', 'perífrase', 'metástase', 'síntase', 'hipóstase', 'diástase',
  'síntese', 'hipótese', 'prótese', 'antítese', 'parêntese', 'gênese',
  'diocese', 'catequese', 'exegese', 'anamnese', 'diurese', 'ascese',
  'mímese', 'diérese', 'sinérese', 'epêntese', 'metátese', 'aférese',
]);
const NON_CLITIC_SE_SUFFIX_RE = /(?:sínte|gêne|próte|hipóte|antíte|parênte)se$/;
const NON_CLITIC_LHE_WORDS = new Set(['baralhe', 'baralhes', 'embaralhe', 'embaralhes']);
const NON_CLITIC_OBJ_WORDS = new Set([
  'parte', 'aparte', 'reparte', 'descarte', 'infarte', 'marte',
  'alerte', 'aperte', 'acerte', 'conserte', 'desperte', 'deserte', 'disserte',
  'enxerte', 'oferte', 'adverte', 'converte', 'diverte', 'inverte', 'perverte',
  'reverte', 'subverte', 'inserte',
  'leite', 'azeite', 'aceite', 'respeite', 'suspeite', 'aproveite', 'enfeite',
  'rejeite', 'sujeite', 'ajeite', 'deleite', 'espreite', 'deite', 'endireite', 'estreite',
  'noite', 'açoite', 'pernoite',
  'trate', 'contrate', 'retrate', 'maltrate', 'hidrate', 'desidrate', 'desbarate',
  'modernos', 'eternos', 'internos', 'externos', 'paternos', 'maternos', 'fraternos',
  'invernos', 'governos', 'cadernos', 'infernos', 'alternos', 'subalternos', 'ternos',
  'supernos', 'hodiernos', 'quaternos',
  'firme', 'alarme', 'charme', 'germe', 'desarme', 'rearme', 'inerme',
  'queime', 'teime', 'derrame', 'trame',
  'acervos', 'cervos', 'servos', 'nervos', 'parvos', 'cravos', 'bravos', 'escravos',
]);

/** Normaliza ligaduras, espaços estranhos, caracteres de controle e composição Unicode (NFC). */
export function normalizePdfText(str: string): string {
  return str
    .replace(LIGATURE_RE, (ch) => LIGATURES[ch] ?? ch)
    .replace(ZERO_WIDTH_RE, '')
    .replace(CONTROL_CHAR_RE, '')
    .replace(WEIRD_SPACE_RE, ' ')
    .normalize('NFC');
}

function stripSoftHyphens(str: string): string {
  return str.replace(/\u00AD/g, '');
}

function detectBold(item: PdfTextItem): boolean {
  if (typeof item.bold === 'boolean') return item.bold;
  return BOLD_FONT_RE.test(item.fontName);
}

function detectItalic(item: PdfTextItem): boolean {
  if (typeof item.italic === 'boolean') return item.italic;
  return ITALIC_FONT_RE.test(item.fontName);
}

function weightedMedian(entries: Array<{ value: number; weight: number }>, fallback: number): number {
  if (entries.length === 0) return fallback;
  const sorted = entries.slice().sort((a, b) => a.value - b.value);
  let total = 0;
  for (const e of sorted) total += e.weight;
  if (total <= 0) return fallback;
  const half = total / 2;
  let acc = 0;
  for (const e of sorted) {
    acc += e.weight;
    if (acc >= half) return e.value;
  }
  return sorted[sorted.length - 1].value;
}

function median(values: number[], fallback: number): number {
  if (values.length === 0) return fallback;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function percentile(values: number[], p: number, fallback: number): number {
  if (values.length === 0) return fallback;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return sorted[idx];
}

/** Converte os itens da página para coordenadas top-down normalizadas. */
function normalizePageItems(page: PdfPageInput, yOrigin: 'pdf' | 'top-down'): NormItem[] {
  const out: NormItem[] = [];
  for (const raw of page.items) {
    const str = normalizePdfText(raw.str);
    if (str.length === 0) continue;
    const rawWhitespaceOnly = str.trim().length === 0;
    const h = raw.h > 0 ? raw.h : 12;
    const w = Math.max(0, raw.w);
    const yTop = yOrigin === 'top-down' ? raw.y : page.height - raw.y;
    out.push({
      str,
      rawWhitespaceOnly,
      x: raw.x,
      yTop,
      w,
      h,
      bold: detectBold(raw),
      italic: detectItalic(raw),
    });
  }
  return out;
}

interface RawRow {
  yTop: number;
  maxH: number;
  items: NormItem[];
}

/** Agrupa itens por linha de base (mesmo yTop dentro de tolerância). */
function groupIntoRawRows(items: NormItem[]): RawRow[] {
  if (items.length === 0) return [];
  const sorted = items.slice().sort((a, b) => a.yTop - b.yTop || a.x - b.x);
  const rows: RawRow[] = [];

  for (const item of sorted) {
    let matched: RawRow | null = null;
    let bestDist = Infinity;
    // Busca nas últimas linhas criadas para lidar com pequenas variações de yTop.
    const startIdx = Math.max(0, rows.length - 6);
    for (let i = rows.length - 1; i >= startIdx; i--) {
      const row = rows[i];
      const tol = Math.max(2, Math.max(row.maxH, item.h) * 0.42);
      const dist = Math.abs(item.yTop - row.yTop);
      if (dist <= tol && dist < bestDist) {
        bestDist = dist;
        matched = row;
      }
    }

    if (matched) {
      matched.items.push(item);
      if (item.h > matched.maxH) matched.maxH = item.h;
      // Mantém yTop ponderado pelos itens não-sobrescritos.
      if (item.h >= matched.maxH * 0.75) {
        const n = matched.items.length;
        matched.yTop = (matched.yTop * (n - 1) + item.yTop) / n;
      }
    } else {
      rows.push({ yTop: item.yTop, maxH: item.h, items: [item] });
    }
  }

  rows.sort((a, b) => a.yTop - b.yTop);
  for (const r of rows) {
    r.items.sort((a, b) => a.x - b.x);
  }
  return rows;
}

function coalesceSpans(spans: TextSpan[]): TextSpan[] {
  const merged: TextSpan[] = [];
  for (const span of spans) {
    if (span.s.length === 0) continue;
    const prev = merged[merged.length - 1];
    if (prev && prev.b === span.b && prev.i === span.i && prev.sup === span.sup) {
      prev.s += span.s;
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

function trimSpans(spans: TextSpan[]): TextSpan[] {
  const out = coalesceSpans(spans);
  while (out.length > 0) {
    out[0].s = out[0].s.replace(/^ +/, '');
    if (out[0].s.length === 0) out.shift();
    else break;
  }
  while (out.length > 0) {
    const last = out[out.length - 1];
    last.s = last.s.replace(/ +$/, '');
    if (last.s.length === 0) out.pop();
    else break;
  }
  return out;
}

/** Constrói uma LayoutLine a partir de itens ordenados em X na mesma linha. */
function buildLayoutLine(
  items: NormItem[],
  pageNumber: number,
  pageHeight: number,
  colLeft: number,
  colRight: number,
  column: number,
): LayoutLine | null {
  if (items.length === 0) return null;
  const sorted = items.slice().sort((a, b) => a.x - b.x);

  // Calcula tamanho de fonte dominante na linha.
  const sizeWeights: Array<{ value: number; weight: number }> = [];
  let sumY = 0;
  let countY = 0;
  for (const it of sorted) {
    if (it.rawWhitespaceOnly) continue;
    const len = it.str.trim().length;
    if (len > 0) {
      sizeWeights.push({ value: Math.round(it.h * 2) / 2, weight: len });
    }
  }
  if (sizeWeights.length === 0) return null;

  const lineFontSize = weightedMedian(sizeWeights, sorted[0].h);
  for (const it of sorted) {
    if (!it.rawWhitespaceOnly && it.h >= lineFontSize * 0.75) {
      sumY += it.yTop;
      countY++;
    }
  }
  const baseY = countY > 0 ? sumY / countY : sorted[0].yTop;

  const spans: TextSpan[] = [];
  let prevVisible: NormItem | null = null;
  let pendingSpace = false;
  let firstX = Infinity;
  let lastXEnd = -Infinity;
  let totalNonSpaceChars = 0;
  let boldChars = 0;
  let italicChars = 0;

  for (const it of sorted) {
    if (it.rawWhitespaceOnly) {
      if (prevVisible) pendingSpace = true;
      continue;
    }

    // Deduplica "fake bold" por sobreimpressão idêntica na mesma posição.
    // Compara dx com a largura do item anterior para não apagar letras estreitas dobradas ("ii", "ll").
    if (prevVisible && it.str === prevVisible.str) {
      const maxDx = prevVisible.w > 0 ? Math.min(1.0, prevVisible.w * 0.35) : 0.5;
      const maxDy = Math.min(1.5, Math.max(0.5, prevVisible.h * 0.2));
      if (Math.abs(it.x - prevVisible.x) < maxDx && Math.abs(it.yTop - prevVisible.yTop) < maxDy) {
        const lastSpan = spans[spans.length - 1];
        if (lastSpan) lastSpan.b = 1;
        if (!prevVisible.bold) {
          boldChars += prevVisible.str.trim().length;
          prevVisible = { ...(prevVisible as NormItem), bold: true };
        }
        continue;
      }
    }

    let text = it.str.replace(/ {2,}/g, ' ');

    if (prevVisible) {
      const gap = it.x - (prevVisible.x + prevVisible.w);
      const refH = Math.min(prevVisible.h, it.h);
      const spaceThreshold = Math.max(1.2, refH * 0.18);
      const prevEndsSpace = spans.length > 0 && spans[spans.length - 1].s.endsWith(' ');
      const currStartsSpace = text.startsWith(' ');

      if ((pendingSpace || gap > spaceThreshold) && !prevEndsSpace && !currStartsSpace) {
        spans.push({ s: ' ' });
      } else if (prevEndsSpace && currStartsSpace) {
        text = text.slice(1);
      }
    }
    pendingSpace = false;

    if (it.x < firstX) firstX = it.x;
    const endX = it.x + it.w;
    if (endX > lastXEnd) lastXEnd = endX;

    const trimmedLen = text.trim().length;
    const isSup =
      it.h <= lineFontSize * 0.72 &&
      it.yTop < baseY - lineFontSize * 0.12 &&
      trimmedLen > 0 &&
      trimmedLen <= 4;

    const span: TextSpan = { s: text };
    if (it.bold) span.b = 1;
    if (it.italic) span.i = 1;
    if (isSup) span.sup = 1;
    spans.push(span);

    totalNonSpaceChars += trimmedLen;
    if (it.bold) boldChars += trimmedLen;
    if (it.italic) italicChars += trimmedLen;

    prevVisible = it;
  }

  const cleanSpans = trimSpans(spans);
  if (cleanSpans.length === 0) return null;

  const fullText = cleanSpans.map((sp) => sp.s).join('');
  if (fullText.trim().length === 0) return null;

  return {
    pageNumber,
    pageHeight,
    text: fullText,
    spans: cleanSpans,
    x: firstX,
    xEnd: lastXEnd,
    yTop: baseY,
    fontSize: lineFontSize,
    allBold: totalNonSpaceChars > 0 && boldChars === totalNonSpaceChars,
    allItalic: totalNonSpaceChars > 0 && italicChars === totalNonSpaceChars,
    colLeft,
    colRight,
    column,
  };
}

interface ColumnSplit {
  splitX: number;
  gutterMinGap: number;
  medianGap: number;
  leftMin: number;
  leftMax: number;
  rightMin: number;
  rightMax: number;
}

/** Detecta se uma página possui duas colunas com lacuna vertical central consistente. */
function detectTwoColumns(rows: RawRow[], pageWidth: number, pageHeight: number): ColumnSplit | null {
  const bodyRows = rows.filter(
    (r) => r.yTop >= pageHeight * 0.08 && r.yTop <= pageHeight * 0.92 && r.items.some((i) => !i.rawWhitespaceOnly),
  );
  if (bodyRows.length < 4) return null;

  let contentLeft = Infinity;
  let contentRight = -Infinity;
  const heights: number[] = [];

  for (const r of bodyRows) {
    for (const it of r.items) {
      if (it.rawWhitespaceOnly) continue;
      if (it.x < contentLeft) contentLeft = it.x;
      if (it.x + it.w > contentRight) contentRight = it.x + it.w;
      heights.push(it.h);
    }
  }

  const contentWidth = contentRight - contentLeft;
  if (!Number.isFinite(contentWidth) || contentWidth < pageWidth * 0.4) return null;

  const bodyH = median(heights, 12);
  const gutterMinGap = Math.max(10, bodyH * 1.1);
  const searchMin = contentLeft + contentWidth * 0.34;
  const searchMax = contentLeft + contentWidth * 0.66;
  const contentCenter = (contentLeft + contentRight) / 2;

  let best: {
    splitX: number;
    dualRows: number;
    crossingRows: number;
    medianGap: number;
    leftMin: number;
    leftMax: number;
    rightMin: number;
    rightMax: number;
  } | null = null;

  const step = Math.max(2, Math.floor((searchMax - searchMin) / 40));
  for (let splitX = searchMin; splitX <= searchMax; splitX += step) {
    let dualRows = 0;
    let crossingRows = 0;
    const gaps: number[] = [];
    let leftMin = Infinity;
    let leftMax = -Infinity;
    let rightMin = Infinity;
    let rightMax = -Infinity;

    for (const r of bodyRows) {
      let rowCrosses = false;
      let rLeftMax = -Infinity;
      let rLeftMin = Infinity;
      let rRightMin = Infinity;
      let rRightMax = -Infinity;

      for (const it of r.items) {
        if (it.rawWhitespaceOnly) continue;
        const x1 = it.x;
        const x2 = it.x + it.w;
        if (x1 + 1 < splitX && x2 - 1 > splitX) {
          rowCrosses = true;
          break;
        }
        if (x2 <= splitX + 1) {
          if (x1 < rLeftMin) rLeftMin = x1;
          if (x2 > rLeftMax) rLeftMax = x2;
        } else if (x1 >= splitX - 1) {
          if (x1 < rRightMin) rRightMin = x1;
          if (x2 > rRightMax) rRightMax = x2;
        }
      }

      if (rowCrosses) {
        crossingRows++;
        continue;
      }

      if (rLeftMax > -Infinity && rRightMin < Infinity) {
        const gap = rRightMin - rLeftMax;
        if (gap < gutterMinGap) {
          // Itens nos dois lados separados por espaço normal entre palavras formam linha contínua.
          crossingRows++;
          continue;
        }
        dualRows++;
        gaps.push(gap);
      }

      if (rLeftMax > -Infinity) {
        if (rLeftMin < leftMin) leftMin = rLeftMin;
        if (rLeftMax > leftMax) leftMax = rLeftMax;
      }
      if (rRightMin < Infinity) {
        if (rRightMin < rightMin) rightMin = rRightMin;
        if (rRightMax > rightMax) rightMax = rRightMax;
      }
    }

    const nonCrossing = bodyRows.length - crossingRows;
    if (dualRows < 3 || nonCrossing === 0) continue;
    if (crossingRows / bodyRows.length > 0.35) continue;
    if (dualRows / nonCrossing < 0.45) continue;

    const leftSpan = leftMax - leftMin;
    const rightSpan = rightMax - rightMin;
    if (leftSpan < contentWidth * 0.2 || rightSpan < contentWidth * 0.2) continue;

    const medGap = median(gaps, 0);
    if (medGap < gutterMinGap) continue;

    const isBetter =
      !best ||
      dualRows > best.dualRows ||
      (dualRows === best.dualRows && crossingRows < best.crossingRows) ||
      (dualRows === best.dualRows &&
        crossingRows === best.crossingRows &&
        (medGap > best.medianGap + 1 ||
          (Math.abs(medGap - best.medianGap) <= 1 &&
            Math.abs(splitX - contentCenter) < Math.abs(best.splitX - contentCenter))));

    if (isBetter) {
      best = { splitX, dualRows, crossingRows, medianGap: medGap, leftMin, leftMax, rightMin, rightMax };
    }
  }

  if (!best) return null;
  return {
    splitX: best.splitX,
    gutterMinGap,
    medianGap: best.medianGap,
    leftMin: best.leftMin,
    leftMax: best.leftMax,
    rightMin: best.rightMin,
    rightMax: best.rightMax,
  };
}

/** Constrói as linhas em ordem de leitura de uma página (com suporte a 2 colunas). */
function extractPageLines(page: PdfPageInput, yOrigin: 'pdf' | 'top-down'): LayoutLine[] {
  const normItems = normalizePageItems(page, yOrigin);
  if (normItems.length === 0) return [];

  const rows = groupIntoRawRows(normItems);
  const colSplit = detectTwoColumns(rows, page.width, page.height);

  // Limites horizontais gerais da página para layout de coluna única.
  let pageMinX = Infinity;
  let pageMaxX = -Infinity;
  for (const it of normItems) {
    if (it.rawWhitespaceOnly) continue;
    if (it.x < pageMinX) pageMinX = it.x;
    if (it.x + it.w > pageMaxX) pageMaxX = it.x + it.w;
  }
  if (!Number.isFinite(pageMinX)) return [];

  if (!colSplit) {
    const lines: LayoutLine[] = [];
    for (const r of rows) {
      const line = buildLayoutLine(r.items, page.pageNumber, page.height, pageMinX, pageMaxX, 0);
      if (line) lines.push(line);
    }
    return lines;
  }

  // Com duas colunas: separa faixas de largura total (linhas que cruzam a calha central)
  // e, dentro de cada faixa entre elas, lê coluna esquerda inteira e depois coluna direita inteira.
  const lines: LayoutLine[] = [];
  let bandLeft: NormItem[] = [];
  let bandRight: NormItem[] = [];

  const flushBand = () => {
    if (bandLeft.length > 0) {
      const leftRows = groupIntoRawRows(bandLeft);
      for (const lr of leftRows) {
        const line = buildLayoutLine(lr.items, page.pageNumber, page.height, colSplit.leftMin, colSplit.leftMax, 1);
        if (line) lines.push(line);
      }
      bandLeft = [];
    }
    if (bandRight.length > 0) {
      const rightRows = groupIntoRawRows(bandRight);
      for (const rr of rightRows) {
        const line = buildLayoutLine(rr.items, page.pageNumber, page.height, colSplit.rightMin, colSplit.rightMax, 2);
        if (line) lines.push(line);
      }
      bandRight = [];
    }
  };

  for (const r of rows) {
    let crosses = false;
    let rLeftMax = -Infinity;
    let rRightMin = Infinity;

    for (const it of r.items) {
      if (it.rawWhitespaceOnly) continue;
      const x1 = it.x;
      const x2 = it.x + it.w;
      if (x1 + 1 < colSplit.splitX && x2 - 1 > colSplit.splitX) {
        crosses = true;
        break;
      }
      if (x2 <= colSplit.splitX + 1) {
        if (x2 > rLeftMax) rLeftMax = x2;
      } else if (x1 >= colSplit.splitX - 1) {
        if (x1 < rRightMin) rRightMin = x1;
      }
    }

    if (!crosses && rLeftMax > -Infinity && rRightMin < Infinity) {
      // Itens nos dois lados da calha com espaço de palavra entre si formam linha de largura total.
      const rowGap = rRightMin - rLeftMax;
      const crossGapLimit = Math.min(colSplit.medianGap * 0.75, Math.max(colSplit.gutterMinGap, r.maxH * 0.75));
      if (rowGap < crossGapLimit) {
        crosses = true;
      }
    }

    if (crosses) {
      flushBand();
      const line = buildLayoutLine(r.items, page.pageNumber, page.height, pageMinX, pageMaxX, 0);
      if (line) lines.push(line);
      continue;
    }

    for (const it of r.items) {
      const mid = it.x + it.w / 2;
      if (mid <= colSplit.splitX) bandLeft.push(it);
      else bandRight.push(it);
    }
  }
  flushBand();

  return lines;
}

const HEADER_FOOTER_ZONE = 0.11;
const Y_CLUSTER_TOL = 0.015;

const DECORATED_ARABIC_PAGE_NUM_RE =
  /^(?:[-–—·•|\[\]()\s]*(?:p(?:ág|ag|age)?\.?\s*\d{1,5}(?:\s*(?:\/|de|of)\s*\d{1,5})?|\d{1,5}\s*(?:\/|de|of)\s*\d{1,5})[-–—·•|\[\]()\s]*|[-–—·•|\[\](]+\s*\d{1,5}\s*[-–—·•|\[\])]+)$/i;
const BARE_ARABIC_PAGE_NUM_RE = /^\d{1,5}$/;
const DECORATED_ROMAN_WRAP_RE = /^[-–—·•|\[\](]+\s*([ivxlc]+|[IVXLC]+)\s*[-–—·•|\[\])]+$/;
const BARE_ROMAN_RE = /^(?:[ivxlc]+|[IVXLC]+)$/;
// Restringe romanos de paginação a 1..100 para evitar falsos positivos como "CD", "cm", "di" e "mix".
const VALID_ROMAN_1_TO_100_RE = /^(?:c|(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3}))$/;

function romanToInt(roman: string): number {
  const lower = roman.toLowerCase();
  if (!lower || !VALID_ROMAN_1_TO_100_RE.test(lower)) return 0;
  const vals: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100 };
  let total = 0;
  for (let i = 0; i < lower.length; i++) {
    const cur = vals[lower[i]] ?? 0;
    const next = i + 1 < lower.length ? (vals[lower[i + 1]] ?? 0) : 0;
    total += cur < next ? -cur : cur;
  }
  return total;
}

interface ParsedPageNum {
  kind: 'arabic' | 'roman';
  value: number;
  decorated: boolean;
}

function parseStandalonePageNumber(text: string): ParsedPageNum | null {
  const clean = stripSoftHyphens(text).trim();
  if (clean.length === 0 || clean.length > 24) return null;

  if (DECORATED_ARABIC_PAGE_NUM_RE.test(clean)) {
    const numMatch = clean.match(/\d{1,5}/);
    if (numMatch) return { kind: 'arabic', value: Number(numMatch[0]), decorated: true };
  }
  if (BARE_ARABIC_PAGE_NUM_RE.test(clean)) {
    return { kind: 'arabic', value: Number(clean), decorated: false };
  }

  const decRoman = clean.match(DECORATED_ROMAN_WRAP_RE);
  if (decRoman) {
    const val = romanToInt(decRoman[1]);
    if (val > 0) return { kind: 'roman', value: val, decorated: true };
  }
  if (clean.length <= 7 && BARE_ROMAN_RE.test(clean)) {
    const val = romanToInt(clean);
    if (val > 0) return { kind: 'roman', value: val, decorated: false };
  }

  return null;
}

interface YBand {
  yTop: number;
  lines: LayoutLine[];
}

/** Agrupa linhas de uma página em faixas horizontais ordenadas por yTop (independe de 2 colunas). */
function groupPageLinesByY(lines: LayoutLine[], bodyFontSize: number): YBand[] {
  if (lines.length === 0) return [];
  const sorted = lines.slice().sort((a, b) => a.yTop - b.yTop || a.x - b.x);
  const tol = Math.max(4, bodyFontSize * 0.5);
  const bands: YBand[] = [];
  for (const ln of sorted) {
    const last = bands[bands.length - 1];
    if (last && Math.abs(ln.yTop - last.yTop) <= tol) {
      last.lines.push(ln);
    } else {
      bands.push({ yTop: ln.yTop, lines: [ln] });
    }
  }
  return bands;
}

/** Chave normalizada de cabeçalho/rodapé ignorando números e pontuação de borda. */
function headerFooterKey(text: string): string {
  return stripSoftHyphens(text)
    .toLowerCase()
    .replace(/\b\d+\b/g, '')
    .replace(/[-–—|·•/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Remove números de página isolados e cabeçalhos/rodapés repetidos em muitas páginas. */
function stripHeadersFootersAndPageNumbers(
  pagesLines: LayoutLine[][],
  bodyFontSize: number,
  normalStep: number,
): LayoutLine[][] {
  const totalPages = pagesLines.length;
  const sepThreshold = Math.max(normalStep * 1.32, bodyFontSize * 1.65);

  const pageTopCands: Array<Set<LayoutLine>> = [];
  const pageBotCands: Array<Set<LayoutLine>> = [];
  const pageBodyMinYRel: number[] = [];
  const pageBodyMaxYRel: number[] = [];

  interface KeyOcc {
    pageNumber: number;
    yRel: number;
  }
  interface BarePageNumOcc {
    pageNumber: number;
    yRel: number;
    kind: 'arabic' | 'roman';
    offset: number;
    line: LayoutLine;
    isTop: boolean;
  }

  const topOccs = new Map<string, KeyOcc[]>();
  const botOccs = new Map<string, KeyOcc[]>();
  const decoratedPageNums = new Set<LayoutLine>();
  const barePageNumOccs: BarePageNumOcc[] = [];

  for (let pi = 0; pi < totalPages; pi++) {
    const lines = pagesLines[pi];
    const topCands = new Set<LayoutLine>();
    const botCands = new Set<LayoutLine>();
    pageTopCands.push(topCands);
    pageBotCands.push(botCands);
    if (lines.length === 0) continue;

    const pageNum = lines[0].pageNumber;
    const pageHeight = lines[0].pageHeight;
    const topZoneY = pageHeight * HEADER_FOOTER_ZONE;
    const botZoneY = pageHeight * (1 - HEADER_FOOTER_ZONE);
    const bands = groupPageLinesByY(lines, bodyFontSize);

    // Seleciona candidatos no topo por yTop (funciona também em páginas de 2 colunas).
    if (bands.length > 0 && bands[0].yTop <= topZoneY) {
      if (bands.length === 1) {
        for (const ln of bands[0].lines) {
          if (ln.fontSize <= bodyFontSize * 1.15) topCands.add(ln);
        }
      } else {
        const gap01 = bands[1].yTop - bands[0].yTop;
        if (gap01 >= sepThreshold) {
          for (const ln of bands[0].lines) {
            if (ln.fontSize <= bodyFontSize * 1.15) topCands.add(ln);
          }
        } else if (
          bands[1].yTop <= topZoneY &&
          ((bands.length >= 3 && bands[2].yTop - bands[1].yTop >= sepThreshold) ||
            (bands.length === 2 && bands[0].yTop <= pageHeight * 0.07))
        ) {
          for (const ln of bands[0].lines) {
            if (ln.fontSize <= bodyFontSize * 1.15) topCands.add(ln);
          }
          for (const ln of bands[1].lines) {
            if (ln.fontSize <= bodyFontSize * 1.15) topCands.add(ln);
          }
        } else {
          for (const ln of bands[0].lines) {
            if (ln.fontSize <= bodyFontSize * 0.92 && ln.yTop <= pageHeight * 0.08) {
              topCands.add(ln);
            }
          }
        }
      }
    }

    // Seleciona candidatos no rodapé por yTop.
    const lastIdx = bands.length - 1;
    if (lastIdx >= 0 && bands[lastIdx].yTop >= botZoneY) {
      if (bands.length === 1) {
        for (const ln of bands[lastIdx].lines) {
          if (ln.fontSize <= bodyFontSize * 1.15) botCands.add(ln);
        }
      } else {
        const gapLast = bands[lastIdx].yTop - bands[lastIdx - 1].yTop;
        if (gapLast >= sepThreshold) {
          for (const ln of bands[lastIdx].lines) {
            if (ln.fontSize <= bodyFontSize * 1.15) botCands.add(ln);
          }
        } else if (
          bands[lastIdx - 1].yTop >= botZoneY &&
          ((bands.length >= 3 && bands[lastIdx - 1].yTop - bands[lastIdx - 2].yTop >= sepThreshold) ||
            (bands.length === 2 && bands[lastIdx].yTop >= pageHeight * 0.93))
        ) {
          for (const ln of bands[lastIdx - 1].lines) {
            if (ln.fontSize <= bodyFontSize * 1.15) botCands.add(ln);
          }
          for (const ln of bands[lastIdx].lines) {
            if (ln.fontSize <= bodyFontSize * 1.15) botCands.add(ln);
          }
        } else {
          for (const ln of bands[lastIdx].lines) {
            if (ln.fontSize <= bodyFontSize * 0.92 && ln.yTop >= pageHeight * 0.92) {
              botCands.add(ln);
            }
          }
        }
      }
    }

    // Registra a faixa vertical ocupada pelo corpo real da página.
    let minBodyY = Infinity;
    let maxBodyY = -Infinity;
    for (const ln of lines) {
      if (topCands.has(ln) || botCands.has(ln)) continue;
      if (Math.abs(ln.fontSize - bodyFontSize) > bodyFontSize * 0.25) continue;
      const yRel = ln.yTop / pageHeight;
      if (yRel < minBodyY) minBodyY = yRel;
      if (yRel > maxBodyY) maxBodyY = yRel;
    }
    if (minBodyY < Infinity) pageBodyMinYRel.push(minBodyY);
    if (maxBodyY > -Infinity) pageBodyMaxYRel.push(maxBodyY);

    const recordCandidate = (ln: LayoutLine, isTop: boolean) => {
      const yRel = ln.yTop / pageHeight;
      const parsedNum = parseStandalonePageNumber(ln.text);
      if (parsedNum) {
        if (parsedNum.decorated) {
          decoratedPageNums.add(ln);
        } else {
          barePageNumOccs.push({
            pageNumber: pageNum,
            yRel,
            kind: parsedNum.kind,
            offset: parsedNum.value - pageNum,
            line: ln,
            isTop,
          });
        }
      }

      const key = headerFooterKey(ln.text);
      if (key.length > 0 && key.length <= 120) {
        const map = isTop ? topOccs : botOccs;
        let list = map.get(key);
        if (!list) {
          list = [];
          map.set(key, list);
        }
        list.push({ pageNumber: pageNum, yRel });
      }
    };

    for (const ln of topCands) recordCandidate(ln, true);
    for (const ln of botCands) recordCandidate(ln, false);
  }

  const bodyConflictMin = Math.max(2, Math.ceil(totalPages * 0.25));
  const isInsideTopBody = (yRel: number): boolean =>
    pageBodyMinYRel.filter((y) => y <= yRel + 0.008).length >= bodyConflictMin;
  const isInsideBotBody = (yRel: number): boolean =>
    pageBodyMaxYRel.filter((y) => y >= yRel - 0.008).length >= bodyConflictMin;

  // Confirma números de página sem adorno apenas quando formam sequência coerente no mesmo yTop.
  const confirmedBarePageNums = new Set<LayoutLine>();
  for (const occ of barePageNumOccs) {
    if (occ.isTop ? isInsideTopBody(occ.yRel) : isInsideBotBody(occ.yRel)) continue;
    const matchingPages = new Set<number>();
    for (const other of barePageNumOccs) {
      if (
        other.kind === occ.kind &&
        other.offset === occ.offset &&
        Math.abs(other.yRel - occ.yRel) <= Y_CLUSTER_TOL
      ) {
        matchingPages.add(other.pageNumber);
      }
    }
    if (matchingPages.size >= 2) {
      confirmedBarePageNums.add(occ.line);
    }
  }

  // Detecta cabeçalhos/rodapés repetidos exigindo consistência na coordenada vertical (yRel).
  const repeatedTopYs = new Map<string, number[]>();
  const repeatedBotYs = new Map<string, number[]>();

  if (totalPages >= 3) {
    const globalMin = Math.max(2, Math.ceil(totalPages * 0.25));
    const checkRepeated = (
      occsMap: Map<string, KeyOcc[]>,
      target: Map<string, number[]>,
      insideBody: (yRel: number) => boolean,
    ) => {
      for (const [key, occs] of occsMap) {
        const validYs: number[] = [];
        for (const anchor of occs) {
          if (insideBody(anchor.yRel)) continue;
          const clusterPages = new Set<number>();
          for (const other of occs) {
            if (Math.abs(other.yRel - anchor.yRel) <= Y_CLUSTER_TOL) {
              clusterPages.add(other.pageNumber);
            }
          }
          let isRep = clusterPages.size >= globalMin;
          // Cabeçalhos correntes por capítulo em livros longos (>= 3 páginas próximas no mesmo yTop).
          if (!isRep && totalPages >= 10 && clusterPages.size >= 3) {
            const sortedPages = Array.from(clusterPages).sort((a, b) => a - b);
            for (let i = 0; i + 2 < sortedPages.length; i++) {
              if (sortedPages[i + 2] - sortedPages[i] <= 8) {
                isRep = true;
                break;
              }
            }
          }
          if (isRep) validYs.push(anchor.yRel);
        }
        if (validYs.length > 0) target.set(key, validYs);
      }
    };
    checkRepeated(topOccs, repeatedTopYs, isInsideTopBody);
    checkRepeated(botOccs, repeatedBotYs, isInsideBotBody);
  }

  return pagesLines.map((lines, pi) => {
    const topCands = pageTopCands[pi];
    const botCands = pageBotCands[pi];
    return lines.filter((ln) => {
      if (decoratedPageNums.has(ln) || confirmedBarePageNums.has(ln)) return false;

      const yRel = ln.yTop / ln.pageHeight;
      if (topCands.has(ln)) {
        const key = headerFooterKey(ln.text);
        const ys = repeatedTopYs.get(key);
        if (ys && ys.some((cy) => Math.abs(yRel - cy) <= Y_CLUSTER_TOL)) return false;
      }

      if (botCands.has(ln)) {
        const key = headerFooterKey(ln.text);
        const ys = repeatedBotYs.get(key);
        if (ys && ys.some((cy) => Math.abs(yRel - cy) <= Y_CLUSTER_TOL)) return false;
      }

      return true;
    });
  });
}

/** Decide se uma quebra com hífen deve manter o hífen (palavra composta/clítico) ou desifenizar. */
function shouldKeepHyphen(prefix: string, suffix: string, isSuffixWholeWord: boolean): boolean {
  const lowerPrefix = prefix.toLowerCase();
  const lowerSuffix = suffix.toLowerCase();

  // Próxima parte começa com maiúscula (e prefixo não é TUDO MAIÚSCULA): ex. "São-\nPaulo", "ex-\nPresidente".
  const suffixStartsUpper = /^\p{Lu}/u.test(suffix);
  const prefixAllUpper = prefix.length >= 2 && prefix === prefix.toUpperCase() && /\p{L}/u.test(prefix);
  if (suffixStartsUpper && !prefixAllUpper) return true;

  // Prefixos sempre hifenizados (vice-, bem-, recém-, além-...).
  if (ALWAYS_HYPHEN_PREFIXES.has(lowerPrefix)) return true;

  // "pós-" mantém hífen salvo em palavras derivadas raras como "póstero" e "póstumo".
  if (lowerPrefix === 'pós' && !POS_NON_COMPOUND_SUFFIXES.has(lowerSuffix)) return true;

  // "mal-" mantém hífen antes de vogal, 'h' ou 'l' (Acordo Ortográfico: mal-estar, mal-humorado, mal-limpo).
  if (lowerPrefix === 'mal' && lowerSuffix.length >= 3 && /^[aeiouáéíóúâêôãõhl]/u.test(lowerSuffix)) {
    return true;
  }

  // Pares compostos conhecidos (segunda-feira, guarda-chuva, ex-presidente, pré-história...).
  const pairSet = KNOWN_COMPOUND_PAIRS[lowerPrefix];
  if (pairSet && pairSet.has(lowerSuffix)) return true;

  // Regra do Acordo Ortográfico: mesma vogal final ou 'h' inicial (anti-inflamatório, micro-ondas, auto-hipnose).
  if (SAME_VOWEL_OR_H_PREFIXES.has(lowerPrefix)) {
    const lastChar = lowerPrefix[lowerPrefix.length - 1];
    const firstChar = lowerSuffix[0];
    if (firstChar === 'h' || firstChar === lastChar) return true;
  }

  // inter-/hiper-/super- antes de 'r' ou 'h' (super-herói, inter-regional).
  if (R_OR_H_PREFIXES.has(lowerPrefix)) {
    const firstChar = lowerSuffix[0];
    if (firstChar === 'h' || firstChar === 'r') return true;
  }

  // sub- antes de 'b', 'h' ou 'r' (sub-base, sub-reino, sub-humano).
  if (lowerPrefix === 'sub') {
    const firstChar = lowerSuffix[0];
    if (firstChar === 'b' || firstChar === 'h' || firstChar === 'r') return true;
  }

  // Pronomes clíticos em português (fazê-lo, disse-lhe, trata-se, pode-se, vê-se, tornou-se).
  if (isSuffixWholeWord) {
    const combined = lowerPrefix + lowerSuffix;

    if (CLITIC_LO_SET.has(lowerSuffix) && /[áêîô]$/.test(lowerPrefix)) return true;

    if (lowerSuffix === 'se') {
      if (NON_CLITIC_SE_WORDS.has(combined) || NON_CLITIC_SE_SUFFIX_RE.test(combined)) return false;
      if (lowerPrefix.length >= 2 && /(?:[áê]|põe|pôs|ri)$/.test(lowerPrefix)) return true;
      if (
        lowerPrefix.length >= 3 &&
        /(?:[aei]r|pôr|[aeio]u|[aeéê]m|ão|õe|ói|ui|sse|ndo|mos|ei|oi|[iaeu]z|ôs|a|e)$/.test(lowerPrefix)
      ) {
        return true;
      }
    }

    if (CLITIC_LHE_SET.has(lowerSuffix)) {
      if (NON_CLITIC_LHE_WORDS.has(combined)) return false;
      if (lowerPrefix.length >= 2 && /^(?:dá|vê|põe|deu|fez|diz|faz|traz|dei)$/.test(lowerPrefix)) return true;
      if (
        lowerPrefix.length >= 3 &&
        /(?:[aei]r|pôr|[aeio]u|[aeéê]m|ão|õe|ia|va|ra|sse|ndo|mos|ei|oi|[iaeu]z|nha|trouxe|coube|soube|parece|resta|falta|basta|cabe|serve|pede|custa|importa|pertence|agradece)$/.test(
          lowerPrefix,
        )
      ) {
        return true;
      }
    }

    if (CLITIC_ME_TE_SET.has(lowerSuffix)) {
      if (NON_CLITIC_OBJ_WORDS.has(combined)) return false;
      if (lowerPrefix.length >= 2 && /^(?:dá|vê|foi|deu|fez|diz|faz|dei|ver|dar|ter|pôr)$/.test(lowerPrefix)) {
        return true;
      }
      if (
        lowerPrefix.length >= 3 &&
        /(?:[aei]r|pôr|[aeio]u|[aeéê]m|ão|õe|ia|va|ra|sse|ndo|mos|ei|[iaeu]z|nha|ói)$/.test(lowerPrefix)
      ) {
        return true;
      }
    }

    if (CLITIC_NOS_VOS_SET.has(lowerSuffix)) {
      if (NON_CLITIC_OBJ_WORDS.has(combined)) return false;
      if (lowerSuffix === 'nos' && lowerPrefix.length >= 4 && /mo$/.test(lowerPrefix)) return true;
      if (
        lowerPrefix.length >= 3 &&
        /(?:[aei]r|pôr|[aeio]u|[aeéê]m|ão|õe|va|sse|ndo|mos|[iaeu]z|nha|dá|vê)$/.test(lowerPrefix)
      ) {
        return true;
      }
    }
  }

  return false;
}

/** Junta duas listas de spans (linha anterior + próxima linha), aplicando desifenização. */
function appendLineSpans(acc: TextSpan[], nextSpans: TextSpan[]): void {
  if (nextSpans.length === 0) return;
  if (acc.length === 0) {
    for (const sp of nextSpans) acc.push({ ...sp });
    return;
  }

  const prevText = acc.map((s) => s.s).join('');
  const nextText = nextSpans.map((s) => s.s).join('');

  // Caso 1: soft hyphen (\u00AD) no fim da linha anterior -> sempre remove e junta.
  if (prevText.endsWith('\u00AD')) {
    removeTrailingChar(acc);
    for (const sp of nextSpans) acc.push({ ...sp });
    return;
  }

  // Caso 2: hífen após letra + próxima linha começando com letra.
  const prevMatch = prevText.match(/([\p{L}\p{M}]+)[-‐]$/u);
  const nextMatch = nextText.match(/^([\p{L}\p{M}]+)(.*)$/u);
  if (prevMatch && nextMatch) {
    const prefix = prevMatch[1];
    const suffix = nextMatch[1];
    const rest = nextMatch[2];
    const isSuffixWholeWord = rest.length === 0 || /^[\s.,;:!?…"'”’)\]]/.test(rest);

    if (shouldKeepHyphen(prefix, suffix, isSuffixWholeWord)) {
      // Mantém o hífen sem inserir espaço.
      for (const sp of nextSpans) acc.push({ ...sp });
      return;
    }

    // Desifeniza: remove o hífen final e concatena diretamente.
    removeTrailingChar(acc);
    for (const sp of nextSpans) acc.push({ ...sp });
    return;
  }

  // Caso padrão: une com um espaço.
  if (!prevText.endsWith(' ') && !nextText.startsWith(' ')) {
    acc.push({ s: ' ' });
  }
  for (const sp of nextSpans) acc.push({ ...sp });
}

function removeTrailingChar(spans: TextSpan[]): void {
  while (spans.length > 0) {
    const last = spans[spans.length - 1];
    if (last.s.length > 0) {
      last.s = last.s.slice(0, -1);
      if (last.s.length === 0) spans.pop();
      return;
    }
    spans.pop();
  }
}

/** Finaliza spans em { text, runs? }, omitindo runs se o bloco não tiver estilos. */
function finalizeSpans(rawSpans: TextSpan[]): { text: string; runs?: Run[] } {
  const cleaned: TextSpan[] = [];
  for (const sp of rawSpans) {
    const s = stripSoftHyphens(sp.s).replace(/ {2,}/g, ' ');
    if (s.length === 0) continue;
    const item: TextSpan = { s };
    if (sp.b) item.b = 1;
    if (sp.i) item.i = 1;
    if (sp.sup) item.sup = 1;
    cleaned.push(item);
  }
  const trimmed = trimSpans(cleaned);
  const text = trimmed.map((r) => r.s).join('');
  const hasStyle = trimmed.some((r) => r.b === 1 || r.i === 1 || r.sup === 1);
  if (!hasStyle) return { text };
  return { text, runs: trimmed };
}

/** Remove prefixo de marcador de lista (N caracteres) preservando os estilos dos spans. */
function sliceSpansPrefix(spans: TextSpan[], prefixLen: number): TextSpan[] {
  let rem = prefixLen;
  const out: TextSpan[] = [];
  for (const sp of spans) {
    if (rem <= 0) {
      out.push({ ...sp });
    } else if (sp.s.length <= rem) {
      rem -= sp.s.length;
    } else {
      const rest = sp.s.slice(rem);
      rem = 0;
      if (rest.length > 0) out.push({ ...sp, s: rest });
    }
  }
  return trimSpans(out);
}

const EXPLICIT_UNORDERED_LIST_RE = /^[•●▪◦‣⁃■□◆◇▸▹►❖➢➤]\s+(?=\S)/;
const DASH_LIST_RE = /^([-–])\s+(?=\S)/;
const DIALOGUE_DASH_START_RE = /^[-–—]\s+(?=\S)/;
const ORDERED_LIST_RE = /^((?:\d{1,3}[.)]|[a-zA-Z]\)))\s+(?=\S)/;
const TERMINAL_PUNCT_RE = /[.!?…:][”"'’»)\]]*$/;

const DIALOGUE_SPEECH_VERB_RE =
  /(?:,|—|–|[?!])\s*(?:disse|perguntou|respondeu|falou|gritou|sussurrou|murmurou|exclamou|retorquiu|replicou|indagou|comentou|observou|explicou|acrescentou|continuou|concluiu|insistiu|pediu|avisou|interrompeu|sorriu|suspirou|riu|pensou|retrucou|ponderou|balbuciou|resmungou|berrou|chamou)\b/iu;

function detectExplicitListMarker(text: string): { ordered: boolean; prefixLen: number } | null {
  const clean = stripSoftHyphens(text);
  const unord = clean.match(EXPLICIT_UNORDERED_LIST_RE);
  if (unord) return { ordered: false, prefixLen: unord[0].length };

  const ord = clean.match(ORDERED_LIST_RE);
  if (ord) {
    // Evita anos ou números absurdos como marcador de lista.
    const numMatch = ord[1].match(/^(\d+)/);
    if (numMatch && Number(numMatch[1]) > 200) return null;
    return { ordered: true, prefixLen: ord[0].length };
  }
  return null;
}

function detectDashMarker(text: string): { char: '-' | '–'; prefixLen: number } | null {
  const clean = stripSoftHyphens(text);
  const m = clean.match(DASH_LIST_RE);
  if (!m) return null;
  return { char: m[1] as '-' | '–', prefixLen: m[0].length };
}

function detectListMarker(text: string): { ordered: boolean; prefixLen: number } | null {
  const explicit = detectExplicitListMarker(text);
  if (explicit) return explicit;
  const dash = detectDashMarker(text);
  if (dash) return { ordered: false, prefixLen: dash.prefixLen };
  return null;
}

/**
 * Decide quais linhas iniciadas por "-" ou "–" são realmente itens de lista (vs. falas de diálogo).
 * Retorna mapa índice da linha -> comprimento do prefixo de marcador a remover.
 */
function classifyDashListLines(
  lines: LayoutLine[],
  colBaseMap: Map<number, number>,
  bodyFontSize: number,
  normalStep: number,
  classifyHeading: (line: LayoutLine) => 1 | 2 | 3 | null,
): Map<number, number> {
  const listDashPrefixes = new Map<number, number>();
  if (lines.length === 0) return listDashPrefixes;

  interface DashEntry {
    startIdx: number;
    endIdx: number;
    column: number;
    x: number;
    dashChar: '-' | '–';
    prefixLen: number;
    hangingIndent: boolean;
    hasDialogueSignals: boolean;
    endsWithPeriod: boolean;
  }

  const lineKind: Array<'heading' | 'explicit' | 'ordered' | 'dash' | 'text'> = new Array(lines.length);
  const dashMeta = new Map<number, { char: '-' | '–'; prefixLen: number }>();

  for (let i = 0; i < lines.length; i++) {
    if (classifyHeading(lines[i]) !== null) {
      lineKind[i] = 'heading';
      continue;
    }
    const explicit = detectExplicitListMarker(lines[i].text);
    if (explicit) {
      lineKind[i] = explicit.ordered ? 'ordered' : 'explicit';
      continue;
    }
    const dash = detectDashMarker(lines[i].text);
    if (dash) {
      lineKind[i] = 'dash';
      dashMeta.set(i, dash);
      continue;
    }
    lineKind[i] = 'text';
  }

  const entries: DashEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lineKind[i] !== 'dash') continue;
    const meta = dashMeta.get(i)!;
    const firstLine = lines[i];
    const colBaseX = colBaseMap.get(firstLine.column) ?? firstLine.colLeft;
    const colWidth = Math.max(1, firstLine.colRight - colBaseX);
    let endIdx = i;
    let hangingIndent = false;
    let wrapLeft = false;
    const parts: string[] = [stripSoftHyphens(firstLine.text).slice(meta.prefixLen)];

    // Agrega linhas de continuação imediatas desta entrada na mesma coluna.
    while (endIdx + 1 < lines.length) {
      const nextIdx = endIdx + 1;
      if (lineKind[nextIdx] !== 'text') break;
      const prevLn = lines[endIdx];
      const nextLn = lines[nextIdx];
      if (nextLn.column !== firstLine.column) break;
      if (DIALOGUE_DASH_START_RE.test(stripSoftHyphens(nextLn.text).trim())) break;

      const vStep = nextLn.yTop - prevLn.yTop;
      if (vStep > normalStep * 1.32 && vStep > Math.max(prevLn.fontSize, nextLn.fontSize) * 1.5) break;

      const prevClean = stripSoftHyphens(prevLn.text).trim();
      const prevWidth = prevLn.xEnd - prevLn.x;
      const prevRightGap = prevLn.colRight - prevLn.xEnd;
      const prevIsShort =
        prevRightGap >= Math.max(prevLn.fontSize * 2.5, colWidth * 0.15) || prevWidth < colWidth * 0.82;
      if (prevIsShort && TERMINAL_PUNCT_RE.test(prevClean)) break;

      if (nextLn.x >= firstLine.x + firstLine.fontSize * 0.4) hangingIndent = true;
      if (nextLn.x < firstLine.x - 4) wrapLeft = true;
      parts.push(stripSoftHyphens(nextLn.text).trim());
      endIdx = nextIdx;
    }

    const body = parts.join(' ').trim();
    const hasDialogueSignals =
      wrapLeft ||
      /\s[–—]\s/.test(body) ||
      DIALOGUE_SPEECH_VERB_RE.test(body) ||
      /[?!…][”"'’»)\]]*$/.test(body);
    const endsWithPeriod = /\.[”"'’»)\]]*$/.test(body);

    entries.push({
      startIdx: i,
      endIdx,
      column: firstLine.column,
      x: firstLine.x,
      dashChar: meta.char,
      prefixLen: meta.prefixLen,
      hangingIndent,
      hasDialogueSignals,
      endsWithPeriod,
    });
  }

  const xTol = Math.max(6, bodyFontSize * 0.6);

  const isAdjacentExplicitBullet = (e: DashEntry): boolean => {
    const prevIdx = e.startIdx - 1;
    if (prevIdx >= 0 && lineKind[prevIdx] === 'explicit' && lines[prevIdx].column === e.column) {
      if (Math.abs(lines[prevIdx].x - e.x) <= xTol) return true;
    }
    const nextIdx = e.endIdx + 1;
    if (nextIdx < lines.length && lineKind[nextIdx] === 'explicit' && lines[nextIdx].column === e.column) {
      if (Math.abs(lines[nextIdx].x - e.x) <= xTol) return true;
    }
    return false;
  };

  // Avalia grupos contíguos de entradas com o mesmo marcador de traço e alinhamento.
  let gStart = 0;
  while (gStart < entries.length) {
    let gEnd = gStart;
    while (gEnd + 1 < entries.length) {
      const curr = entries[gEnd];
      const next = entries[gEnd + 1];
      if (
        next.startIdx === curr.endIdx + 1 &&
        next.column === curr.column &&
        next.dashChar === curr.dashChar &&
        Math.abs(next.x - curr.x) <= xTol
      ) {
        gEnd++;
      } else {
        break;
      }
    }

    const group = entries.slice(gStart, gEnd + 1);
    const anyDialogue = group.some((e) => e.hasDialogueSignals);
    const anyHanging = group.some((e) => e.hangingIndent);
    const anyAdjExplicit = group.some((e) => isAdjacentExplicitBullet(e));
    const dashChar = group[0].dashChar;

    let isListGroup = false;
    if (!anyDialogue) {
      if (anyAdjExplicit || anyHanging) {
        isListGroup = true;
      } else if (group.length >= 2) {
        if (dashChar === '-') {
          isListGroup = true;
        } else {
          // En-dash ("–") em português é travessão de diálogo; só vira lista quando os itens
          // parecem tópicos curtos sem cara de falas encerradas por ponto.
          const nonPeriodCount = group.filter((e) => !e.endsWithPeriod).length;
          if (nonPeriodCount > 0 && nonPeriodCount >= Math.ceil(group.length / 2)) {
            isListGroup = true;
          }
        }
      }
    }

    if (isListGroup) {
      for (const e of group) {
        listDashPrefixes.set(e.startIdx, e.prefixLen);
      }
    }

    gStart = gEnd + 1;
  }

  return listDashPrefixes;
}

/** Mapeia tamanhos de fonte de título (>= 1.18x corpo) para níveis 1, 2 ou 3. */
function buildHeadingLevelMap(allLines: LayoutLine[], bodyFontSize: number): (line: LayoutLine) => 1 | 2 | 3 | null {
  const minHeadingSize = bodyFontSize * 1.18;
  const sizeBuckets: number[] = [];

  for (const ln of allLines) {
    const clean = stripSoftHyphens(ln.text).trim();
    if (clean.length === 0 || clean.length > MAX_HEADING_LENGTH) continue;
    if (ln.fontSize < minHeadingSize) continue;
    if (detectListMarker(clean)) continue;
    if (/^\d+$/.test(clean)) continue;

    // Agrupa tamanhos dentro de ±0.8pt no mesmo patamar.
    const rounded = Math.round(ln.fontSize * 2) / 2;
    if (!sizeBuckets.some((s) => Math.abs(s - rounded) <= 0.8)) {
      sizeBuckets.push(rounded);
    }
  }

  sizeBuckets.sort((a, b) => b - a); // Maior -> nível 1

  return (ln: LayoutLine): 1 | 2 | 3 | null => {
    const clean = stripSoftHyphens(ln.text).trim();
    if (clean.length === 0 || clean.length > MAX_HEADING_LENGTH) return null;
    if (ln.fontSize < minHeadingSize) return null;
    if (detectListMarker(clean)) return null;
    if (/^\d+$/.test(clean)) return null;

    let bestIdx = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < sizeBuckets.length; i++) {
      const diff = Math.abs(ln.fontSize - sizeBuckets[i]);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = i;
      }
    }
    const lvl = Math.min(3, bestIdx + 1);
    return lvl as 1 | 2 | 3;
  };
}

/** Estima o espaçamento vertical normal entre linhas do corpo. */
function estimateNormalLineStep(pagesLines: LayoutLine[][], bodyFontSize: number): number {
  const steps: number[] = [];
  for (const lines of pagesLines) {
    for (let i = 1; i < lines.length; i++) {
      const prev = lines[i - 1];
      const curr = lines[i];
      if (prev.column !== curr.column) continue;
      if (Math.abs(prev.fontSize - bodyFontSize) > bodyFontSize * 0.2) continue;
      if (Math.abs(curr.fontSize - bodyFontSize) > bodyFontSize * 0.2) continue;
      const step = curr.yTop - prev.yTop;
      if (step >= bodyFontSize * 0.8 && step <= bodyFontSize * 2.5) {
        steps.push(step);
      }
    }
  }
  return median(steps, bodyFontSize * 1.35);
}

/** Estima a margem esquerda base por (página, coluna) para detectar recuos de primeira linha. */
function computeColumnBaseLeft(lines: LayoutLine[], bodyFontSize: number): Map<number, number> {
  const byCol = new Map<number, number[]>();
  for (const ln of lines) {
    if (Math.abs(ln.fontSize - bodyFontSize) > bodyFontSize * 0.25) continue;
    let arr = byCol.get(ln.column);
    if (!arr) {
      arr = [];
      byCol.set(ln.column, arr);
    }
    arr.push(ln.x);
  }
  const result = new Map<number, number>();
  for (const [col, xs] of byCol) {
    result.set(col, percentile(xs, 0.2, xs[0]));
  }
  return result;
}

/** Converte páginas de linhas em blocos (títulos, parágrafos, listas e imagens isoladas). */
function buildBlocks(
  pages: PdfPageInput[],
  pagesLines: LayoutLine[][],
  bodyFontSize: number,
  normalStep: number,
  outlineBreakPages: Set<number>,
): TaggedBlock[] {
  const allLines = pagesLines.flat();
  const classifyHeading = buildHeadingLevelMap(allLines, bodyFontSize);

  const blocks: TaggedBlock[] = [];

  // Estado do bloco textual em construção (p ou li).
  let currentKind: 'p' | 'li' | null = null;
  let currentOrdered = false;
  let currentSpans: TextSpan[] = [];
  let currentStartPage = 1;
  let prevLine: LayoutLine | null = null;
  let prevColBaseX = 0;

  const flushCurrent = () => {
    if (!currentKind || currentSpans.length === 0) {
      currentKind = null;
      currentSpans = [];
      return;
    }
    const { text, runs } = finalizeSpans(currentSpans);
    if (text.length > 0) {
      if (currentKind === 'li') {
        const blk: Block = {
          t: 'li',
          text,
          ...(runs ? { runs } : {}),
          ...(currentOrdered ? { ordered: true } : {}),
        };
        blocks.push({ block: blk, pageNumber: currentStartPage });
      } else {
        const blk: Block = {
          t: 'p',
          text,
          ...(runs ? { runs } : {}),
        };
        blocks.push({ block: blk, pageNumber: currentStartPage });
      }
    }
    currentKind = null;
    currentOrdered = false;
    currentSpans = [];
  };

  for (let pi = 0; pi < pages.length; pi++) {
    const page = pages[pi];
    const lines = pagesLines[pi];

    // Uma página de destino do sumário sempre inicia bloco novo para permitir corte exato de capítulo.
    if (outlineBreakPages.has(page.pageNumber)) {
      flushCurrent();
      prevLine = null;
    }

    // Página isolada sem texto com imagem de fallback (ex.: figura de página inteira).
    if (lines.length === 0) {
      if (page.fallbackImage) {
        flushCurrent();
        prevLine = null;
        blocks.push({
          block: {
            t: 'img',
            src: page.fallbackImage.src,
            alt: page.fallbackImage.alt ?? `Página ${page.pageNumber}`,
            w: page.fallbackImage.w,
            h: page.fallbackImage.h,
          },
          pageNumber: page.pageNumber,
        });
      }
      continue;
    }

    const colBaseMap = computeColumnBaseLeft(lines, bodyFontSize);
    const dashListLines = classifyDashListLines(lines, colBaseMap, bodyFontSize, normalStep, classifyHeading);

    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const colBaseX = colBaseMap.get(line.column) ?? line.colLeft;
      const colWidth = Math.max(1, line.colRight - colBaseX);

      // 1. Título detectado pela fonte.
      const headingLevel = classifyHeading(line);
      if (headingLevel !== null) {
        flushCurrent();
        let headingText = stripSoftHyphens(line.text).trim();
        let lastHeadingLine = line;

        // Junta linhas consecutivas do mesmo título se continuarem curtas.
        while (li + 1 < lines.length) {
          const next = lines[li + 1];
          if (next.column !== line.column) break;
          if (classifyHeading(next) !== headingLevel) break;
          if (Math.abs(next.fontSize - line.fontSize) > 1.2) break;
          const vGap = next.yTop - lastHeadingLine.yTop;
          if (vGap < 0 || vGap > line.fontSize * 1.9) break;
          const nextClean = stripSoftHyphens(next.text).trim();
          const joined = `${headingText} ${nextClean}`;
          if (joined.length > MAX_HEADING_LENGTH) break;
          headingText = joined;
          lastHeadingLine = next;
          li++;
        }

        blocks.push({
          block: { t: 'h', level: headingLevel, text: headingText },
          pageNumber: page.pageNumber,
        });
        prevLine = null;
        continue;
      }

      // 2. Item de lista (marcador explícito/ordenado ou traço confirmado como lista).
      const explicitList = detectExplicitListMarker(line.text);
      const dashPrefixLen = explicitList ? undefined : dashListLines.get(li);
      const listInfo =
        explicitList ?? (dashPrefixLen !== undefined ? { ordered: false, prefixLen: dashPrefixLen } : null);
      if (listInfo) {
        flushCurrent();
        currentKind = 'li';
        currentOrdered = listInfo.ordered;
        currentStartPage = page.pageNumber;
        currentSpans = sliceSpansPrefix(line.spans, listInfo.prefixLen);
        prevLine = line;
        prevColBaseX = colBaseX;
        continue;
      }

      // 3. Linha de texto comum: decide se continua o bloco anterior ou inicia novo parágrafo.
      let startNewParagraph = currentKind === null;

      if (!startNewParagraph && prevLine) {
        const samePage = prevLine.pageNumber === line.pageNumber;
        const sameColumn = samePage && prevLine.column === line.column;
        const prevClean = stripSoftHyphens(prevLine.text).trim();
        const currClean = stripSoftHyphens(line.text).trim();
        const prevEndsHyphen =
          prevLine.text.endsWith('\u00AD') || /[\p{L}\p{M}][-‐]$/u.test(prevClean);
        const prevEndsTerminal = TERMINAL_PUNCT_RE.test(prevClean);

        // Falas iniciadas por travessão/hífen abrem parágrafo próprio mantendo o travessão.
        const startsDialogue =
          DIALOGUE_DASH_START_RE.test(currClean) &&
          (prevEndsTerminal || /^[-–—]\s+[\p{Lu}"'«“¿¡…]/u.test(currClean));

        const currIndent = line.x - colBaseX;
        const hasFirstLineIndent =
          currIndent >= Math.max(8, line.fontSize * 0.75) &&
          currIndent <= colWidth * 0.35 &&
          // Em continuação de item de lista (recuo deslocado), o alinhamento segue o texto do item.
          !(currentKind === 'li' && Math.abs(line.x - prevLine.x) <= line.fontSize * 1.8);

        const prevWidth = prevLine.xEnd - prevLine.x;
        const prevColWidth = Math.max(1, prevLine.colRight - prevColBaseX);
        const prevRightMarginGap = prevLine.colRight - prevLine.xEnd;
        const prevIsShort =
          prevRightMarginGap >= Math.max(prevLine.fontSize * 2.5, prevColWidth * 0.15) ||
          prevWidth < prevColWidth * 0.82;

        if (startsDialogue) {
          startNewParagraph = true;
        } else if (sameColumn) {
          const vStep = line.yTop - prevLine.yTop;
          const hasLargeGap = vStep > normalStep * 1.32 && vStep > Math.max(prevLine.fontSize, line.fontSize) * 1.5;

          if (hasLargeGap) {
            startNewParagraph = true;
          } else if (hasFirstLineIndent && !prevEndsHyphen) {
            // Evita falso positivo se a linha anterior também tinha exatamente o mesmo recuo
            // (ex.: bloco citado ou recuado) e não terminou em pontuação final.
            const sameIndentBlock = Math.abs(line.x - prevLine.x) <= 2.5;
            if (!sameIndentBlock || prevEndsTerminal) {
              startNewParagraph = true;
            }
          } else if (prevIsShort && prevEndsTerminal && !prevEndsHyphen) {
            startNewParagraph = true;
          }
        } else {
          // Mudança de coluna ou de página: mantém contínuo se a frase foi interrompida no meio ou hifenizada.
          if (prevEndsHyphen) {
            startNewParagraph = false;
          } else if (hasFirstLineIndent || prevEndsTerminal) {
            startNewParagraph = true;
          }
        }
      }

      if (startNewParagraph) {
        flushCurrent();
        currentKind = 'p';
        currentOrdered = false;
        currentStartPage = page.pageNumber;
        currentSpans = line.spans.map((s) => ({ ...s }));
      } else {
        appendLineSpans(currentSpans, line.spans);
      }

      prevLine = line;
      prevColBaseX = colBaseX;
    }

    // Página de texto com figura grande: a imagem da página vem depois do texto dela.
    if (page.fallbackImage) {
      flushCurrent();
      prevLine = null;
      blocks.push({
        block: {
          t: 'img',
          src: page.fallbackImage.src,
          alt: page.fallbackImage.alt ?? `Página ${page.pageNumber}`,
          w: page.fallbackImage.w,
          h: page.fallbackImage.h,
        },
        pageNumber: page.pageNumber,
      });
    }
  }

  flushCurrent();
  return blocks;
}

function blockCharCount(block: Block): number {
  return 'text' in block ? block.text.length : 0;
}

function normalizeTitleForMatch(title: string): string {
  return normalizePdfText(title)
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim();
}

function matchesOutlineParagraph(blkNorm: string, entryNorm: string): boolean {
  if (!blkNorm || !entryNorm) return false;
  if (blkNorm === entryNorm) return true;
  return (
    blkNorm.startsWith(entryNorm) &&
    blkNorm[entryNorm.length] === ' ' &&
    blkNorm.length <= Math.ceil(entryNorm.length * 1.2)
  );
}

/** Divide blocos em capítulos usando o sumário do PDF (outline). */
/** Separa os runs em negrito do início de um parágrafo (título colado ao corpo) do restante do texto. */
function splitBoldLead(blk: { t: 'p'; text: string; runs?: Run[] }): { title: string; rest: Block } | null {
  const runs = blk.runs;
  if (!runs || runs.length < 2 || !runs[0].b) return null;
  let k = 0;
  while (k < runs.length && runs[k].b) k++;
  const title = runs.slice(0, k).map((r) => r.s).join('').trim();
  const restRuns = runs.slice(k).map((r) => ({ ...r }));
  if (!title || restRuns.length === 0) return null;
  restRuns[0].s = restRuns[0].s.replace(/^\s+/, '');
  const restText = restRuns.map((r) => r.s).join('').trim();
  if (!restText) return null;
  // Sem formatação no restante, o bloco fica sem runs (como os demais parágrafos simples).
  const formatted = restRuns.some((r) => r.b || r.i || r.sup);
  return { title, rest: formatted ? { t: 'p', text: restText, runs: restRuns } : { t: 'p', text: restText } };
}

function splitByOutline(blocks: TaggedBlock[], outline: PdfOutlineEntry[]): Chapter[] {
  const valid = outline
    .map((e) => ({
      title: normalizePdfText(e.title).trim(),
      pageNumber: e.pageNumber,
      level: e.level ?? 0,
    }))
    .filter((e) => e.title.length > 0 && e.pageNumber >= 1);

  if (valid.length === 0) return [];

  // Escolhe o nível raiz do sumário; se houver só 1 raiz (título do livro) e vários filhos, usa os filhos.
  let minLevel = valid[0].level;
  for (const e of valid) if (e.level < minLevel) minLevel = e.level;
  let chosen = valid.filter((e) => e.level === minLevel);
  if (chosen.length === 1) {
    const nextLevel = valid.filter((e) => e.level === minLevel + 1);
    if (nextLevel.length >= 2) chosen = nextLevel;
  }

  chosen.sort((a, b) => a.pageNumber - b.pageNumber);

  interface OutlineCut {
    idx: number;
    title: string;
    entryPage: number;
    blockPage: number;
    promotedHeading?: { level: 1 | 2 | 3; text: string; rest?: Block };
  }

  // Resolve o índice exato do bloco onde cada capítulo do sumário começa.
  const cuts: OutlineCut[] = [];
  let minSearchIdx = 0;

  for (const entry of chosen) {
    const firstOnOrAfter = blocks.findIndex((b, idx) => idx >= minSearchIdx && b.pageNumber >= entry.pageNumber);
    if (firstOnOrAfter === -1) continue;

    // Tenta casar com um título na página de destino (ou na seguinte) para um corte exato.
    const entryNorm = normalizeTitleForMatch(entry.title);
    const entryWithoutMarker = entryNorm.replace(/^(?:\d{1,3}|[a-z])\s+/, '');
    const maxParaLen = Math.max(MAX_HEADING_LENGTH, Math.ceil(entry.title.length * 1.25));
    const entryHeadingLevel = Math.min(3, Math.max(1, entry.level - minLevel + 1)) as 1 | 2 | 3;

    const findMatchOnPage = (
      targetPage: number,
    ): { idx: number; promotedHeading?: { level: 1 | 2 | 3; text: string; rest?: Block } } | null => {
      if (!entryNorm) return null;

      // 1º: bloco `h` correspondente na página.
      for (let i = firstOnOrAfter; i < blocks.length && blocks[i].pageNumber <= targetPage; i++) {
        if (blocks[i].pageNumber !== targetPage) continue;
        const blk = blocks[i].block;
        if (blk.t === 'h') {
          const blkNorm = normalizeTitleForMatch(blk.text);
          if (blkNorm && (blkNorm === entryNorm || blkNorm.includes(entryNorm) || entryNorm.includes(blkNorm))) {
            return { idx: i };
          }
        }
      }

      // 2º: bloco `p` curto (ou `li` numerado cujo prefixo numérico foi removido) com o título da seção.
      for (let i = firstOnOrAfter; i < blocks.length && blocks[i].pageNumber <= targetPage; i++) {
        if (blocks[i].pageNumber !== targetPage) continue;
        const blk = blocks[i].block;
        if (blk.t === 'p') {
          const trimmed = blk.text.trim();
          if (trimmed.length <= maxParaLen && matchesOutlineParagraph(normalizeTitleForMatch(trimmed), entryNorm)) {
            return { idx: i, promotedHeading: { level: entryHeadingLevel, text: trimmed } };
          }
          // Título em negrito colado ao corpo no mesmo parágrafo: o trecho em negrito inicial vira o título.
          const lead = splitBoldLead(blk);
          if (lead && matchesOutlineParagraph(normalizeTitleForMatch(lead.title), entryNorm)) {
            return { idx: i, promotedHeading: { level: entryHeadingLevel, text: lead.title, rest: lead.rest } };
          }
        } else if (blk.t === 'li' && blk.ordered && entryWithoutMarker !== entryNorm && entryWithoutMarker.length >= 3) {
          const trimmed = blk.text.trim();
          if (trimmed.length > maxParaLen) continue;
          const blkNorm = normalizeTitleForMatch(trimmed);
          if (matchesOutlineParagraph(blkNorm, entryWithoutMarker)) {
            return { idx: i, promotedHeading: { level: entryHeadingLevel, text: entry.title } };
          }
        }
      }

      return null;
    };

    const match = findMatchOnPage(entry.pageNumber) ?? findMatchOnPage(entry.pageNumber + 1);
    const cutIdx = match ? match.idx : firstOnOrAfter;
    const matchedBlock = match !== null;
    const promotedHeading = match?.promotedHeading;

    const lastCut = cuts.length > 0 ? cuts[cuts.length - 1] : null;
    if (lastCut) {
      if (lastCut.idx === cutIdx) continue;
      // Duas entradas do sumário na mesma página sem correspondência (`h` ou `p`): ignora a duplicata
      // para não fatiar após um único bloco nem deslocar o corte para a página seguinte.
      if (!matchedBlock && (lastCut.entryPage === entry.pageNumber || lastCut.blockPage >= entry.pageNumber)) {
        continue;
      }
    }

    cuts.push({
      idx: cutIdx,
      title: entry.title,
      entryPage: entry.pageNumber,
      blockPage: blocks[cutIdx].pageNumber,
      ...(promotedHeading ? { promotedHeading } : {}),
    });
    minSearchIdx = cutIdx + 1;
  }

  if (cuts.length === 0) return [];

  const chapters: Chapter[] = [];

  // Blocos anteriores ao primeiro capítulo do sumário (folha de rosto, prefácio, etc.).
  if (cuts[0].idx > 0) {
    const preBlocks = blocks.slice(0, cuts[0].idx);
    const firstHeading = preBlocks.find((b) => b.block.t === 'h');
    const preTitle =
      firstHeading && firstHeading.block.t === 'h'
        ? firstHeading.block.text
        : formatPageRangeTitle(preBlocks[0].pageNumber, preBlocks[preBlocks.length - 1].pageNumber);
    chapters.push({ title: preTitle, blocks: preBlocks.map((b) => b.block) });
  }

  for (let i = 0; i < cuts.length; i++) {
    const start = cuts[i].idx;
    const end = i + 1 < cuts.length ? cuts[i + 1].idx : blocks.length;
    const slice = blocks.slice(start, end).map((b) => b.block);
    if (slice.length === 0) continue;
    const promoted = cuts[i].promotedHeading;
    if (promoted) {
      slice[0] = { t: 'h', level: promoted.level, text: promoted.text };
      if (promoted.rest) slice.splice(1, 0, promoted.rest);
    }
    chapters.push({ title: cuts[i].title, blocks: slice });
  }

  return chapters;
}

function formatPageRangeTitle(startPage: number, endPage: number): string {
  if (startPage === endPage) return `Página ${startPage}`;
  return `Páginas ${startPage}–${endPage}`;
}

/** Capítulo de texto (sem imagens) com menos caracteres que isto é "minúsculo". */
const MIN_HEADING_CHAPTER_CHARS = 300;
/** Uma sequência com pelo menos esta quantidade de capítulos minúsculos seguidos é lixo de layout. */
const MIN_TINY_RUN = 3;

/**
 * Pranchas técnicas, folhas de rosto e legendas soltas têm letras grandes que parecem títulos e
 * geravam dezenas de "capítulos" de poucos caracteres ("F", "E", "4 3"). Uma sequência de 3 ou mais
 * capítulos minúsculos seguidos é anexada ao capítulo anterior (ou ao seguinte, se estiver no
 * início); os blocos continuam no livro. Capítulos curtos isolados (dedicatória, epígrafe) ficam.
 */
function mergeTinyChapters(chapters: Chapter[]): Chapter[] {
  const isTiny = (ch: Chapter) =>
    !ch.blocks.some((b) => b.t === 'img') && ch.blocks.reduce((n, b) => n + blockCharCount(b), 0) < MIN_HEADING_CHAPTER_CHARS;
  const out: Chapter[] = [];
  let carry: Block[] = []; // blocos de uma sequência no início, que vão para o próximo capítulo
  let i = 0;
  while (i < chapters.length) {
    let j = i;
    while (j < chapters.length && isTiny(chapters[j])) j++;
    if (j - i >= MIN_TINY_RUN) {
      const blocks = chapters.slice(i, j).flatMap((c) => c.blocks);
      const last = out[out.length - 1];
      if (last) last.blocks.push(...blocks);
      else carry = blocks;
      i = j;
      continue;
    }
    const ch = chapters[i];
    if (carry.length > 0) {
      ch.blocks = [...carry, ...ch.blocks];
      carry = [];
    }
    out.push(ch);
    i++;
  }
  if (carry.length > 0) out.push({ title: chapters[0].title, blocks: carry }); // só havia lixo: um capítulo
  return out;
}

/** Divide blocos em capítulos pelos títulos detectados (nível 1 ou maior nível existente). */
function splitByHeadings(blocks: TaggedBlock[]): Chapter[] {
  let minLevel: 1 | 2 | 3 | null = null;
  let level1Count = 0;
  let level2Count = 0;
  let firstLevel1Idx = -1;

  for (let i = 0; i < blocks.length; i++) {
    const blk = blocks[i].block;
    if (blk.t !== 'h') continue;
    if (minLevel === null || blk.level < minLevel) minLevel = blk.level;
    if (blk.level === 1) {
      level1Count++;
      if (firstLevel1Idx === -1) firstLevel1Idx = i;
    } else if (blk.level === 2) {
      level2Count++;
    }
  }

  if (minLevel === null) return [];

  // Se houver apenas 1 título nível 1 logo no início (título do livro) e vários nível 2, corta também nos nível 2.
  const splitMaxLevel: 1 | 2 | 3 =
    minLevel === 1 && level1Count === 1 && firstLevel1Idx <= 4 && level2Count >= 2 ? 2 : minLevel;

  const chapters: Chapter[] = [];
  let currentTitle: string | null = null;
  let currentBlocks: TaggedBlock[] = [];

  const flush = () => {
    if (currentBlocks.length === 0) return;
    const title =
      currentTitle ??
      formatPageRangeTitle(currentBlocks[0].pageNumber, currentBlocks[currentBlocks.length - 1].pageNumber);
    chapters.push({ title, blocks: currentBlocks.map((b) => b.block) });
    currentBlocks = [];
  };

  for (const item of blocks) {
    if (item.block.t === 'h' && item.block.level <= splitMaxLevel) {
      flush();
      currentTitle = item.block.text;
      currentBlocks = [item];
    } else {
      currentBlocks.push(item);
    }
  }
  flush();

  return mergeTinyChapters(chapters);
}

/** Divide blocos em capítulos fixos de ~N páginas quando não há títulos nem sumário. */
function splitByPageChunks(blocks: TaggedBlock[], totalPages: number, pagesPerChapter: number): Chapter[] {
  if (blocks.length === 0) return [];
  const step = Math.max(1, pagesPerChapter);
  const maxPage = Math.max(totalPages, blocks[blocks.length - 1].pageNumber);
  const chapters: Chapter[] = [];

  for (let start = 1; start <= maxPage; start += step) {
    const end = Math.min(maxPage, start + step - 1);
    const slice = blocks.filter((b) => b.pageNumber >= start && b.pageNumber <= end).map((b) => b.block);
    if (slice.length === 0) continue;
    chapters.push({
      title: formatPageRangeTitle(start, end),
      blocks: slice,
    });
  }

  return chapters;
}

/** Quebra um parágrafo excepcionalmente gigante (> maxChars) em pedaços menores. */
function splitOversizedBlock(blk: Block, maxChars: number): Block[] {
  if (blk.t !== 'p' || blk.text.length <= maxChars) return [blk];
  const pieces: Block[] = [];
  let offset = 0;
  const text = blk.text;
  while (offset < text.length) {
    if (text.length - offset <= maxChars) {
      pieces.push({ t: 'p', text: text.slice(offset).trim() });
      break;
    }
    const end = offset + maxChars;
    let cut = text.lastIndexOf('. ', end);
    if (cut <= offset + maxChars * 0.5) cut = text.lastIndexOf(' ', end);
    if (cut <= offset) cut = end;
    else cut += 1;
    const chunk = text.slice(offset, cut).trim();
    if (chunk.length > 0) pieces.push({ t: 'p', text: chunk });
    offset = cut;
  }
  return pieces.length > 0 ? pieces : [blk];
}

/** Garante que nenhum capítulo exceda `maxChars` caracteres, dividindo em "(cont.)". */
function enforceChapterCharLimit(chapters: Chapter[], maxChars: number): Chapter[] {
  if (maxChars <= 0) return chapters;
  const out: Chapter[] = [];

  for (const ch of chapters) {
    let total = 0;
    for (const blk of ch.blocks) total += blockCharCount(blk);
    if (total <= maxChars) {
      out.push(ch);
      continue;
    }

    const flatBlocks: Block[] = [];
    for (const blk of ch.blocks) {
      if (blockCharCount(blk) > maxChars) {
        flatBlocks.push(...splitOversizedBlock(blk, maxChars));
      } else {
        flatBlocks.push(blk);
      }
    }

    const parts: Block[][] = [];
    let part: Block[] = [];
    let partChars = 0;

    for (const blk of flatBlocks) {
      const len = blockCharCount(blk);
      if (part.length > 0 && partChars + len > maxChars) {
        parts.push(part);
        part = [];
        partChars = 0;
      }
      part.push(blk);
      partChars += len;
    }
    if (part.length > 0) parts.push(part);

    for (let i = 0; i < parts.length; i++) {
      const title =
        i === 0
          ? ch.title
          : i === 1
            ? `${ch.title} (cont.)`
            : `${ch.title} (${i + 1}) (cont.)`;
      out.push({ title, blocks: parts[i] });
    }
  }

  return out;
}

interface LayoutAnalysis {
  taggedBlocks: ReturnType<typeof buildBlocks>;
}

/** Passos 1 a 4: linhas, corpo, remoção de cabeçalho/rodapé e blocos etiquetados por página. */
function analyzeLayout(pages: PdfPageInput[], options: PdfLayoutOptions): LayoutAnalysis {
  const yOrigin = options.yOrigin ?? 'pdf';

  // 1. Extrai linhas de cada página (com detecção de 2 colunas).
  const rawPagesLines = pages.map((p) => extractPageLines(p, yOrigin));

  // 2. Mediana do tamanho da fonte do corpo (ponderada por quantidade de caracteres).
  const fontWeights: Array<{ value: number; weight: number }> = [];
  for (const lines of rawPagesLines) {
    for (const ln of lines) {
      const len = stripSoftHyphens(ln.text).trim().length;
      if (len > 0) fontWeights.push({ value: Math.round(ln.fontSize * 2) / 2, weight: len });
    }
  }
  const bodyFontSize = weightedMedian(fontWeights, 12);

  // 3. Remove cabeçalhos/rodapés repetidos e números de página isolados.
  const preliminaryStep = estimateNormalLineStep(rawPagesLines, bodyFontSize);
  const cleanPagesLines = stripHeadersFootersAndPageNumbers(rawPagesLines, bodyFontSize, preliminaryStep);

  // 4. Calcula espaçamento normal entre linhas do corpo e reconstrói blocos.
  const normalStep = estimateNormalLineStep(cleanPagesLines, bodyFontSize);
  const outlineBreakPages = new Set<number>();
  if (options.outline) {
    for (const entry of options.outline) {
      if (entry.pageNumber >= 1) outlineBreakPages.add(entry.pageNumber);
    }
  }
  return { taggedBlocks: buildBlocks(pages, cleanPagesLines, bodyFontSize, normalStep, outlineBreakPages) };
}

/**
 * Reconstrói os blocos de cada página (mesma limpeza de `extractPdfChapters`), sem dividir em capítulos.
 * Usado pelo modo "apresentação", em que cada página vira um slide.
 */
export function extractPdfPageBlocks(
  pages: PdfPageInput[],
  options: PdfLayoutOptions = {},
): Array<{ pageNumber: number; blocks: Block[] }> {
  if (pages.length === 0) return [];
  const { taggedBlocks } = analyzeLayout(pages, options);
  const byPage = new Map<number, Block[]>();
  for (const tb of taggedBlocks) {
    let list = byPage.get(tb.pageNumber);
    if (!list) {
      list = [];
      byPage.set(tb.pageNumber, list);
    }
    list.push(tb.block);
  }
  return pages.map((p) => ({ pageNumber: p.pageNumber, blocks: byPage.get(p.pageNumber) ?? [] }));
}

/**
 * Converte páginas extraídas de um PDF em capítulos refluíveis (`Chapter[]`).
 */
export function extractPdfChapters(pages: PdfPageInput[], options: PdfLayoutOptions = {}): Chapter[] {
  if (pages.length === 0) return [];

  const maxChapterChars = options.maxChapterChars ?? DEFAULT_MAX_CHAPTER_CHARS;
  const pagesPerChapter = options.pagesPerChapter ?? DEFAULT_PAGES_PER_CHAPTER;

  const { taggedBlocks } = analyzeLayout(pages, options);
  if (taggedBlocks.length === 0) return [];

  // 5. Divide em capítulos: prioridade para sumário (outline), depois títulos, depois faixas de páginas.
  let chapters: Chapter[] = [];
  if (options.outline && options.outline.length > 0) {
    chapters = splitByOutline(taggedBlocks, options.outline);
  }
  if (chapters.length === 0) {
    chapters = splitByHeadings(taggedBlocks);
  }
  if (chapters.length === 0) {
    chapters = splitByPageChunks(taggedBlocks, pages.length, pagesPerChapter);
  }

  // 6. Limita o tamanho máximo de cada capítulo (~60 mil caracteres).
  return enforceChapterCharLimit(chapters, maxChapterChars);
}
