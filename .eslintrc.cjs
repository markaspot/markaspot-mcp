/*
 * ESLint config (legacy eslintrc format).
 *
 * Matches the pinned toolchain: ESLint 8 + @typescript-eslint 6, both
 * eslintrc-native. Flat config (eslint.config.js) is intentionally NOT used —
 * the `lint` npm script relies on `--ext .ts`, a flag only the eslintrc engine
 * honors. Filename is `.cjs` (not `.js`) because package.json declares
 * `"type": "module"`, under which a `.eslintrc.js` would be loaded as ESM and
 * fail (eslintrc configs must be CommonJS).
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  env: {
    node: true,
    es2022: true,
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  // The lint script targets `src/` only; these guard the build/output dirs in
  // case the scope is ever widened to `eslint .`.
  ignorePatterns: ['dist/', 'node_modules/', 'coverage/'],
  rules: {
    // Allow intentionally-unused args/vars when prefixed with `_`
    // (factory/handler signatures keep params for shape even when unused).
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
    ],
    // Open311/GeoReport payloads are loosely typed at the network boundary;
    // `any` there is pragmatic, so surface it as a warning rather than block CI.
    '@typescript-eslint/no-explicit-any': 'warn',
  },
};
