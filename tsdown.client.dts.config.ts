import { defineConfig } from 'tsdown'

/** Emit `lib/client.d.ts` for the browser half (types ship separately from the wrapped CJS bundle). */
export default defineConfig({
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  dts: true,
  clean: false,
})
