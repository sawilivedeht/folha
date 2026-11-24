// Renderização segura de um capítulo (textContent/createTextNode, nunca innerHTML) e ciclo de vida de imagens.
import { getBlob, imageKey } from '../db';
import type { Block, Chapter, Run } from '../types';

export interface RenderedChapter {
  fragment: DocumentFragment;
  blockEls: HTMLElement[];
  dispose: () => void;
}

function appendRuns(parent: HTMLElement, text: string, runs?: Run[]): void {
  if (!runs || runs.length === 0) {
    parent.textContent = text;
    return;
  }
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (!run.s) continue;
    let node: Node = document.createTextNode(run.s);
    if (run.sup) {
      const sup = document.createElement('sup');
      sup.appendChild(node);
      node = sup;
    }
    if (run.i) {
      const em = document.createElement('em');
      em.appendChild(node);
      node = em;
    }
    if (run.b) {
      const strong = document.createElement('strong');
      strong.appendChild(node);
      node = strong;
    }
    parent.appendChild(node);
  }
}

export function renderChapterBlocks(
  bookId: string,
  chapter: Chapter,
  fixedLayout: boolean,
  onImageLoad: () => void,
): RenderedChapter {
  const fragment = document.createDocumentFragment();
  const blockEls: HTMLElement[] = [];
  const objectUrls: string[] = [];
  let disposed = false;

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (let i = 0; i < objectUrls.length; i++) {
      URL.revokeObjectURL(objectUrls[i]);
    }
    objectUrls.length = 0;
  };

  let activeList: HTMLUListElement | HTMLOListElement | null = null;
  let activeListOrdered: boolean | null = null;

  const closeList = (): void => {
    activeList = null;
    activeListOrdered = null;
  };

  const blocks = chapter.blocks;
  for (let i = 0; i < blocks.length; i++) {
    const block: Block = blocks[i];

    if (block.t === 'li') {
      const ordered = Boolean(block.ordered);
      if (!activeList || activeListOrdered !== ordered) {
        activeList = document.createElement(ordered ? 'ol' : 'ul');
        activeList.className = 'reader-list';
        activeListOrdered = ordered;
        fragment.appendChild(activeList);
      }
      const li = document.createElement('li');
      li.className = 'reader-li';
      li.dataset.i = String(i);
      appendRuns(li, block.text, block.runs);
      activeList.appendChild(li);
      blockEls.push(li);
      continue;
    }

    closeList();

    if (block.t === 'h') {
      const tag = block.level === 1 ? 'h1' : block.level === 2 ? 'h2' : 'h3';
      const el = document.createElement(tag);
      el.className = `reader-h reader-h${block.level}`;
      el.dataset.i = String(i);
      el.textContent = block.text;
      fragment.appendChild(el);
      blockEls.push(el);
    } else if (block.t === 'p') {
      const el = document.createElement('p');
      el.className = 'reader-p';
      el.dataset.i = String(i);
      appendRuns(el, block.text, block.runs);
      fragment.appendChild(el);
      blockEls.push(el);
    } else if (block.t === 'quote') {
      const el = document.createElement('blockquote');
      el.className = 'reader-quote';
      el.dataset.i = String(i);
      appendRuns(el, block.text, block.runs);
      fragment.appendChild(el);
      blockEls.push(el);
    } else if (block.t === 'pre') {
      const el = document.createElement('pre');
      el.className = 'reader-pre';
      el.dataset.i = String(i);
      el.textContent = block.text;
      fragment.appendChild(el);
      blockEls.push(el);
    } else if (block.t === 'hr') {
      const el = document.createElement('hr');
      el.className = 'reader-hr';
      el.dataset.i = String(i);
      fragment.appendChild(el);
      blockEls.push(el);
    } else if (block.t === 'img') {
      const figure = document.createElement('figure');
      figure.className = fixedLayout ? 'reader-fixed-page' : 'reader-figure';
      figure.dataset.i = String(i);

      const img = document.createElement('img');
      img.className = 'reader-img';
      img.alt = block.alt ?? '';
      img.decoding = 'async';
      img.draggable = false;
      img.style.visibility = 'hidden';

      if (block.w && block.h && block.w > 0 && block.h > 0) {
        img.width = block.w;
        img.height = block.h;
      }

      figure.appendChild(img);
      fragment.appendChild(figure);
      blockEls.push(figure);

      void loadBlockImage(
        bookId,
        block.src,
        block.alt,
        figure,
        img,
        () => disposed,
        (url) => objectUrls.push(url),
        onImageLoad,
      );
    }
  }

  return { fragment, blockEls, dispose };
}

async function loadBlockImage(
  bookId: string,
  src: string,
  alt: string | undefined,
  figure: HTMLElement,
  img: HTMLImageElement,
  isDisposed: () => boolean,
  trackUrl: (url: string) => void,
  onImageLoad: () => void,
): Promise<void> {
  try {
    const blob = await getBlob(imageKey(bookId, src));
    if (isDisposed()) return;

    if (!blob) {
      showImageFallback(figure, img, alt);
      onImageLoad();
      return;
    }

    const url = URL.createObjectURL(blob);
    if (isDisposed()) {
      URL.revokeObjectURL(url);
      return;
    }
    trackUrl(url);

    img.addEventListener(
      'load',
      () => {
        if (isDisposed()) return;
        img.style.visibility = '';
        onImageLoad();
      },
      { once: true },
    );
    img.addEventListener(
      'error',
      () => {
        if (isDisposed()) return;
        showImageFallback(figure, img, alt);
        onImageLoad();
      },
      { once: true },
    );
    img.src = url;
  } catch {
    if (isDisposed()) return;
    showImageFallback(figure, img, alt);
    onImageLoad();
  }
}

function showImageFallback(figure: HTMLElement, img: HTMLImageElement, alt?: string): void {
  img.remove();
  const fallback = document.createElement('figcaption');
  fallback.className = 'reader-img-fallback';
  fallback.textContent = alt?.trim() || 'Imagem indisponível';
  figure.appendChild(fallback);
}
