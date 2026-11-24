import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.folha.leitor',
  appName: 'Folha',
  webDir: 'dist',
  android: { allowMixedContent: false },
};

export default config;
