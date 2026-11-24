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
  unmount = m ? mountReader(root, decodeURIComponent(m[1])) : mountLibrary(root);
}

window.addEventListener('popstate', route);

if (Capacitor.isNativePlatform()) {
  App.addListener('backButton', ({ canGoBack }) => {
    if (location.hash.startsWith('#/ler/')) navigate('#/', true);
    else if (canGoBack) history.back();
    else App.exitApp();
  });
}

loadSettings().then((s) => {
  applyTheme(s.theme);
  route();
});
