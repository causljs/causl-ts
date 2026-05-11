import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default [
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'tools/checker/target/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['packages/react/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2022,
      },
    },
  },
  // SPEC §17.4 / EPIC #295 sub-issue #291 — every discriminated-union
  // switch under packages/*/src must cover all variants or end with a
  // call to `assertNever` (default arm narrowed to `never`). The
  // canonical `@typescript-eslint/switch-exhaustiveness-check` rule
  // implements the contract and runs against type-aware lint metadata.
  // Scoped to source — generated dist and tests are exempt.
  {
    files: ['packages/*/src/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: true },
      ],
    },
  },
  // SPEC §17 commitment 3 / issue #393 — the §7 layering (information
  // model / editor-controller / engine substrate) is enforced at the
  // package boundary. `@causl/core` is the engine substrate and
  // must not import from any sibling adapter package — doing so would
  // either invert the layering (engine reaching into controller) or
  // create the kind of two-way coupling that lets controller-shaped
  // types leak back into the core barrel.
  //
  // Mechanism: `no-restricted-imports` with patterns covering every
  // current sibling adapter. Tests under `packages/core/test` are
  // included — fixtures often `createCausl()` against the engine,
  // never against an adapter, so the same gate applies.
  //
  // The fixture in `tools/lint-fixtures/core-illegal-import.ts.fixture`
  // is the negative test: it deliberately violates the rule and is
  // covered by `tools/lint-fixtures/test/layering.test.ts`. It carries
  // a `.fixture` suffix so production lint globs (`src/**/*.ts`,
  // `test/**/*.ts`) never see it as a real source file.
  {
    files: ['packages/core/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@causl/react',
                '@causl/react/*',
                '@causl/sync',
                '@causl/sync/*',
                '@causl/persistence',
                '@causl/persistence/*',
                '@causl/devtools',
                '@causl/devtools/*',
                '@causl/devtools-bridge',
                '@causl/devtools-bridge/*',
                '@causl/formula',
                '@causl/formula/*',
                '@causl/checker',
                '@causl/checker/*',
                '@causl/bench',
                '@causl/bench/*',
                '@causl/migration-check',
                '@causl/migration-check/*',
              ],
              message:
                'SPEC §17.3 / §7: `@causl/core` is the engine substrate and must not import from sibling adapter packages. Move the shared symbol into core or invert the dependency.',
            },
          ],
        },
      ],
    },
  },
  // SPEC §12.3 seam — adapter packages may reach engine internals
  // ONLY through the documented `@causl/core/internal` entrypoint.
  // Deeper paths (`@causl/core/dist/...`, `@causl/core/src/...`)
  // are forbidden: they bypass the package's `exports` map and break
  // the SemVer guarantee that the public + internal surfaces are the
  // only stable contracts.
  //
  // The `exports` field in `packages/core/package.json` already
  // refuses to resolve such paths at runtime; this rule codifies the
  // same contract at lint time so a future bundler / tsconfig change
  // cannot silently re-open the back door. Scoped to every adapter so
  // the rule does not need a per-package re-declaration.
  {
    files: [
      'packages/react/**/*.{ts,tsx}',
      'packages/sync/**/*.{ts,tsx}',
      'packages/persistence/**/*.{ts,tsx}',
      'packages/devtools/**/*.{ts,tsx}',
      'packages/devtools-bridge/**/*.{ts,tsx}',
      'packages/formula/**/*.{ts,tsx}',
      'packages/checker/**/*.{ts,tsx}',
      'packages/bench/**/*.{ts,tsx}',
      'packages/migration-check/**/*.{ts,tsx}',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@causl/core/dist',
                '@causl/core/dist/*',
                '@causl/core/src',
                '@causl/core/src/*',
              ],
              message:
                'SPEC §12.3: adapters may reach engine internals only through the `@causl/core/internal` seam — never through dist/ or src/ deep paths.',
            },
          ],
        },
      ],
    },
  },
];
