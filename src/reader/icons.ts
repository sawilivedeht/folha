// Ícones SVG inline leves (sem dependências externas).
const SVG_NS = 'http://www.w3.org/2000/svg';

export type IconName =
  | 'back'
  | 'toc'
  | 'bookmark'
  | 'bookmarkFilled'
  | 'close'
  | 'trash';

function createSvg(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '22');
  svg.setAttribute('height', '22');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  return svg;
}

function addPath(svg: SVGSVGElement, d: string, fill?: string): void {
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', d);
  if (fill) p.setAttribute('fill', fill);
  svg.appendChild(p);
}

export function createIcon(name: IconName): SVGSVGElement {
  const svg = createSvg();
  switch (name) {
    case 'back':
      addPath(svg, 'M15 18l-6-6 6-6');
      break;
    case 'toc':
      addPath(svg, 'M4 6h16M4 12h16M4 18h10');
      break;
    case 'bookmark':
      addPath(svg, 'M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z');
      break;
    case 'bookmarkFilled':
      addPath(svg, 'M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z', 'currentColor');
      break;
    case 'close':
      addPath(svg, 'M18 6L6 18M6 6l12 12');
      break;
    case 'trash':
      addPath(svg, 'M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6');
      break;
  }
  return svg;
}
