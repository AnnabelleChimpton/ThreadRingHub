module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true,
    jest: true,
  },
  extends: [
    'eslint:recommended',
    '@typescript-eslint/recommended',
    '@typescript-eslint/recommended-requiring-type-checking',
    'plugin:import/recommended',
    'plugin:import/typescript',
    'plugin:node/recommended',
    'plugin:security/recommended',
    'prettier',
  ],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    tsconfigRootDir: __dirname,
    project: ['./tsconfig.json', './apps/*/tsconfig.json', './packages/*/tsconfig.json'],
  },
  plugins: ['@typescript-eslint', 'import', 'node', 'security'],
  rules: {
    // TypeScript specific rules
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-non-null-assertion': 'error',
    '@typescript-eslint/prefer-nullish-coalescing': 'error',
    '@typescript-eslint/prefer-optional-chain': 'error',
    '@typescript-eslint/no-unnecessary-type-assertion': 'error',
    '@typescript-eslint/no-misused-promises': 'error',
    '@typescript-eslint/await-thenable': 'error',
    '@typescript-eslint/require-await': 'error',

    // Import rules
    'import/order': [
      'error',
      {
        groups: [
          'builtin',
          'external',
          'internal',
          'parent',
          'sibling',
          'index',
          'type',
        ],
        'newlines-between': 'always',
        alphabetize: {
          order: 'asc',
          caseInsensitive: true,
        },
      },
    ],
    'import/no-unresolved': 'error',
    'import/no-cycle': 'error',
    'import/no-self-import': 'error',

    // Node.js specific rules
    'node/no-missing-import': 'off', // Handled by TypeScript
    'node/no-unsupported-features/es-syntax': 'off', // We use TypeScript
    'node/no-unpublished-import': [
      'error',
      {
        allowModules: ['jest', 'supertest', '@types/jest'],
      },
    ],

    // Security rules
    'security/detect-object-injection': 'warn',
    'security/detect-non-literal-regexp': 'warn',
    'security/detect-unsafe-regex': 'error',

    // General best practices
    'no-console': 'warn',
    'no-debugger': 'error',
    'no-alert': 'error',
    'no-var': 'error',
    'prefer-const': 'error',
    'prefer-arrow-callback': 'error',
    'prefer-template': 'error',
    'object-shorthand': 'error',
    'no-duplicate-imports': 'error',
    'no-useless-rename': 'error',
    'no-useless-computed-key': 'error',

    // Error handling
    'no-throw-literal': 'error',
    'prefer-promise-reject-errors': 'error',

    // Code quality
    'complexity': ['warn', { max: 10 }],
    'max-depth': ['warn', { max: 4 }],
    'max-nested-callbacks': ['warn', { max: 3 }],
    'max-params': ['warn', { max: 4 }],
    'max-lines-per-function': ['warn', { max: 50, skipBlankLines: true, skipComments: true }],
  },
  settings: {
    'import/resolver': {
      typescript: {
        alwaysTryTypes: true,
        project: ['./tsconfig.json', './apps/*/tsconfig.json', './packages/*/tsconfig.json'],
      },
    },
    node: {
      tryExtensions: ['.js', '.ts', '.json'],
    },
  },
  overrides: [
    {
      files: ['**/*.test.ts', '**/*.spec.ts'],
      env: {
        jest: true,
      },
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-non-null-assertion': 'off',
        'max-lines-per-function': 'off',
        'security/detect-object-injection': 'off',
      },
    },
    {
      files: ['scripts/**/*.ts', 'scripts/**/*.js'],
      rules: {
        'no-console': 'off',
        'node/no-unpublished-import': 'off',
      },
    },
    {
      files: ['**/*.config.js', '**/*.config.ts'],
      rules: {
        'node/no-unpublished-import': 'off',
        '@typescript-eslint/no-var-requires': 'off',
      },
    },
  ],
};