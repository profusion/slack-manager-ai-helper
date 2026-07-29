import { chmodSync, readFileSync, rmSync } from 'node:fs';
import * as esbuild from 'esbuild';

const BUNDLE_DIR = 'dist/bundle';
const BUNDLE_PATH = `${BUNDLE_DIR}/slack-manager-ai-helper.mjs`;
const SHEBANG = '#!/usr/bin/env node';

rmSync(BUNDLE_DIR, { recursive: true, force: true });

await esbuild.build({
  outdir: BUNDLE_DIR,
  outExtension: { '.js': '.mjs' },
  platform: 'node',
  format: 'esm',
  target: 'node26.4.0',
  bundle: true,
  minify: true,
  legalComments: 'none',
  logLevel: 'info',
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
  entryPoints: {
    'slack-manager-ai-helper': 'src/slack-manager-ai-helper.ts',
  },
});

const bundle = readFileSync(BUNDLE_PATH, 'utf8');
if (!bundle.startsWith(`${SHEBANG}\n`)) {
  throw new Error(`Expected ${BUNDLE_PATH} to start with ${SHEBANG}`);
}
if (bundle.indexOf(SHEBANG, SHEBANG.length) !== -1) {
  throw new Error(`Expected ${BUNDLE_PATH} to contain only one shebang`);
}
chmodSync(BUNDLE_PATH, 0o755);

console.log(`Wrote minified CLI bundle to ${BUNDLE_DIR}/`);
