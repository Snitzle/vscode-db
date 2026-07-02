// Builds the extension host (Node/CJS -> dist/extension.js) and the webview
// assets (browser/IIFE -> dist/*.js|css) with esbuild. Type-checking is
// separate: `tsc --noEmit` (see the check-types / watch:types scripts).
//
// Flags:
//   --watch       incremental rebuilds (used by the F5 background task)
//   --serve       watch + serve the repo root so dev/ harness pages get live reload
//   --production  minified output, no sourcemaps (used by vscode:prepublish)
const esbuild = require('esbuild');

const serve = process.argv.includes('--serve');
const watch = process.argv.includes('--watch') || serve;
const production = process.argv.includes('--production');

const SERVE_PORT = 8378;

// Emits the "[watch] build started/finished" lines that the
// connor4312.esbuild-problem-matchers $esbuild-watch matcher parses, collapsed
// across both contexts so VS Code sees one begin/end pair per rebuild wave.
let activeBuilds = 0;
const problemMatcherPlugin = {
  name: 'problem-matcher',
  setup(build) {
    build.onStart(() => {
      activeBuilds += 1;
      if (activeBuilds === 1) {
        console.log('[watch] build started');
      }
    });
    build.onEnd((result) => {
      for (const error of result.errors) {
        console.error(`✘ [ERROR] ${error.text}`);
        if (error.location) {
          console.error(`    ${error.location.file}:${error.location.line}:${error.location.column}:`);
        }
      }
      activeBuilds = Math.max(0, activeBuilds - 1);
      if (activeBuilds === 0) {
        console.log('[watch] build finished');
      }
    });
  },
};

/** @type {import('esbuild').BuildOptions} */
const extensionOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: ['node18'],
  // 'vscode' is provided by the runtime; sqlite3/mysql2 are native and must
  // resolve from node_modules, so keep all bare imports external.
  packages: 'external',
  outfile: 'dist/extension.js',
  minify: production,
  sourcemap: !production,
  logLevel: 'silent',
  plugins: [problemMatcherPlugin],
};

/** @type {import('esbuild').BuildOptions} */
const webviewOptions = {
  entryPoints: ['media/tablePanel.js', 'media/main.js'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  outdir: 'dist',
  minify: production,
  sourcemap: production ? false : 'inline',
  logLevel: 'silent',
  plugins: [problemMatcherPlugin],
  loader: {
    '.css': 'css',
    '.png': 'dataurl',
    '.svg': 'dataurl',
    '.gif': 'dataurl',
    '.woff': 'dataurl',
    '.woff2': 'dataurl',
    '.ttf': 'dataurl',
  },
};

async function main() {
  const extensionCtx = await esbuild.context(extensionOptions);
  const webviewCtx = await esbuild.context(webviewOptions);

  if (watch) {
    await Promise.all([extensionCtx.watch(), webviewCtx.watch()]);

    if (serve) {
      // Serving the repo root lets dev/*.html reference /dist and /media, and
      // exposes esbuild's /esbuild SSE endpoint for live reload.
      const { port } = await webviewCtx.serve({ servedir: '.', port: SERVE_PORT });
      console.log(`[serve] harness: http://localhost:${port}/dev/table.html · /dev/explorer.html`);
    }

    console.log('[esbuild] watching...');
  } else {
    await Promise.all([extensionCtx.rebuild(), webviewCtx.rebuild()]);
    await Promise.all([extensionCtx.dispose(), webviewCtx.dispose()]);
    console.log('[esbuild] build complete.');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
