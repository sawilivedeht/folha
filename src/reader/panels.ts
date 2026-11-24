// Painéis sobrepostos do leitor: Sumário/Marcadores e Configurações de aparência ("Aa").
import type { Bookmark } from '../types';
import type { FontFamily, ReaderSettings, Theme } from '../settings';
import { createIcon } from './icons';
import {
  MAX_FONT_SIZE,
  MAX_LINE_HEIGHT,
  MAX_MARGIN,
  MIN_FONT_SIZE,
  MIN_LINE_HEIGHT,
  MIN_MARGIN,
} from './progress';

export interface TocPanelCallbacks {
  onSelectChapter: (chapterIndex: number) => void;
  onSelectBookmark: (bookmark: Bookmark) => void;
  onRemoveBookmark: (bookmark: Bookmark) => void;
  onClose: () => void;
}

export interface TocPanelHandle {
  el: HTMLElement;
  open: (chapterTitles: readonly string[], currentChapter: number, bookmarks: readonly Bookmark[]) => void;
  updateBookmarks: (bookmarks: readonly Bookmark[], chapterTitles: readonly string[]) => void;
  close: () => void;
  isOpen: () => boolean;
}

const dateFormatter = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

function formatBookmarkDate(at: number): string {
  try {
    return dateFormatter.format(new Date(at));
  } catch {
    return '';
  }
}

export function createTocPanel(cb: TocPanelCallbacks): TocPanelHandle {
  const overlay = document.createElement('div');
  overlay.className = 'reader-sheet-overlay';
  overlay.hidden = true;

  const drawer = document.createElement('aside');
  drawer.className = 'reader-drawer';
  drawer.setAttribute('role', 'dialog');
  drawer.setAttribute('aria-modal', 'true');
  drawer.setAttribute('aria-label', 'Sumário e marcadores');

  const header = document.createElement('div');
  header.className = 'reader-drawer-header';

  const tabBar = document.createElement('div');
  tabBar.className = 'reader-tabs';
  tabBar.setAttribute('role', 'tablist');

  const tocTab = document.createElement('button');
  tocTab.type = 'button';
  tocTab.className = 'reader-tab is-active';
  tocTab.setAttribute('role', 'tab');
  tocTab.setAttribute('aria-selected', 'true');
  tocTab.textContent = 'Sumário';

  const bmTab = document.createElement('button');
  bmTab.type = 'button';
  bmTab.className = 'reader-tab';
  bmTab.setAttribute('role', 'tab');
  bmTab.setAttribute('aria-selected', 'false');
  bmTab.textContent = 'Marcadores';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'reader-icon-btn';
  closeBtn.setAttribute('aria-label', 'Fechar sumário');
  closeBtn.appendChild(createIcon('close'));

  tabBar.append(tocTab, bmTab);
  header.append(tabBar, closeBtn);

  const tocList = document.createElement('div');
  tocList.className = 'reader-drawer-body';
  tocList.setAttribute('role', 'tabpanel');

  const bmList = document.createElement('div');
  bmList.className = 'reader-drawer-body';
  bmList.setAttribute('role', 'tabpanel');
  bmList.hidden = true;

  drawer.append(header, tocList, bmList);
  overlay.appendChild(drawer);

  let activeTab: 'toc' | 'bookmarks' = 'toc';
  let openState = false;

  function setTab(tab: 'toc' | 'bookmarks'): void {
    activeTab = tab;
    const isToc = tab === 'toc';
    tocTab.classList.toggle('is-active', isToc);
    tocTab.setAttribute('aria-selected', String(isToc));
    bmTab.classList.toggle('is-active', !isToc);
    bmTab.setAttribute('aria-selected', String(!isToc));
    tocList.hidden = !isToc;
    bmList.hidden = isToc;
  }

  function renderChapters(chapterTitles: readonly string[], currentChapter: number): void {
    const frag = document.createDocumentFragment();
    if (chapterTitles.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'reader-panel-empty';
      empty.textContent = 'Nenhum capítulo encontrado.';
      frag.appendChild(empty);
    } else {
      for (let i = 0; i < chapterTitles.length; i++) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'reader-toc-item';
        if (i === currentChapter) {
          btn.classList.add('is-current');
          btn.setAttribute('aria-current', 'true');
        }
        const label = document.createElement('span');
        label.className = 'reader-toc-title';
        label.textContent = chapterTitles[i]?.trim() || `Capítulo ${i + 1}`;
        btn.appendChild(label);
        btn.addEventListener('click', () => cb.onSelectChapter(i));
        frag.appendChild(btn);
      }
    }
    tocList.replaceChildren(frag);
  }

  function renderBookmarks(bookmarks: readonly Bookmark[], chapterTitles: readonly string[]): void {
    const frag = document.createDocumentFragment();
    if (bookmarks.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'reader-panel-empty';
      empty.textContent = 'Nenhum marcador salvo. Toque no ícone de marcador na barra superior para marcar a página atual.';
      frag.appendChild(empty);
    } else {
      const sorted = [...bookmarks].sort((a, b) => a.chapter - b.chapter || a.block - b.block || b.at - a.at);
      for (let i = 0; i < sorted.length; i++) {
        const bm = sorted[i];
        const row = document.createElement('div');
        row.className = 'reader-bm-item';

        const mainBtn = document.createElement('button');
        mainBtn.type = 'button';
        mainBtn.className = 'reader-bm-main';

        const excerpt = document.createElement('span');
        excerpt.className = 'reader-bm-excerpt';
        excerpt.textContent = bm.label;

        const meta = document.createElement('span');
        meta.className = 'reader-bm-meta';
        const chTitle = chapterTitles[bm.chapter]?.trim() || `Capítulo ${bm.chapter + 1}`;
        const dateStr = formatBookmarkDate(bm.at);
        meta.textContent = dateStr ? `${chTitle} · ${dateStr}` : chTitle;

        mainBtn.append(excerpt, meta);
        mainBtn.addEventListener('click', () => cb.onSelectBookmark(bm));

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'reader-icon-btn reader-bm-del';
        delBtn.setAttribute('aria-label', 'Remover marcador');
        delBtn.appendChild(createIcon('trash'));
        delBtn.addEventListener('click', () => cb.onRemoveBookmark(bm));

        row.append(mainBtn, delBtn);
        frag.appendChild(row);
      }
    }
    bmList.replaceChildren(frag);
  }

  tocTab.addEventListener('click', () => setTab('toc'));
  bmTab.addEventListener('click', () => setTab('bookmarks'));
  closeBtn.addEventListener('click', () => cb.onClose());
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) cb.onClose();
  });

  return {
    el: overlay,
    open(chapterTitles, currentChapter, bookmarks) {
      openState = true;
      renderChapters(chapterTitles, currentChapter);
      renderBookmarks(bookmarks, chapterTitles);
      overlay.hidden = false;
      requestAnimationFrame(() => {
        if (!openState) return;
        overlay.classList.add('is-open');
        if (activeTab === 'toc') {
          const active = tocList.querySelector('.is-current');
          if (active instanceof HTMLElement) {
            active.scrollIntoView({ block: 'center' });
          }
        }
      });
    },
    updateBookmarks(bookmarks, chapterTitles) {
      renderBookmarks(bookmarks, chapterTitles);
    },
    close() {
      if (!openState) return;
      openState = false;
      overlay.classList.remove('is-open');
      overlay.hidden = true;
    },
    isOpen: () => openState,
  };
}

export interface SettingsPanelCallbacks {
  onChange: (patch: Partial<ReaderSettings>) => void;
  onClose: () => void;
}

export interface SettingsPanelHandle {
  el: HTMLElement;
  open: (settings: ReaderSettings) => void;
  sync: (settings: ReaderSettings) => void;
  close: () => void;
  isOpen: () => boolean;
}

const FONT_OPTIONS: readonly { value: FontFamily; label: string }[] = [
  { value: 'serif', label: 'Serifa' },
  { value: 'sans', label: 'Sem serifa' },
  { value: 'dyslexic', label: 'Legível' },
];

const THEME_OPTIONS: readonly { value: Theme; label: string }[] = [
  { value: 'light', label: 'Claro' },
  { value: 'sepia', label: 'Sépia' },
  { value: 'dark', label: 'Escuro' },
  { value: 'black', label: 'Preto' },
];

export function createSettingsPanel(cb: SettingsPanelCallbacks): SettingsPanelHandle {
  const overlay = document.createElement('div');
  overlay.className = 'reader-sheet-overlay reader-sheet-overlay--bottom';
  overlay.hidden = true;

  const sheet = document.createElement('section');
  sheet.className = 'reader-aa-sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', 'Configurações de leitura');

  const header = document.createElement('div');
  header.className = 'reader-aa-header';
  const heading = document.createElement('h2');
  heading.className = 'reader-aa-title';
  heading.textContent = 'Aparência';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'reader-icon-btn';
  closeBtn.setAttribute('aria-label', 'Fechar configurações');
  closeBtn.appendChild(createIcon('close'));
  header.append(heading, closeBtn);

  const body = document.createElement('div');
  body.className = 'reader-aa-body';

  let current: ReaderSettings | null = null;
  let openState = false;

  // --- Tamanho da fonte ---
  const fontSizeMinus = document.createElement('button');
  fontSizeMinus.type = 'button';
  fontSizeMinus.className = 'reader-step-btn';
  fontSizeMinus.textContent = 'A−';
  fontSizeMinus.setAttribute('aria-label', 'Diminuir fonte');

  const fontSizeVal = document.createElement('span');
  fontSizeVal.className = 'reader-step-val';

  const fontSizePlus = document.createElement('button');
  fontSizePlus.type = 'button';
  fontSizePlus.className = 'reader-step-btn';
  fontSizePlus.textContent = 'A+';
  fontSizePlus.setAttribute('aria-label', 'Aumentar fonte');

  fontSizeMinus.addEventListener('click', () => {
    if (!current) return;
    cb.onChange({ fontSize: Math.max(MIN_FONT_SIZE, current.fontSize - 1) });
  });
  fontSizePlus.addEventListener('click', () => {
    if (!current) return;
    cb.onChange({ fontSize: Math.min(MAX_FONT_SIZE, current.fontSize + 1) });
  });

  // --- Entrelinha ---
  const lhMinus = document.createElement('button');
  lhMinus.type = 'button';
  lhMinus.className = 'reader-step-btn';
  lhMinus.textContent = '−';
  lhMinus.setAttribute('aria-label', 'Diminuir entrelinha');

  const lhVal = document.createElement('span');
  lhVal.className = 'reader-step-val';

  const lhPlus = document.createElement('button');
  lhPlus.type = 'button';
  lhPlus.className = 'reader-step-btn';
  lhPlus.textContent = '+';
  lhPlus.setAttribute('aria-label', 'Aumentar entrelinha');

  lhMinus.addEventListener('click', () => {
    if (!current) return;
    const next = Math.max(MIN_LINE_HEIGHT, Math.round((current.lineHeight - 0.1) * 100) / 100);
    cb.onChange({ lineHeight: next });
  });
  lhPlus.addEventListener('click', () => {
    if (!current) return;
    const next = Math.min(MAX_LINE_HEIGHT, Math.round((current.lineHeight + 0.1) * 100) / 100);
    cb.onChange({ lineHeight: next });
  });

  // --- Margem ---
  const marginMinus = document.createElement('button');
  marginMinus.type = 'button';
  marginMinus.className = 'reader-step-btn';
  marginMinus.textContent = '−';
  marginMinus.setAttribute('aria-label', 'Diminuir margem');

  const marginVal = document.createElement('span');
  marginVal.className = 'reader-step-val';

  const marginPlus = document.createElement('button');
  marginPlus.type = 'button';
  marginPlus.className = 'reader-step-btn';
  marginPlus.textContent = '+';
  marginPlus.setAttribute('aria-label', 'Aumentar margem');

  marginMinus.addEventListener('click', () => {
    if (!current) return;
    cb.onChange({ margin: Math.max(MIN_MARGIN, current.margin - 4) });
  });
  marginPlus.addEventListener('click', () => {
    if (!current) return;
    cb.onChange({ margin: Math.min(MAX_MARGIN, current.margin + 4) });
  });

  function makeStepperRow(
    labelText: string,
    minus: HTMLButtonElement,
    val: HTMLSpanElement,
    plus: HTMLButtonElement,
  ): HTMLElement {
    const row = document.createElement('div');
    row.className = 'reader-aa-row';
    const label = document.createElement('span');
    label.className = 'reader-aa-label';
    label.textContent = labelText;
    const group = document.createElement('div');
    group.className = 'reader-stepper';
    group.append(minus, val, plus);
    row.append(label, group);
    return row;
  }

  // --- Família ---
  const fontRow = document.createElement('div');
  fontRow.className = 'reader-aa-block';
  const fontLabel = document.createElement('span');
  fontLabel.className = 'reader-aa-label';
  fontLabel.textContent = 'Fonte';
  const fontGroup = document.createElement('div');
  fontGroup.className = 'reader-seg-group';
  const fontBtns = new Map<FontFamily, HTMLButtonElement>();
  for (const opt of FONT_OPTIONS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `reader-seg-btn reader-seg-btn--${opt.value}`;
    btn.textContent = opt.label;
    btn.addEventListener('click', () => cb.onChange({ font: opt.value }));
    fontGroup.appendChild(btn);
    fontBtns.set(opt.value, btn);
  }
  fontRow.append(fontLabel, fontGroup);

  // --- Justificar / Hifenizar ---
  const togglesRow = document.createElement('div');
  togglesRow.className = 'reader-toggle-row';

  const justifyBtn = document.createElement('button');
  justifyBtn.type = 'button';
  justifyBtn.className = 'reader-toggle-btn';
  justifyBtn.textContent = 'Justificar';
  justifyBtn.addEventListener('click', () => {
    if (!current) return;
    cb.onChange({ justify: !current.justify });
  });

  const hyphenBtn = document.createElement('button');
  hyphenBtn.type = 'button';
  hyphenBtn.className = 'reader-toggle-btn';
  hyphenBtn.textContent = 'Hifenizar';
  hyphenBtn.addEventListener('click', () => {
    if (!current) return;
    cb.onChange({ hyphenate: !current.hyphenate });
  });

  togglesRow.append(justifyBtn, hyphenBtn);

  // --- Temas ---
  const themeRow = document.createElement('div');
  themeRow.className = 'reader-aa-block';
  const themeLabel = document.createElement('span');
  themeLabel.className = 'reader-aa-label';
  themeLabel.textContent = 'Tema';
  const themeGroup = document.createElement('div');
  themeGroup.className = 'reader-theme-group';
  const themeBtns = new Map<Theme, HTMLButtonElement>();
  for (const opt of THEME_OPTIONS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `reader-theme-btn reader-theme-btn--${opt.value}`;
    btn.textContent = opt.label;
    btn.addEventListener('click', () => cb.onChange({ theme: opt.value }));
    themeGroup.appendChild(btn);
    themeBtns.set(opt.value, btn);
  }
  themeRow.append(themeLabel, themeGroup);

  body.append(
    makeStepperRow('Tamanho', fontSizeMinus, fontSizeVal, fontSizePlus),
    makeStepperRow('Entrelinha', lhMinus, lhVal, lhPlus),
    makeStepperRow('Margem', marginMinus, marginVal, marginPlus),
    fontRow,
    togglesRow,
    themeRow,
  );

  sheet.append(header, body);
  overlay.appendChild(sheet);

  closeBtn.addEventListener('click', () => cb.onClose());
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) cb.onClose();
  });

  function sync(settings: ReaderSettings): void {
    current = settings;
    fontSizeVal.textContent = `${settings.fontSize} px`;
    fontSizeMinus.disabled = settings.fontSize <= MIN_FONT_SIZE;
    fontSizePlus.disabled = settings.fontSize >= MAX_FONT_SIZE;

    lhVal.textContent = settings.lineHeight.toFixed(2).replace('.', ',');
    lhMinus.disabled = settings.lineHeight <= MIN_LINE_HEIGHT;
    lhPlus.disabled = settings.lineHeight >= MAX_LINE_HEIGHT;

    marginVal.textContent = `${settings.margin} px`;
    marginMinus.disabled = settings.margin <= MIN_MARGIN;
    marginPlus.disabled = settings.margin >= MAX_MARGIN;

    for (const [k, btn] of fontBtns) {
      const active = k === settings.font;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', String(active));
    }

    justifyBtn.classList.toggle('is-active', settings.justify);
    justifyBtn.setAttribute('aria-pressed', String(settings.justify));
    hyphenBtn.classList.toggle('is-active', settings.hyphenate);
    hyphenBtn.setAttribute('aria-pressed', String(settings.hyphenate));

    for (const [k, btn] of themeBtns) {
      const active = k === settings.theme;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', String(active));
    }
  }

  return {
    el: overlay,
    open(settings) {
      openState = true;
      sync(settings);
      overlay.hidden = false;
      requestAnimationFrame(() => {
        if (!openState) return;
        overlay.classList.add('is-open');
      });
    },
    sync,
    close() {
      if (!openState) return;
      openState = false;
      overlay.classList.remove('is-open');
      overlay.hidden = true;
    },
    isOpen: () => openState,
  };
}
