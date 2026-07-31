import esbuild from 'esbuild';
import process from 'node:process';

const production = process.argv.includes('production');
const watch = process.argv.includes('--watch');

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
  sourcemap: production ? false : 'inline',
  target: 'es2022',
});

if (watch) {
  await context.watch();
  console.log('Watching WeSight plugin sources...');
} else {
  await context.rebuild();
  await context.dispose();
}
