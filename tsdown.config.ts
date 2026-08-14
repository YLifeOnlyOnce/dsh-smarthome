import { defineConfig } from 'tsdown'

/**
 * Published build: bundle ESM plus type declarations. Runs on `pnpm build`
 * (npm publish time) so consumers installing from npm get prebuilt artifacts.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: true,
  clean: true,
  tsconfig: 'tsconfig.prepare.json',
})
