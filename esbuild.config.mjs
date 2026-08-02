import esbuild from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const production = process.argv.includes('production');
const watch = process.argv.includes('--watch');

const rawTextPlugin = {
  name: 'raw-text',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, args => ({
      path: path.resolve(args.resolveDir, args.path.slice(0, -4)),
      namespace: 'raw-text',
    }));
    build.onLoad({ filter: /.*/, namespace: 'raw-text' }, async args => ({
      contents: await fs.readFile(args.path, 'utf8'),
      loader: 'text',
    }));
  },
};

const context = await esbuild.context({
  banner: {
    js: '/* WeSight Obsidian plugin */',
  },
  bundle: true,
  entryPoints: ['src/main.ts'],
  external: [
    'obsidian',
    'electron',
    '@codemirror/autocomplete',
    '@codemirror/collab',
    '@codemirror/commands',
    '@codemirror/language',
    '@codemirror/lint',
    '@codemirror/search',
    '@codemirror/state',
    '@codemirror/view',
    '@lezer/common',
    '@lezer/highlight',
    '@lezer/lr'
  ],
  format: 'cjs',
  logLevel: 'info',
  loader: {
    '.png': 'dataurl',
  },
  minify: production,
  outfile: 'main.js',
  platform: 'node',
  plugins: [rawTextPlugin],
  sourcemap: production ? false : 'inline',
  target: 'es2022',
});

if (watch) {
  await context.watch();
  process.stdout.write('Watching WeSight plugin sources...\n');
} else {
  await context.rebuild();
  await context.dispose();
}
