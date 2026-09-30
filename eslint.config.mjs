// ESLint flat config for the server (src/) and its tests (test/).
// The client keeps its own Create React App config (client/package.json).
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['build/**', 'public/**', 'client/**', 'data/**', '.test-build/**', 'node_modules/**']
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node
    },
    rules: {
      // Existing code uses `any` at Sequelize/Express boundaries.
      '@typescript-eslint/no-explicit-any': 'off',
      // Sequelize creation-attribute interfaces extend Optional<...> {}.
      '@typescript-eslint/no-empty-object-type': ['error', { allowInterfaces: 'with-single-extends' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { args: 'none', ignoreRestSiblings: true, caughtErrors: 'none' }
      ]
    }
  }
);
