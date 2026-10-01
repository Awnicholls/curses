import eslintPluginUnicorn from 'eslint-plugin-unicorn';
import eslintConfigPrettier from 'eslint-config-prettier';
import eslint from '@eslint/js';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import perfectionist from 'eslint-plugin-perfectionist';
import globals from 'globals';
import unusedImports from 'eslint-plugin-unused-imports';
import reactPlugin from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import jsxA11y from 'eslint-plugin-jsx-a11y';

export default tseslint.config(
  eslint.configs.recommended,
  {
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      tseslint.configs.stylistic,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        project: ['./tsconfig.app.json', './tsconfig.node.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'unused-imports': unusedImports,
    },
  },
  eslintPluginUnicorn.configs['flat/recommended'],
  {
    rules: {
      'no-unused-vars': 'off', // or "@typescript-eslint/no-unused-vars": "off",
      'unused-imports/no-unused-imports': 'error',
      'unicorn/no-array-reverse': 'off',
      'unicorn/prefer-top-level-await': 'off',
      'unicorn/better-regex': 'error',
      'unicorn/prevent-abbreviations': 'off',
      'unicorn/no-null': 'off',
      'unicorn/no-useless-undefined': 'off',
      'unicorn/no-array-for-each': 'off',
      'unicorn/no-array-callback-reference': 'off',
      'unicorn/catch-error-name': 'off',
      'unicorn/prefer-node-protocol': 'off',
      'unicorn/no-nested-ternary': 'off',
      'unicorn/no-abusive-eslint-disable': 'off',
      'unicorn/expiring-todo-comments': 'off',
      'unicorn/filename-case': 'off',
      // Off: these autofix by renaming identifiers, which leaks into prop
      // and API shapes across files.
      'unicorn/consistent-boolean-name': 'off',
      'unicorn/name-replacements': 'off',
    },
  },
  reactPlugin.configs.flat.recommended,
  reactPlugin.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        // Pinned rather than 'detect': eslint-plugin-react's version
        // detection calls context.getFilename(), removed in ESLint 10.
        version: '19.2',
      },
    },
  },
  reactHooks.configs.flat['recommended-latest'],
  reactRefresh.configs.vite,
  jsxA11y.flatConfigs.recommended,
  {
    rules: {
      // TODO make error
      '@typescript-eslint/no-unnecessary-type-conversion': 'warn',
      // TODO make error
      '@typescript-eslint/await-thenable': 'warn',
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression',
          message: 'Dynamic import() is not allowed.',
        },
      ],
      // Numbers stringify unambiguously; the rule is here to catch objects,
      // null and undefined landing in a template.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true },
      ],
      '@typescript-eslint/prefer-nullish-coalescing': 'warn',
      '@typescript-eslint/return-await': 'warn',
      '@typescript-eslint/dot-notation': 'off',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      'no-return-await': 'error',
      'arrow-body-style': ['error', 'as-needed'],
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'no-negated-condition': 'error',
      'no-await-in-loop': 'warn',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
        },
      ],
      'no-console': 'warn',
      eqeqeq: ['error', 'always'],
      curly: ['error', 'all'],
      'no-implicit-coercion': 'error',
      'prefer-const': 'error',
      'no-var': 'error',
      '@typescript-eslint/explicit-function-return-type': [
        'warn',
        {
          allowExpressions: true,
          allowTypedFunctionExpressions: true,
        },
      ],
    },
  },
  perfectionist.configs['recommended-alphabetical'],
  {
    ignores: [
      'dist',
      'node_modules',
      'README.md',
      'eslint.config.mjs',
      '.yarn/**',
    ],
  },
  eslintConfigPrettier
);
