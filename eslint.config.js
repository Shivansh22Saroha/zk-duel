// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'circuits/build/**',
      'circuits/test/build/**',
      'server/data/**',
      'bench/out/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // Renderer seam (client/src/game/view.ts): renderers draw a RenderFrame and nothing else.
    files: ['client/src/game/renderer*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@zkduel/shared/sim', '@zkduel/shared/protocol'],
              message: 'Renderers must not depend on game rules or the protocol.',
            },
            {
              group: ['./session', './input', './bot', '../net/*', '../api'],
              message: 'Renderers only consume RenderFrame (view.ts).',
            },
          ],
        },
      ],
    },
  },
);
