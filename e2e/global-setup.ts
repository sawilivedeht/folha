// @ts-expect-error módulo .mjs sem declarações de tipos
import { gerarFixtures } from './fixtures/make.mjs';

export default async function globalSetup(): Promise<void> {
  await gerarFixtures();
}
