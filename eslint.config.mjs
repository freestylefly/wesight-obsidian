import js from '@eslint/js';
import obsidianmd from 'eslint-plugin-obsidianmd';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: ['main.js', 'node_modules/**', 'dist/**'],
  },
  ...obsidianmd.configs.recommended,
  {
    ...js.configs.recommended,
    files: ['**/*.{js,cjs,mjs,jsx}'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'off',
      'obsidianmd/ui/sentence-case': ['warn', {
        acronyms: ['API', 'CLI', 'ID', 'IP', 'JSON', 'QR', 'URL'],
        brands: ['AppID', 'AppSecret', 'Canghe Style', 'Claude Code', 'Feishu', 'Obsidian', 'OpenCode', 'WeSight'],
      }],
      'obsidianmd/settings-tab/prefer-setting-definitions': 'off',
    },
  },
];
