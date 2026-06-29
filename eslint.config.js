import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', '.vendor/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 2024,
      globals: globals.node,
    },
  },
];
