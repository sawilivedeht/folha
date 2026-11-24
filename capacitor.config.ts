import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.folha.leitor',
  appName: 'Folha',
  webDir: 'dist',
  backgroundColor: '#f7f3ea',
  android: { allowMixedContent: false },
  plugins: {
    // A troca dinâmica de cor (tema escuro/sépia) fica por conta do app.
    StatusBar: { overlaysWebView: false, backgroundColor: '#f7f3ea', style: 'LIGHT' },
  },
};

export default config;
