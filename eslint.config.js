import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';

export default [
  js.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
      },
      globals: {
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        localStorage: 'readonly',
        navigator: 'readonly',
        KeyboardEvent: 'readonly',
        HTMLElement: 'readonly',
        HTMLSelectElement: 'readonly',
        HTMLAnchorElement: 'readonly',
        HTMLButtonElement: 'readonly',
        HTMLImageElement: 'readonly',
        HTMLVideoElement: 'readonly',
        HTMLDivElement: 'readonly',
        HTMLInputElement: 'readonly',
        React: 'readonly',
        EventTarget: 'readonly',
        Element: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      ...reactPlugin.configs.recommended.rules,
      ...reactHooksPlugin.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      // #119: window.confirm/alert/prompt は tauri_plugin_dialog が Promise 版に差し替えて
      // おり（dialog 権限は付与しない、#93）、Promise は常に truthy で確認が素通りする。
      // 確認は src/lib/confirmDialog.ts の confirmDialog() を await する。
      'no-restricted-globals': [
        'error',
        ...['confirm', 'alert', 'prompt'].map((name) => ({
          name,
          message: 'window.confirm/alert/prompt は使用禁止（#119）。confirmDialog() を使う。',
        })),
      ],
      // JS 側の dialog API（ask/message/confirm 等）は dialog 権限が無く動かない（#93/#119）。
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@tauri-apps/plugin-dialog', '@tauri-apps/plugin-dialog/*'],
              message: 'JS 側の dialog API は使用禁止（#119）。確認は confirmDialog() を使う。',
            },
          ],
        },
      ],
      'no-restricted-properties': [
        'error',
        ...['confirm', 'alert', 'prompt'].flatMap((property) =>
          ['window', 'globalThis', 'self', 'top', 'parent'].map((object) => ({
            object,
            property,
            message: 'window.confirm/alert/prompt は使用禁止（#119）。confirmDialog() を使う。',
          })),
        ),
      ],
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
  },
  {
    // e2e/ は playwright-core を使う Node スクリプト＋ブラウザへ注入する素の
    // JSで、srcのReact/TS向けESLint設定（globals・rules）の対象外（#65レビュー）。
    ignores: ['dist', 'node_modules', 'src-tauri', 'e2e'],
  },
];
