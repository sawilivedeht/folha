// Roteador por hash: #/ = biblioteca, #/ler/<id> = leitor. O botão Voltar do Android segue o histórico.
import './styles/base.css';
import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { applyTheme, loadSettings } from './settings';
import { mountLibrary } from './library';
import { mountReader } from './reader';

const root = document.getElementById('app')!;
let unmount: (() => void) | null = null;

export function navigate(hash: string, replace = false): void {
  if (replace) history.replaceState(null, '', hash);
  else history.pushState(null, '', hash);
  route();
}

function route(): void {
  unmount?.();
  unmount = null;
  root.replaceChildren();
  const m = location.hash.match(/^#\/ler\/(.+)$/);
  unmount = m ? mountReader(root, safeDecode(m[1])) : mountLibrary(root);
}

/** Um hash com escape inválido (%E0%A4%A) vira um id que não existe, e o leitor mostra "Livro não encontrado". */
function safeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

window.addEventListener('popstate', route);

if (Capacitor.isNativePlatform()) {
  // No leitor, Voltar desfaz o pushState que abriu o livro (ou cai para a estante se o livro
  // foi a primeira tela). Na estante, que é a tela raiz, Voltar sai do app no primeiro toque.
  App.addListener('backButton', ({ canGoBack }) => {
    if (location.hash.startsWith('#/ler/')) {
      if (canGoBack) history.back();
      else navigate('#/', true);
    } else {
      App.exitApp();
    }
  });
}

loadSettings().then((s) => {
  applyTheme(s.theme);
  route();
});
