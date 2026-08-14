import { defineConfig } from 'tsdown'

/**
 * Consumer-side build for git installs (the `prepare` script): transpile
 * straight from src, no type declarations (not needed at runtime), so
 * `dsh plugin add github:you/dsh-smarthome` works without a separate build
 * step. Type checking stays a dev/CI concern (`pnpm typecheck`).
 */
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  tsconfig: 'tsconfig.prepare.json',
})
