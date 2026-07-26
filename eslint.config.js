// @ts-check
/** @type {import('eslint').Linter.Config} */
module.exports = [
  {
    files: ['*.js'],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'commonjs',
      globals: {
        console: 'readonly',
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        process: 'readonly'
      }
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty-function': 'warn'
    }
  }
];
