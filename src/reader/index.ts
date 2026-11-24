// Unidade do leitor paginado (CSS multi-column, navegação por toque/deslize/teclado, HUD, sumário e "Aa").
import '../styles/reader.css';
import { getContent, getMeta, putMeta } from '../db';
import { applyTheme, FONT_STACKS, loadSettings, saveSettings } from '../settings';
import type { ReaderSettings } from '../settings';
import type { BookContent, BookMeta, Bookmark } from '../types';
import { createIcon } from './icons';
import { createSettingsPanel, createTocPanel } from './panels';
import type { SettingsPanelHandle, TocPanelHandle } from './panels';
import {
  calcBlockPage,
  calcBookPercent,
  calcTotalPages,
  clamp,
  clampSettings,
  countChapterWords,
  estimateChapterMinutesLeft,
  extractExcerpt,
  formatRemainingTime,
  fractionToPage,
  percentToTarget,
} from './progress';
import { renderChapterBlocks } from './render';
import type { RenderedChapter } from './render';

const SWIPE_THRESHOLD = 40;
const TAP_SLOP = 10;
const TAP_MAX_MS = 500;
const SAVE_DEBOUNCE_MS = 800;
const RESIZE_DEBOUNCE_MS = 140;

interface ScreenWakeLockSentinel {
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
}

interface NavigatorWithWakeLock {
  wakeLock?: {
    request(type: 'screen'): Promise<ScreenWakeLockSentinel>;
  };
}

type ChapterTarget =
  | { mode: 'start' }
  | { mode: 'end' }
  | { mode: 'block'; block: number }
  | { mode: 'fraction'; fraction: number };

function goBackToLibrary(): void {
  if (history.length > 1 && (!document.referrer || document.referrer.startsWith(location.origin))) {
    history.back();
  } else {
    location.hash = '#/';
  }
}

export function mountReader(root: HTMLElement, bookId: string): () => void {
  let disposed = false;

  const readerEl = document.createElement('div');
  readerEl.className = 'reader';
  root.appendChild(readerEl);

  // Estado inicial: carregando
  const loadingState = document.createElement('div');
  loadingState.className = 'reader-state';
  const spinner = document.createElement('div');
  spinner.className = 'reader-spinner';
  const loadingText = document.createElement('p');
  loadingText.className = 'reader-state-text';
  loadingText.textContent = 'Carregando livro…';
  loadingState.append(spinner, loadingText);
  readerEl.appendChild(loadingState);

  // Recursos para limpeza na desmontagem
  let wakeLock: ScreenWakeLockSentinel | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let renderedChapter: RenderedChapter | null = null;
  let saveTimer: number | null = null;
  let resizeTimer: number | null = null;
  let imageRaf: number | null = null;
  const cleanups: (() => void)[] = [];

  // Estado do livro e paginação
  let meta: BookMeta | null = null;
  let content: BookContent | null = null;
  let settings: ReaderSettings | null = null;
  let resolvedTitles: string[] = [];

  let currentChapter = 0;
  let currentPage = 0;
  let totalPages = 1;
  let currentBlock = 0;
  let chapterWordCount = 0;
  let anchorMode: 'block' | 'end' = 'block';
  let metaDirty = false;
  let hudOpen = false;
  let isScrubbing = false;

  let pageWidth = 320;
  let pageHeight = 560;
  let gap = 40;
  let step = 360;
  let lastMeasuredW = 0;
  let lastMeasuredH = 0;

  // Referências de DOM preenchidas após carregar
  let viewportEl: HTMLDivElement | null = null;
  let columnsEl: HTMLDivElement | null = null;
  let progressLineFillEl: HTMLDivElement | null = null;
  let bookmarkBtn: HTMLButtonElement | null = null;
  let sliderEl: HTMLInputElement | null = null;
  let statusPageEl: HTMLSpanElement | null = null;
  let statusTimeEl: HTMLSpanElement | null = null;
  let tocPanel: TocPanelHandle | null = null;
  let settingsPanel: SettingsPanelHandle | null = null;

  function showMessageState(title: string, description: string): void {
    const state = document.createElement('div');
    state.className = 'reader-state';

    const h = document.createElement('h1');
    h.className = 'reader-state-title';
    h.textContent = title;

    const p = document.createElement('p');
    p.className = 'reader-state-text';
    p.textContent = description;

    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'reader-primary-btn';
    backBtn.textContent = 'Voltar à biblioteca';
    backBtn.addEventListener('click', goBackToLibrary);

    state.append(h, p, backBtn);
    readerEl.replaceChildren(state);
  }

  async function requestWakeLock(): Promise<void> {
    if (disposed || document.visibilityState !== 'visible') return;
    const wl = (navigator as unknown as NavigatorWithWakeLock).wakeLock;
    if (!wl) return;
    try {
      const sentinel = await wl.request('screen');
      if (disposed) {
        sentinel.release().catch(() => {});
        return;
      }
      wakeLock = sentinel;
      sentinel.addEventListener('release', () => {
        if (wakeLock === sentinel) wakeLock = null;
      });
    } catch {
      // Sem suporte ou bloqueado pelo sistema (ex.: economia de bateria)
    }
  }

  function releaseWakeLock(): void {
    const current = wakeLock;
    wakeLock = null;
    if (current) current.release().catch(() => {});
  }

  function flushSave(): void {
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (!meta || !metaDirty) return;
    metaDirty = false;
    const snapshot: BookMeta = {
      ...meta,
      position: { ...meta.position },
      bookmarks: meta.bookmarks.map((b) => ({ ...b })),
    };
    putMeta(snapshot).catch(() => {});
  }

  function scheduleSave(): void {
    if (!meta) return;
    metaDirty = true;
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      flushSave();
    }, SAVE_DEBOUNCE_MS);
  }

  function getChapterTitle(index: number): string {
    return resolvedTitles[index] || `Capítulo ${index + 1}`;
  }

  function getChapterChars(): readonly number[] {
    if (!meta || !content) return [];
    const chars = meta.chapterChars;
    if (chars.length === content.chapters.length) return chars;
    return content.chapters.map((_, i) => chars[i] ?? 0);
  }

  function applySettingsToDom(): void {
    if (!settings || !meta || !viewportEl) return;

    const vw = viewportEl.clientWidth;
    const vh = viewportEl.clientHeight;
    const maxSafeMargin = vw > 0 ? Math.max(0, Math.floor((vw - 120) / 2)) : settings.margin;
    const effectiveMargin = meta.fixedLayout ? 0 : Math.min(settings.margin, maxSafeMargin);

    pageWidth = Math.max(120, Math.floor((vw || window.innerWidth) - effectiveMargin * 2));
    pageHeight = Math.max(120, Math.floor(vh || window.innerHeight - 30));
    gap = effectiveMargin * 2;
    step = pageWidth + gap;
    lastMeasuredW = vw;
    lastMeasuredH = vh;

    readerEl.style.setProperty('--reader-font-size', `${settings.fontSize}px`);
    readerEl.style.setProperty('--reader-line-height', String(settings.lineHeight));
    readerEl.style.setProperty('--reader-margin', `${effectiveMargin}px`);
    readerEl.style.setProperty('--reader-font-family', FONT_STACKS[settings.font]);
    readerEl.style.setProperty('--reader-align', settings.justify ? 'justify' : 'left');
    readerEl.style.setProperty('--reader-hyphens', settings.hyphenate ? 'auto' : 'none');
    readerEl.style.setProperty('--col-w', `${pageWidth}px`);
    readerEl.style.setProperty('--col-h', `${pageHeight}px`);
    readerEl.style.setProperty('--col-gap', `${gap}px`);
  }

  function measureTotalPages(): void {
    if (!columnsEl || !content) {
      totalPages = 1;
      return;
    }
    const ch = content.chapters[currentChapter];
    if (!ch || ch.blocks.length === 0) {
      totalPages = 1;
      return;
    }
    totalPages = calcTotalPages(columnsEl.scrollWidth, pageWidth, gap);
  }

  function findFirstVisibleBlock(): number {
    if (!renderedChapter || !columnsEl) return 0;
    const els = renderedChapter.blockEls;
    if (els.length === 0 || currentPage <= 0) return 0;

    // Busca binária pelo primeiro bloco cujo offsetLeft inicia na página atual ou depois
    let lo = 0;
    let hi = els.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const p = calcBlockPage(els[mid].offsetLeft, step, totalPages);
      if (p < currentPage) lo = mid + 1;
      else hi = mid;
    }

    // Verifica blocos anteriores que começam antes mas continuam na página atual (invariante ao transform)
    const columnsLeft = columnsEl.getBoundingClientRect().left;
    const pageStart = currentPage * step;
    let firstVisible = Math.min(lo, els.length - 1);

    for (let i = lo - 1; i >= 0; i--) {
      const rect = els[i].getBoundingClientRect();
      const relRight = rect.right - columnsLeft;
      if (relRight > pageStart + 1) {
        firstVisible = i;
      } else {
        break;
      }
    }

    return firstVisible;
  }

  function pageOfBlock(blockIndex: number): number {
    if (!renderedChapter) return 0;
    const els = renderedChapter.blockEls;
    if (els.length === 0) return 0;
    const idx = clamp(Math.floor(blockIndex), 0, els.length - 1);
    return calcBlockPage(els[idx].offsetLeft, step, totalPages);
  }

  function findBookmarkOnCurrentPage(): number {
    if (!meta) return -1;
    const bookmarks = meta.bookmarks;

    for (let i = 0; i < bookmarks.length; i++) {
      const b = bookmarks[i];
      if (b.chapter === currentChapter && b.block === currentBlock) return i;
    }

    if (!renderedChapter || !columnsEl) return -1;
    const els = renderedChapter.blockEls;
    const columnsLeft = columnsEl.getBoundingClientRect().left;

    for (let i = 0; i < bookmarks.length; i++) {
      const b = bookmarks[i];
      if (b.chapter !== currentChapter) continue;
      const el = els[b.block];
      if (!el) continue;
      const startPage = calcBlockPage(el.offsetLeft, step, totalPages);
      const rect = el.getBoundingClientRect();
      const endPage = calcBlockPage(Math.max(0, rect.right - columnsLeft - 1), step, totalPages);
      if (startPage === currentPage && endPage === currentPage) return i;
    }

    return -1;
  }

  function updateBookmarkButton(): void {
    if (!bookmarkBtn) return;
    const marked = findBookmarkOnCurrentPage() >= 0;
    bookmarkBtn.classList.toggle('is-active', marked);
    bookmarkBtn.setAttribute('aria-pressed', String(marked));
    bookmarkBtn.setAttribute('aria-label', marked ? 'Remover marcador desta página' : 'Marcar esta página');
    bookmarkBtn.replaceChildren(createIcon(marked ? 'bookmarkFilled' : 'bookmark'));
  }

  function updateHud(persist: boolean): void {
    if (!meta || !content) return;
    const percent = calcBookPercent(
      currentChapter,
      currentPage,
      totalPages,
      getChapterChars(),
      meta.totalChars,
    );

    if (progressLineFillEl) {
      progressLineFillEl.style.width = `${percent}%`;
    }
    if (statusPageEl) {
      statusPageEl.textContent = `Pág. ${currentPage + 1} de ${totalPages} · ${percent}%`;
    }
    if (statusTimeEl) {
      const mins = estimateChapterMinutesLeft(chapterWordCount, currentPage, totalPages);
      statusTimeEl.textContent = formatRemainingTime(mins);
    }
    if (sliderEl && !isScrubbing) {
      sliderEl.value = String(Math.round(percent * 10));
    }

    updateBookmarkButton();

    if (persist) {
      meta.position = { chapter: currentChapter, block: currentBlock };
      meta.percent = percent;
      meta.lastOpenedAt = Date.now();
      scheduleSave();
    }
  }

  function applyTransform(page: number, animate: boolean): void {
    if (!columnsEl) return;
    columnsEl.classList.toggle('is-animating', animate);
    columnsEl.style.transform = `translate3d(${-page * step}px, 0, 0)`;
  }

  function goToPage(page: number, animate: boolean, persist = true): void {
    anchorMode = 'block';
    currentPage = clamp(page, 0, Math.max(0, totalPages - 1));
    applyTransform(currentPage, animate);
    currentBlock = findFirstVisibleBlock();
    updateHud(persist);
  }

  function scheduleImageRelayout(): void {
    if (disposed || imageRaf !== null) return;
    imageRaf = requestAnimationFrame(() => {
      imageRaf = null;
      if (disposed || !columnsEl) return;
      const prevTotal = totalPages;
      measureTotalPages();
      if (anchorMode === 'end') {
        currentPage = Math.max(0, totalPages - 1);
        applyTransform(currentPage, false);
        currentBlock = findFirstVisibleBlock();
        updateHud(false);
      } else if (totalPages !== prevTotal) {
        currentPage = pageOfBlock(currentBlock);
        applyTransform(currentPage, false);
        updateHud(false);
      }
    });
  }

  function loadChapter(chapterIndex: number, target: ChapterTarget, persist = true): void {
    if (!content || !meta || !columnsEl) return;

    if (imageRaf !== null) {
      cancelAnimationFrame(imageRaf);
      imageRaf = null;
    }

    renderedChapter?.dispose();
    renderedChapter = null;

    if (content.chapters.length === 0) {
      currentChapter = 0;
      currentPage = 0;
      totalPages = 1;
      currentBlock = 0;
      chapterWordCount = 0;
      const empty = document.createElement('div');
      empty.className = 'reader-empty-chapter';
      empty.textContent = 'Este livro não possui capítulos.';
      columnsEl.replaceChildren(empty);
      applyTransform(0, false);
      updateHud(false);
      return;
    }

    currentChapter = clamp(Math.floor(chapterIndex), 0, content.chapters.length - 1);
    const chapter = content.chapters[currentChapter];
    chapterWordCount = countChapterWords(chapter.blocks);

    columnsEl.classList.remove('is-animating');
    columnsEl.style.transform = 'translate3d(0, 0, 0)';

    if (chapter.blocks.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'reader-empty-chapter';
      empty.textContent = 'Este capítulo está vazio.';
      columnsEl.replaceChildren(empty);
      totalPages = 1;
      currentPage = 0;
      currentBlock = 0;
      anchorMode = 'block';
      updateHud(persist);
      return;
    }

    renderedChapter = renderChapterBlocks(
      bookId,
      chapter,
      Boolean(meta.fixedLayout),
      scheduleImageRelayout,
    );
    columnsEl.replaceChildren(renderedChapter.fragment);

    measureTotalPages();

    if (target.mode === 'start') {
      anchorMode = 'block';
      currentPage = 0;
      currentBlock = 0;
    } else if (target.mode === 'end') {
      anchorMode = 'end';
      currentPage = Math.max(0, totalPages - 1);
      applyTransform(currentPage, false);
      currentBlock = findFirstVisibleBlock();
      updateHud(persist);
      return;
    } else if (target.mode === 'block') {
      anchorMode = 'block';
      currentBlock = clamp(Math.floor(target.block), 0, Math.max(0, chapter.blocks.length - 1));
      currentPage = pageOfBlock(currentBlock);
    } else {
      anchorMode = 'block';
      currentPage = fractionToPage(target.fraction, totalPages);
      applyTransform(currentPage, false);
      currentBlock = findFirstVisibleBlock();
      updateHud(persist);
      return;
    }

    applyTransform(currentPage, false);
    if (target.mode === 'start') {
      currentBlock = findFirstVisibleBlock();
    }
    updateHud(persist);
  }

  function repaginateKeepingPosition(): void {
    if (!content || !columnsEl) return;
    const anchorBlock = currentBlock;
    applySettingsToDom();
    measureTotalPages();
    if (anchorMode === 'end') {
      currentPage = Math.max(0, totalPages - 1);
    } else {
      currentPage = pageOfBlock(anchorBlock);
    }
    applyTransform(currentPage, false);
    updateHud(false);
  }

  function nextPage(animate: boolean): void {
    if (!content) return;
    if (currentPage < totalPages - 1) {
      goToPage(currentPage + 1, animate);
    } else if (currentChapter < content.chapters.length - 1) {
      loadChapter(currentChapter + 1, { mode: 'start' });
    } else {
      applyTransform(currentPage, true);
    }
  }

  function prevPage(animate: boolean): void {
    if (!content) return;
    if (currentPage > 0) {
      goToPage(currentPage - 1, animate);
    } else if (currentChapter > 0) {
      loadChapter(currentChapter - 1, { mode: 'end' });
    } else {
      applyTransform(currentPage, true);
    }
  }

  function setHudOpen(open: boolean): void {
    hudOpen = open;
    readerEl.classList.toggle('is-hud-open', hudOpen);
  }

  function toggleHud(): void {
    setHudOpen(!hudOpen);
  }

  function toggleBookmark(): void {
    if (!meta || !content) return;
    const idx = findBookmarkOnCurrentPage();
    if (idx >= 0) {
      meta.bookmarks.splice(idx, 1);
    } else {
      const chapter = content.chapters[currentChapter];
      const label = chapter
        ? extractExcerpt(chapter.blocks, currentBlock, getChapterTitle(currentChapter))
        : getChapterTitle(currentChapter);
      const bm: Bookmark = {
        chapter: currentChapter,
        block: currentBlock,
        label,
        at: Date.now(),
      };
      meta.bookmarks.push(bm);
    }
    updateBookmarkButton();
    if (tocPanel?.isOpen()) {
      tocPanel.updateBookmarks(meta.bookmarks, resolvedTitles);
    }
    metaDirty = true;
    flushSave();
  }

  function handleSettingsChange(patch: Partial<ReaderSettings>): void {
    if (!settings) return;
    const prev = settings;
    const next = clampSettings({ ...prev, ...patch });
    settings = next;
    settingsPanel?.sync(next);

    if (next.theme !== prev.theme) {
      applyTheme(next.theme);
    }

    const layoutChanged =
      next.fontSize !== prev.fontSize ||
      next.lineHeight !== prev.lineHeight ||
      next.margin !== prev.margin ||
      next.font !== prev.font ||
      next.justify !== prev.justify ||
      next.hyphenate !== prev.hyphenate;

    if (layoutChanged) {
      repaginateKeepingPosition();
    }

    saveSettings(next).catch(() => {});
  }

  function buildUi(loadedMeta: BookMeta, loadedContent: BookContent, loadedSettings: ReaderSettings): void {
    meta = loadedMeta;
    content = loadedContent;
    settings = clampSettings(loadedSettings);
    applyTheme(settings.theme);

    resolvedTitles = loadedContent.chapters.map(
      (ch, i) => loadedMeta.chapterTitles[i]?.trim() || ch.title?.trim() || `Capítulo ${i + 1}`,
    );

    // Viewport + colunas
    const viewport = document.createElement('div');
    viewport.className = 'reader-viewport';
    viewportEl = viewport;

    const columns = document.createElement('div');
    columns.className = 'reader-columns';
    columns.lang = loadedMeta.lang?.trim() || 'pt-BR';
    if (loadedMeta.fixedLayout) columns.classList.add('is-fixed-layout');
    columnsEl = columns;

    viewport.appendChild(columns);

    // Linha discreta de progresso sempre visível no rodapé
    const progressLine = document.createElement('div');
    progressLine.className = 'reader-progress-line';
    progressLine.setAttribute('aria-hidden', 'true');
    const progressFill = document.createElement('div');
    progressFill.className = 'reader-progress-line-fill';
    progressLineFillEl = progressFill;
    progressLine.appendChild(progressFill);

    // Barra superior
    const topbar = document.createElement('header');
    topbar.className = 'reader-topbar';
    const topbarInner = document.createElement('div');
    topbarInner.className = 'reader-topbar-inner';

    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'reader-icon-btn';
    backBtn.setAttribute('aria-label', 'Voltar à biblioteca');
    backBtn.appendChild(createIcon('back'));
    backBtn.addEventListener('click', () => {
      flushSave();
      goBackToLibrary();
    });

    const titleEl = document.createElement('h1');
    titleEl.className = 'reader-book-title';
    titleEl.textContent = loadedMeta.title;

    const tocBtn = document.createElement('button');
    tocBtn.type = 'button';
    tocBtn.className = 'reader-icon-btn';
    tocBtn.setAttribute('aria-label', 'Sumário e marcadores');
    tocBtn.appendChild(createIcon('toc'));
    tocBtn.addEventListener('click', () => {
      settingsPanel?.close();
      if (meta) tocPanel?.open(resolvedTitles, currentChapter, meta.bookmarks);
    });

    const bmBtn = document.createElement('button');
    bmBtn.type = 'button';
    bmBtn.className = 'reader-icon-btn';
    bmBtn.setAttribute('aria-label', 'Marcar esta página');
    bmBtn.appendChild(createIcon('bookmark'));
    bmBtn.addEventListener('click', toggleBookmark);
    bookmarkBtn = bmBtn;

    const aaBtn = document.createElement('button');
    aaBtn.type = 'button';
    aaBtn.className = 'reader-icon-btn reader-aa-btn';
    aaBtn.setAttribute('aria-label', 'Configurações de leitura');
    aaBtn.textContent = 'Aa';
    aaBtn.addEventListener('click', () => {
      tocPanel?.close();
      if (settings) settingsPanel?.open(settings);
    });

    topbarInner.append(backBtn, titleEl, tocBtn, bmBtn, aaBtn);
    topbar.appendChild(topbarInner);

    // Barra inferior
    const bottombar = document.createElement('footer');
    bottombar.className = 'reader-bottombar';

    const preview = document.createElement('div');
    preview.className = 'reader-scrub-preview';
    preview.hidden = true;

    const sliderWrap = document.createElement('div');
    sliderWrap.className = 'reader-slider-wrap';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '1000';
    slider.step = '1';
    slider.value = '0';
    slider.className = 'reader-slider';
    slider.setAttribute('aria-label', 'Progresso do livro');
    sliderEl = slider;

    slider.addEventListener('input', () => {
      if (!meta) return;
      isScrubbing = true;
      const pct = Number(slider.value) / 10;
      const target = percentToTarget(pct, getChapterChars(), meta.totalChars);
      preview.textContent = `${getChapterTitle(target.chapter)} · ${Math.round(pct)}%`;
      preview.hidden = false;
    });

    slider.addEventListener('change', () => {
      if (!meta) return;
      isScrubbing = false;
      preview.hidden = true;
      const pct = Number(slider.value) / 10;
      const target = percentToTarget(pct, getChapterChars(), meta.totalChars);
      loadChapter(target.chapter, { mode: 'fraction', fraction: target.fraction });
    });

    const endScrubPreview = (): void => {
      if (!isScrubbing) return;
      isScrubbing = false;
      preview.hidden = true;
    };
    slider.addEventListener('pointerup', endScrubPreview);
    slider.addEventListener('pointercancel', endScrubPreview);
    slider.addEventListener('blur', endScrubPreview);

    sliderWrap.appendChild(slider);

    const statusRow = document.createElement('div');
    statusRow.className = 'reader-status-row';
    const statusPage = document.createElement('span');
    statusPage.className = 'reader-status-page';
    statusPageEl = statusPage;
    const statusTime = document.createElement('span');
    statusTime.className = 'reader-status-time';
    statusTimeEl = statusTime;
    statusRow.append(statusPage, statusTime);

    bottombar.append(preview, sliderWrap, statusRow);

    // Painel de sumário e marcadores
    tocPanel = createTocPanel({
      onSelectChapter(chIdx) {
        tocPanel?.close();
        setHudOpen(false);
        loadChapter(chIdx, { mode: 'start' });
      },
      onSelectBookmark(bm) {
        tocPanel?.close();
        setHudOpen(false);
        loadChapter(bm.chapter, { mode: 'block', block: bm.block });
      },
      onRemoveBookmark(bm) {
        if (!meta) return;
        const idx = meta.bookmarks.findIndex(
          (item) => item.chapter === bm.chapter && item.block === bm.block && item.at === bm.at,
        );
        if (idx >= 0) {
          meta.bookmarks.splice(idx, 1);
          tocPanel?.updateBookmarks(meta.bookmarks, resolvedTitles);
          updateBookmarkButton();
          metaDirty = true;
          flushSave();
        }
      },
      onClose() {
        tocPanel?.close();
      },
    });

    // Painel "Aa"
    settingsPanel = createSettingsPanel({
      onChange: handleSettingsChange,
      onClose() {
        settingsPanel?.close();
      },
    });

    readerEl.replaceChildren(
      viewport,
      progressLine,
      topbar,
      bottombar,
      tocPanel.el,
      settingsPanel.el,
    );

    // Navegação por toque e deslize horizontal (Pointer Events)
    let activePointerId: number | null = null;
    let startX = 0;
    let startY = 0;
    let startTime = 0;
    let gesture: 'pending' | 'horizontal' | 'vertical' = 'pending';
    let lastDx = 0;

    const onPointerDown = (e: PointerEvent): void => {
      if (!e.isPrimary) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (tocPanel?.isOpen() || settingsPanel?.isOpen()) return;

      activePointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      startTime = performance.now();
      gesture = 'pending';
      lastDx = 0;

      try {
        viewport.setPointerCapture(e.pointerId);
      } catch {
        // Ignora caso o ponteiro não suporte captura
      }
    };

    const onPointerMove = (e: PointerEvent): void => {
      if (e.pointerId !== activePointerId || !columnsEl) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      if (gesture === 'pending') {
        if (Math.abs(dx) < TAP_SLOP && Math.abs(dy) < TAP_SLOP) return;
        if (Math.abs(dy) > Math.abs(dx)) {
          gesture = 'vertical';
          return;
        }
        gesture = 'horizontal';
        columnsEl.classList.remove('is-animating');
      }

      if (gesture === 'horizontal') {
        lastDx = dx;
        const atBookStart = currentChapter === 0 && currentPage === 0;
        const atBookEnd =
          content !== null &&
          currentChapter >= content.chapters.length - 1 &&
          currentPage >= totalPages - 1;
        const dampedDx = (dx > 0 && atBookStart) || (dx < 0 && atBookEnd) ? dx * 0.25 : dx;
        columnsEl.style.transform = `translate3d(${-currentPage * step + dampedDx}px, 0, 0)`;
      }
    };

    const onPointerUp = (e: PointerEvent): void => {
      if (e.pointerId !== activePointerId) return;
      try {
        viewport.releasePointerCapture(e.pointerId);
      } catch {
        // Ignora
      }
      activePointerId = null;

      if (gesture === 'horizontal') {
        if (lastDx <= -SWIPE_THRESHOLD) {
          if (hudOpen) setHudOpen(false);
          nextPage(true);
        } else if (lastDx >= SWIPE_THRESHOLD) {
          if (hudOpen) setHudOpen(false);
          prevPage(true);
        } else {
          applyTransform(currentPage, true);
        }
        return;
      }

      if (gesture === 'pending' && performance.now() - startTime < TAP_MAX_MS) {
        const rect = viewport.getBoundingClientRect();
        const ratio = (e.clientX - rect.left) / Math.max(1, rect.width);
        if (ratio < 1 / 3) {
          if (hudOpen) setHudOpen(false);
          prevPage(true);
        } else if (ratio > 2 / 3) {
          if (hudOpen) setHudOpen(false);
          nextPage(true);
        } else {
          toggleHud();
        }
      }
    };

    const onPointerCancel = (e: PointerEvent): void => {
      if (e.pointerId !== activePointerId) return;
      activePointerId = null;
      if (gesture === 'horizontal') {
        applyTransform(currentPage, true);
      }
    };

    viewport.addEventListener('pointerdown', onPointerDown);
    viewport.addEventListener('pointermove', onPointerMove);
    viewport.addEventListener('pointerup', onPointerUp);
    viewport.addEventListener('pointercancel', onPointerCancel);
    cleanups.push(() => {
      viewport.removeEventListener('pointerdown', onPointerDown);
      viewport.removeEventListener('pointermove', onPointerMove);
      viewport.removeEventListener('pointerup', onPointerUp);
      viewport.removeEventListener('pointercancel', onPointerCancel);
    });

    // Atalhos de teclado
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (tocPanel?.isOpen()) {
          e.preventDefault();
          tocPanel.close();
          return;
        }
        if (settingsPanel?.isOpen()) {
          e.preventDefault();
          settingsPanel.close();
          return;
        }
        if (hudOpen) {
          e.preventDefault();
          setHudOpen(false);
        }
        return;
      }

      if (tocPanel?.isOpen() || settingsPanel?.isOpen()) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const target = e.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      ) {
        return;
      }

      if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        e.preventDefault();
        if (hudOpen) setHudOpen(false);
        nextPage(true);
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        if (hudOpen) setHudOpen(false);
        prevPage(true);
      } else if (e.key === ' ') {
        e.preventDefault();
        if (hudOpen) setHudOpen(false);
        if (e.shiftKey) prevPage(true);
        else nextPage(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    cleanups.push(() => window.removeEventListener('keydown', onKeyDown));

    // Visibilidade: salva posição e re-solicita WakeLock
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') {
        flushSave();
      } else if (document.visibilityState === 'visible') {
        void requestWakeLock();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    cleanups.push(() => document.removeEventListener('visibilitychange', onVisibilityChange));

    // ResizeObserver com debounce para repaginar ao girar tela ou redimensionar
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        if (disposed || !viewportEl) return;
        const w = viewportEl.clientWidth;
        const h = viewportEl.clientHeight;
        if (w <= 0 || h <= 0) return;
        if (w === lastMeasuredW && h === lastMeasuredH) return;
        if (resizeTimer !== null) window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => {
          resizeTimer = null;
          if (!disposed) repaginateKeepingPosition();
        }, RESIZE_DEBOUNCE_MS);
      });
      resizeObserver.observe(viewport);
    }

    // Aplica configurações iniciais, carrega capítulo salvo e ativa WakeLock
    applySettingsToDom();
    const initialPos = loadedMeta.position ?? { chapter: 0, block: 0 };
    loadChapter(initialPos.chapter, { mode: 'block', block: initialPos.block }, false);

    // Registra abertura do livro
    meta.lastOpenedAt = Date.now();
    meta.position = { chapter: currentChapter, block: currentBlock };
    meta.percent = calcBookPercent(
      currentChapter,
      currentPage,
      totalPages,
      getChapterChars(),
      meta.totalChars,
    );
    scheduleSave();

    void requestWakeLock();
  }

  // Carregamento assíncrono inicial
  void Promise.all([getMeta(bookId), getContent(bookId), loadSettings()])
    .then(([loadedMeta, loadedContent, loadedSettings]) => {
      if (disposed) return;
      if (!loadedMeta || !loadedContent) {
        showMessageState(
          'Livro não encontrado',
          'Este livro não está disponível na biblioteca local ou foi removido.',
        );
        return;
      }
      buildUi(loadedMeta, loadedContent, loadedSettings);
    })
    .catch(() => {
      if (disposed) return;
      showMessageState(
        'Não foi possível abrir o livro',
        'Ocorreu um erro ao ler os dados locais do livro.',
      );
    });

  // Função de desmontagem
  return () => {
    if (disposed) return;
    disposed = true;

    flushSave();

    if (resizeTimer !== null) {
      window.clearTimeout(resizeTimer);
      resizeTimer = null;
    }
    if (imageRaf !== null) {
      cancelAnimationFrame(imageRaf);
      imageRaf = null;
    }

    resizeObserver?.disconnect();
    resizeObserver = null;

    renderedChapter?.dispose();
    renderedChapter = null;

    releaseWakeLock();

    for (let i = 0; i < cleanups.length; i++) {
      cleanups[i]();
    }
    cleanups.length = 0;

    readerEl.remove();
  };
}
