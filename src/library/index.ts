import '../styles/library.css';
import { coverKey, deleteBook, getBlob, listBooks } from '../db';
import { importFileWithWarnings } from '../import';
import { applyTheme, loadSettings, saveSettings, type Theme } from '../settings';
import { positionStashKey } from '../reader/progress';
import type { BookMeta } from '../types';

type SortMode = 'recent' | 'title' | 'author';

const COVER_PALETTE = [
  '#2c3e50',
  '#5c2b29',
  '#2d4a3e',
  '#3c3556',
  '#6b4423',
  '#264653',
  '#4a3b32',
  '#384959',
] as const;

const THEME_ORDER: Theme[] = ['light', 'sepia', 'dark', 'black'];
const THEME_LABELS: Record<Theme, string> = {
  light: 'Claro',
  sepia: 'Sépia',
  dark: 'Escuro',
  black: 'Preto',
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function hashTitle(title: string): number {
  let h = 2166136261;
  for (let i = 0; i < title.length; i++) {
    h ^= title.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function coverColor(title: string): string {
  return COVER_PALETTE[hashTitle(title) % COVER_PALETTE.length];
}

function formatDate(ts: number): string {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date(ts));
}

function progressLabel(book: BookMeta): string {
  if (book.percent === 0 && book.lastOpenedAt === undefined) return 'Novo';
  return `${Math.round(book.percent)}%`;
}

function openBook(id: string): void {
  history.pushState({ folha: true }, '', `#/ler/${encodeURIComponent(id)}`);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function createEmptySvg(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 120 120');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('lib-empty-svg');

  const rect1 = document.createElementNS(ns, 'rect');
  rect1.setAttribute('x', '22');
  rect1.setAttribute('y', '24');
  rect1.setAttribute('width', '22');
  rect1.setAttribute('height', '68');
  rect1.setAttribute('rx', '3');
  rect1.setAttribute('stroke', 'currentColor');
  rect1.setAttribute('stroke-width', '3');

  const rect2 = document.createElementNS(ns, 'rect');
  rect2.setAttribute('x', '48');
  rect2.setAttribute('y', '18');
  rect2.setAttribute('width', '24');
  rect2.setAttribute('height', '74');
  rect2.setAttribute('rx', '3');
  rect2.setAttribute('stroke', 'currentColor');
  rect2.setAttribute('stroke-width', '3');

  const rect3 = document.createElementNS(ns, 'rect');
  rect3.setAttribute('x', '76');
  rect3.setAttribute('y', '30');
  rect3.setAttribute('width', '20');
  rect3.setAttribute('height', '62');
  rect3.setAttribute('rx', '3');
  rect3.setAttribute('stroke', 'currentColor');
  rect3.setAttribute('stroke-width', '3');

  const shelf = document.createElementNS(ns, 'line');
  shelf.setAttribute('x1', '14');
  shelf.setAttribute('y1', '98');
  shelf.setAttribute('x2', '106');
  shelf.setAttribute('y2', '98');
  shelf.setAttribute('stroke', 'currentColor');
  shelf.setAttribute('stroke-width', '4');
  shelf.setAttribute('stroke-linecap', 'round');

  svg.append(rect1, rect2, rect3, shelf);
  return svg;
}

function createGeneratedCover(book: BookMeta): HTMLElement {
  const gen = el('div', 'lib-cover-gen');
  gen.style.backgroundColor = coverColor(book.title);
  gen.append(el('div', 'lib-cover-gen-title', book.title));
  if (book.author) {
    gen.append(el('div', 'lib-cover-gen-author', book.author));
  }
  return gen;
}

function createProgressRow(book: BookMeta): HTMLElement {
  const row = el('div', 'lib-progress-row');
  const bar = el('div', 'lib-progress-bar');
  const fill = el('div', 'lib-progress-fill');
  fill.style.width = `${Math.max(0, Math.min(100, book.percent))}%`;
  bar.append(fill);
  row.append(bar, el('span', 'lib-progress-label', progressLabel(book)));
  return row;
}

export function mountLibrary(root: HTMLElement): () => void {
  let disposed = false;
  let books: BookMeta[] = [];
  let sortMode: SortMode = 'recent';
  let searchQuery = '';
  let importing = false;
  let dragDepth = 0;
  let longPressTimer: number | null = null;
  // Após um toque longo, o dedo ainda está sobre o menu recém-aberto: o "click" do soltar cairia no fundo (fechando o menu)
  // ou num item do menu (acionando-o sem querer). Esse primeiro clique é descartado.
  let swallowNextModalClick = false;
  let observer: IntersectionObserver | null = null;
  const gridObjectUrls: string[] = [];
  let continueObjectUrl: string | null = null;

  const page = el('div', 'lib-page');
  const header = el('header', 'lib-header');
  const headerInner = el('div', 'lib-header-inner');
  const brand = el('h1', 'lib-brand', 'Folha');
  const headerActions = el('div', 'lib-header-actions');

  const themeBtn = el('button', 'lib-btn lib-btn-icon', 'Tema');
  themeBtn.type = 'button';
  themeBtn.setAttribute('aria-label', 'Alternar tema');

  const importBtn = el('button', 'lib-btn lib-btn-primary', 'Importar');
  importBtn.type = 'button';

  const fileInput = el('input', 'sr-only');
  fileInput.type = 'file';
  fileInput.accept = '.pdf,.epub,.txt,.md,application/pdf,application/epub+zip,text/plain';
  fileInput.multiple = true;
  fileInput.setAttribute('aria-label', 'Escolher arquivos para importar');
  fileInput.tabIndex = -1;

  headerActions.append(themeBtn, importBtn, fileInput);
  headerInner.append(brand, headerActions);
  header.append(headerInner);

  const main = el('main', 'lib-main');
  const modalLayer = el('div');
  // Um novo toque depois do menu aberto por toque longo é uma interação deliberada: para de descartar cliques.
  modalLayer.addEventListener('pointerdown', () => {
    swallowNextModalClick = false;
  });
  modalLayer.addEventListener(
    'click',
    (e) => {
      if (!swallowNextModalClick) return;
      swallowNextModalClick = false;
      e.stopPropagation();
      e.preventDefault();
    },
    true,
  );
  const dropOverlay = el('div', 'lib-drop-overlay');
  dropOverlay.hidden = true;
  dropOverlay.append(el('div', 'lib-drop-box', 'Solte os arquivos para importar'));

  page.append(header, main, modalLayer, dropOverlay);
  root.append(page);

  function revokeGridCovers(): void {
    while (gridObjectUrls.length > 0) {
      const url = gridObjectUrls.pop();
      if (url) URL.revokeObjectURL(url);
    }
    observer?.disconnect();
    observer = null;
  }

  function revokeAllCovers(): void {
    revokeGridCovers();
    if (continueObjectUrl) {
      URL.revokeObjectURL(continueObjectUrl);
      continueObjectUrl = null;
    }
  }

  function clearLongPress(): void {
    if (longPressTimer !== null) {
      window.clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  function closeModal(): void {
    modalLayer.replaceChildren();
  }

  function openPicker(): void {
    if (importing) return;
    fileInput.value = '';
    fileInput.click();
  }

  function syncThemeButton(theme: Theme): void {
    themeBtn.textContent = THEME_LABELS[theme];
    themeBtn.title = `Tema atual: ${THEME_LABELS[theme]}. Toque para alternar.`;
    // O nome acessível precisa conter o texto visível do botão (WCAG 2.5.3).
    themeBtn.setAttribute('aria-label', `Tema ${THEME_LABELS[theme]}, alternar tema`);
  }

  loadSettings().then((s) => {
    if (!disposed) syncThemeButton(s.theme);
  });

  themeBtn.addEventListener('click', async () => {
    const settings = await loadSettings();
    const idx = THEME_ORDER.indexOf(settings.theme);
    const nextTheme = THEME_ORDER[(idx + 1) % THEME_ORDER.length];
    const updated = { ...settings, theme: nextTheme };
    await saveSettings(updated);
    applyTheme(nextTheme);
    if (!disposed) syncThemeButton(nextTheme);
  });

  importBtn.addEventListener('click', openPicker);

  fileInput.addEventListener('change', () => {
    const files = fileInput.files ? Array.from(fileInput.files) : [];
    if (files.length > 0) void handleImportFiles(files);
  });

  function attachCardInteractions(card: HTMLElement, book: BookMeta): void {
    let suppressClick = false;
    let startX = 0;
    let startY = 0;

    card.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      suppressClick = false;
      startX = e.clientX;
      startY = e.clientY;
      clearLongPress();
      longPressTimer = window.setTimeout(() => {
        longPressTimer = null;
        suppressClick = true;
        swallowNextModalClick = true;
        showBookMenu(book);
      }, 500);
    });

    card.addEventListener('pointermove', (e) => {
      if (longPressTimer === null) return;
      if (Math.hypot(e.clientX - startX, e.clientY - startY) > 10) {
        clearLongPress();
      }
    });

    card.addEventListener('pointerup', clearLongPress);
    card.addEventListener('pointercancel', clearLongPress);

    card.addEventListener('click', () => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      openBook(book.id);
    });

    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openBook(book.id);
      }
    });
  }

  function createMoreButton(book: BookMeta): HTMLButtonElement {
    const btn = el('button', 'lib-more-btn', '⋯');
    btn.type = 'button';
    btn.setAttribute('aria-label', `Opções para ${book.title}`);
    btn.addEventListener('pointerdown', (e) => e.stopPropagation());
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      showBookMenu(book);
    });
    return btn;
  }

  function createCoverElement(book: BookMeta, coverWrap: HTMLElement): void {
    coverWrap.append(createGeneratedCover(book));
    if (!book.hasCover) return;
    coverWrap.dataset.coverBookId = book.id;
  }

  async function hydrateCover(container: HTMLElement): Promise<void> {
    const bookId = container.dataset.coverBookId;
    if (!bookId || disposed) return;
    delete container.dataset.coverBookId;

    try {
      const blob = await getBlob(coverKey(bookId));
      if (disposed || !blob || !container.isConnected) return;
      const url = URL.createObjectURL(blob);
      if (container.closest('.lib-continue-card')) {
        if (continueObjectUrl) URL.revokeObjectURL(continueObjectUrl);
        continueObjectUrl = url;
      } else {
        gridObjectUrls.push(url);
      }
      const img = el('img', 'lib-cover-img');
      img.src = url;
      img.alt = '';
      img.decoding = 'async';
      container.replaceChildren(img);
    } catch {
      // Mantém a capa gerada se falhar a leitura do blob.
    }
  }

  function observeCovers(): void {
    const targets = main.querySelectorAll<HTMLElement>('[data-cover-book-id]');
    if (targets.length === 0) return;

    if (typeof IntersectionObserver === 'undefined') {
      targets.forEach((t) => void hydrateCover(t));
      return;
    }

    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const target = entry.target as HTMLElement;
            observer?.unobserve(target);
            void hydrateCover(target);
          }
        }
      },
      { rootMargin: '160px 0px' },
    );

    targets.forEach((t) => observer?.observe(t));
  }

  function buildContinueCard(book: BookMeta): HTMLElement {
    const card = el('div', 'lib-continue-card');
    card.tabIndex = 0;
    card.setAttribute('role', 'button');

    const coverWrap = el('div', 'lib-continue-cover');
    createCoverElement(book, coverWrap);

    const info = el('div', 'lib-continue-info');
    info.append(
      el('span', 'lib-continue-kicker', 'Continuar lendo'),
      el('h3', 'lib-continue-title', book.title),
    );
    if (book.author) {
      info.append(el('p', 'lib-continue-author', book.author));
    }
    info.append(createProgressRow(book));

    const actions = el('div', 'lib-continue-actions');
    actions.append(createMoreButton(book));

    card.append(coverWrap, info, actions);
    attachCardInteractions(card, book);
    return card;
  }

  function buildBookCard(book: BookMeta): HTMLElement {
    const card = el('article', 'lib-card');
    card.tabIndex = 0;

    const coverWrap = el('div', 'lib-cover-wrap');
    createCoverElement(book, coverWrap);

    const metaRow = el('div', 'lib-card-meta');
    const textCol = el('div', 'lib-card-text');
    textCol.append(el('h3', 'lib-card-title', book.title));
    if (book.author) {
      textCol.append(el('p', 'lib-card-author', book.author));
    }
    metaRow.append(textCol, createMoreButton(book));

    card.append(coverWrap, metaRow, createProgressRow(book));
    attachCardInteractions(card, book);
    return card;
  }

  function sortedAndFilteredBooks(): BookMeta[] {
    const q = searchQuery.trim().toLocaleLowerCase('pt-BR');
    const filtered = q
      ? books.filter(
          (b) =>
            b.title.toLocaleLowerCase('pt-BR').includes(q) ||
            (b.author ?? '').toLocaleLowerCase('pt-BR').includes(q),
        )
      : [...books];

    if (sortMode === 'title') {
      filtered.sort((a, b) => a.title.localeCompare(b.title, 'pt-BR', { sensitivity: 'base' }));
    } else if (sortMode === 'author') {
      filtered.sort((a, b) =>
        (a.author ?? '').localeCompare(b.author ?? '', 'pt-BR', { sensitivity: 'base' }),
      );
    } else {
      filtered.sort((a, b) => (b.lastOpenedAt ?? b.addedAt) - (a.lastOpenedAt ?? a.addedAt));
    }

    return filtered;
  }

  function renderBooks(): void {
    revokeAllCovers();
    main.replaceChildren();

    if (books.length === 0) {
      const empty = el('section', 'lib-empty');
      empty.append(
        createEmptySvg(),
        el('h2', 'lib-empty-title', 'Sua estante está vazia'),
        el('p', 'lib-empty-sub', 'Adicione seus livros digitais para começar a ler no Folha.'),
      );
      const cta = el('button', 'lib-btn lib-btn-primary', 'Importar PDF, EPUB ou TXT');
      cta.type = 'button';
      cta.addEventListener('click', openPicker);
      empty.append(cta);
      main.append(empty);
      return;
    }

    const continueBook = books
      .filter((b) => b.lastOpenedAt !== undefined)
      .sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0))[0];

    if (continueBook) {
      const contSection = el('section', 'lib-section');
      contSection.append(buildContinueCard(continueBook));
      main.append(contSection);
    }

    const allSection = el('section', 'lib-section');
    const secHeader = el('div', 'lib-section-header');
    secHeader.append(el('h2', 'lib-section-title', 'Todos os livros'));

    const controls = el('div', 'lib-controls');
    if (books.length > 8) {
      const searchInput = el('input', 'lib-search');
      searchInput.type = 'search';
      searchInput.placeholder = 'Buscar por título ou autor...';
      searchInput.value = searchQuery;
      searchInput.setAttribute('aria-label', 'Buscar livros por título ou autor');
      searchInput.addEventListener('input', () => {
        searchQuery = searchInput.value;
        renderGridOnly(gridHost);
      });
      controls.append(searchInput);
    }

    const sortSelect = el('select', 'lib-sort');
    sortSelect.setAttribute('aria-label', 'Ordenar livros');
    const options: Array<{ value: SortMode; label: string }> = [
      { value: 'recent', label: 'Mais recentes' },
      { value: 'title', label: 'Título (A–Z)' },
      { value: 'author', label: 'Autor (A–Z)' },
    ];
    for (const opt of options) {
      const o = el('option', undefined, opt.label);
      o.value = opt.value;
      if (opt.value === sortMode) o.selected = true;
      sortSelect.append(o);
    }
    sortSelect.addEventListener('change', () => {
      sortMode = sortSelect.value as SortMode;
      renderGridOnly(gridHost);
    });

    controls.append(sortSelect);
    secHeader.append(controls);

    const gridHost = el('div');
    allSection.append(secHeader, gridHost);
    main.append(allSection);

    renderGridOnly(gridHost);
  }

  function renderGridOnly(host: HTMLElement): void {
    revokeGridCovers();
    host.replaceChildren();
    const items = sortedAndFilteredBooks();

    if (items.length === 0) {
      host.append(el('p', 'lib-no-results', 'Nenhum livro encontrado para essa busca.'));
      return;
    }

    const grid = el('div', 'lib-grid');
    for (const book of items) {
      grid.append(buildBookCard(book));
    }
    host.append(grid);
    observeCovers();
  }

  function showModal(content: HTMLElement, closeOnBackdrop = true): void {
    const backdrop = el('div', 'lib-backdrop');
    const modal = el('div', 'lib-modal');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.append(content);
    backdrop.append(modal);

    if (closeOnBackdrop) {
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) closeModal();
      });
    }

    modalLayer.replaceChildren(backdrop);
  }

  function showBookMenu(book: BookMeta): void {
    const box = el('div');
    box.style.display = 'flex';
    box.style.flexDirection = 'column';
    box.style.gap = '12px';

    box.append(el('h3', 'lib-modal-title', book.title));

    const list = el('div', 'lib-menu-list');
    const detailsBtn = el('button', 'lib-menu-item', 'Detalhes');
    detailsBtn.type = 'button';
    detailsBtn.addEventListener('click', () => showBookDetails(book));

    const deleteBtn = el('button', 'lib-menu-item lib-menu-item-danger', 'Excluir');
    deleteBtn.type = 'button';
    deleteBtn.addEventListener('click', () => showDeleteConfirm(book));

    const cancelBtn = el('button', 'lib-menu-item', 'Cancelar');
    cancelBtn.type = 'button';
    cancelBtn.addEventListener('click', closeModal);

    list.append(detailsBtn, deleteBtn, cancelBtn);
    box.append(list);
    showModal(box);
  }

  function showBookDetails(book: BookMeta): void {
    const box = el('div');
    box.style.display = 'flex';
    box.style.flexDirection = 'column';
    box.style.gap = '14px';

    box.append(el('h3', 'lib-modal-title', 'Detalhes do livro'));

    const dl = el('dl', 'lib-details-list');
    const rows: Array<[string, string]> = [
      ['Título', book.title],
      ['Autor', book.author ?? 'Não informado'],
      ['Formato', book.format.toUpperCase()],
      ['Arquivo', book.fileName],
      ['Adicionado em', formatDate(book.addedAt)],
      ['Capítulos', String(book.chapterTitles.length)],
      ['Progresso', progressLabel(book)],
    ];
    if (book.lastOpenedAt !== undefined) {
      rows.splice(5, 0, ['Última leitura', formatDate(book.lastOpenedAt)]);
    }

    for (const [label, value] of rows) {
      dl.append(el('dt', undefined, label), el('dd', undefined, value));
    }

    const actions = el('div', 'lib-modal-actions');
    const closeBtn = el('button', 'lib-btn lib-btn-primary', 'Fechar');
    closeBtn.type = 'button';
    closeBtn.addEventListener('click', closeModal);
    actions.append(closeBtn);

    box.append(dl, actions);
    showModal(box);
  }

  function showDeleteConfirm(book: BookMeta): void {
    const box = el('div');
    box.style.display = 'flex';
    box.style.flexDirection = 'column';
    box.style.gap = '14px';

    box.append(
      el('h3', 'lib-modal-title', 'Excluir livro'),
      el(
        'p',
        'lib-modal-text',
        `Deseja excluir "${book.title}" da sua biblioteca? Esta ação não pode ser desfeita.`,
      ),
    );

    const actions = el('div', 'lib-modal-actions');
    const cancelBtn = el('button', 'lib-btn', 'Cancelar');
    cancelBtn.type = 'button';
    cancelBtn.addEventListener('click', closeModal);

    const confirmBtn = el('button', 'lib-btn lib-btn-danger', 'Excluir');
    confirmBtn.type = 'button';
    confirmBtn.addEventListener('click', async () => {
      confirmBtn.disabled = true;
      await deleteBook(book.id);
      try {
        localStorage.removeItem(positionStashKey(book.id));
      } catch {
        // sem localStorage: nada a limpar
      }
      if (disposed) return;
      closeModal();
      await refreshBooks();
    });

    actions.append(cancelBtn, confirmBtn);
    box.append(actions);
    showModal(box);
  }

  async function handleImportFiles(files: File[]): Promise<void> {
    if (importing || files.length === 0) return;
    importing = true;

    const box = el('div');
    box.style.display = 'flex';
    box.style.flexDirection = 'column';
    box.style.gap = '12px';

    const titleEl = el('h3', 'lib-modal-title', 'Importando livro');
    const fileEl = el('p', 'lib-modal-text', '');
    const statusEl = el('p', 'lib-modal-text', '');
    const bar = el('div', 'lib-progress-bar');
    const fill = el('div', 'lib-progress-fill');
    fill.style.width = '0%';
    bar.append(fill);

    box.append(titleEl, fileEl, bar, statusEl);
    showModal(box, false);

    const allWarnings: string[] = [];
    let hadError = false;

    for (let i = 0; i < files.length; i++) {
      if (disposed) break;
      const file = files[i];
      titleEl.textContent =
        files.length > 1 ? `Importando (${i + 1} de ${files.length})` : 'Importando livro';
      fileEl.textContent = file.name;
      statusEl.textContent = 'Preparando...';
      fill.style.width = '0%';

      try {
        const res = await importFileWithWarnings(file, (fraction, label) => {
          if (disposed) return;
          fill.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
          statusEl.textContent = label;
        });
        for (const w of res.warnings) {
          allWarnings.push(files.length > 1 ? `${file.name}: ${w}` : w);
        }
      } catch (err) {
        hadError = true;
        const message =
          err instanceof Error ? err.message : 'Não foi possível importar este arquivo.';
        const errEl = el('p', 'lib-modal-error', `${file.name}: ${message}`);
        box.append(errEl);
      }
    }

    importing = false;
    if (disposed) return;

    await refreshBooks();
    if (disposed) return;

    if (!hadError && allWarnings.length === 0) {
      closeModal();
      return;
    }

    titleEl.textContent = hadError ? 'Importação com erro' : 'Importação concluída';
    bar.hidden = true;
    statusEl.hidden = true;

    if (allWarnings.length > 0) {
      const warnTitle = el('p', 'lib-modal-text', 'Avisos:');
      const list = el('ul', 'lib-warnings');
      for (const w of allWarnings) {
        list.append(el('li', undefined, w));
      }
      box.append(warnTitle, list);
    }

    const actions = el('div', 'lib-modal-actions');
    const closeBtn = el('button', 'lib-btn lib-btn-primary', 'Fechar');
    closeBtn.type = 'button';
    closeBtn.addEventListener('click', closeModal);
    actions.append(closeBtn);
    box.append(actions);
  }

  async function refreshBooks(): Promise<void> {
    const loaded = await listBooks();
    if (disposed) return;
    books = loaded;
    renderBooks();
  }

  function onDragEnter(e: DragEvent): void {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    dragDepth++;
    dropOverlay.hidden = false;
  }

  function onDragOver(e: DragEvent): void {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
  }

  function onDragLeave(e: DragEvent): void {
    if (!e.dataTransfer?.types.includes('Files')) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropOverlay.hidden = true;
  }

  function onDrop(e: DragEvent): void {
    e.preventDefault();
    dragDepth = 0;
    dropOverlay.hidden = true;
    const files = e.dataTransfer?.files ? Array.from(e.dataTransfer.files) : [];
    if (files.length > 0) void handleImportFiles(files);
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && !importing && modalLayer.childElementCount > 0) {
      closeModal();
    }
  }

  window.addEventListener('dragenter', onDragEnter);
  window.addEventListener('dragover', onDragOver);
  window.addEventListener('dragleave', onDragLeave);
  window.addEventListener('drop', onDrop);
  window.addEventListener('keydown', onKeyDown);

  void refreshBooks();

  return () => {
    disposed = true;
    clearLongPress();
    revokeAllCovers();
    window.removeEventListener('dragenter', onDragEnter);
    window.removeEventListener('dragover', onDragOver);
    window.removeEventListener('dragleave', onDragLeave);
    window.removeEventListener('drop', onDrop);
    window.removeEventListener('keydown', onKeyDown);
  };
}
