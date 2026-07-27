// @ts-check
/** @type {import('eslint').Linter.FlatConfig[]} */
export default [
  {
    ignores: ['**/node_modules/**', '**/public/jsframe*.js'],
  },
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 2025,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        globalThis: 'readonly',
        // Node/Browser environment globals used at runtime (not module-level)
        module: 'readonly',
        exports: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        assert: 'readonly',
        // Browser DOM globals used across the codebase
        window: 'readonly',
        document: 'readonly',
        fetch: 'readonly',
        Headers: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        EventTarget: 'readonly',
        clearInterval: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        setTimeout: 'readonly',
        // Third-party globals loaded via script tags (not module imports)
        JSFrame: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty-function': 'warn',
      'no-var': 'error',
      eqeqeq: ['warn', 'always'],
      'prefer-const': 'error',
      'prefer-template': 'error',
    },
  },
  {
    files: ['public/**/*.{js,mjs}'],
    rules: {

    },
  },
];
