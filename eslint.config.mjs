import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import nextPlugin from '@next/eslint-plugin-next'
import reactHooks from 'eslint-plugin-react-hooks'
import eslintReact from '@eslint-react/eslint-plugin'
import prettierConfig from 'eslint-config-prettier'

// The two Next.js apps. packages/*, apps/cli and apps/worker are Node-only and must never receive
// the React or Next blocks — scoping every one of them to this list is what keeps them out.
// Deliberately NOT eslint-config-next: it bundles eslint-plugin-react, -import and -jsx-a11y, all of
// which still declare minimatch ^3.1.2 (brace-expansion 1.x, permanently vulnerable) and cap their
// ESLint peer range at 9. See the KNOWN GAP note at the bottom.
const NEXT_APPS = ['apps/web/**/*.{ts,tsx}', 'apps/homepage/**/*.{ts,tsx}']

export default [
    {
        ignores: [
            '**/dist/**',
            '**/.next/**',
            // Next 16 writes the dev build here, separately from .next itself.
            '**/.next/dev/**',
            '**/node_modules/**',
            '**/drizzle/**',
            '**/*.config.js',
            '**/*.config.cjs',
            '**/*.config.mjs',
            '**/*.config.ts',
            '**/coverage/**',
            '**/.turbo/**',
            'eslint.config.mjs'
        ]
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,

    // Plain-JS maintenance scripts (packages/scanners/scripts/*.mjs). TypeScript files do not need
    // this — typescript-eslint's recommended set turns no-undef off for them because the compiler
    // already checks it — but js.configs.recommended leaves it on for JS, so the Node globals have
    // to be declared. Kept to the handful a Node script actually reaches for rather than pulling in
    // the whole `globals` package for one file; extend the list if a script needs more.
    {
        files: ['**/*.{js,mjs,cjs}'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: {
                console: 'readonly',
                process: 'readonly',
                Buffer: 'readonly',
                URL: 'readonly',
                URLSearchParams: 'readonly',
                TextEncoder: 'readonly',
                TextDecoder: 'readonly',
                AbortController: 'readonly',
                fetch: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly',
                setInterval: 'readonly',
                clearInterval: 'readonly',
                structuredClone: 'readonly',
                globalThis: 'readonly'
            }
        }
    },

    {
        files: ['**/*.{ts,tsx}'],
        languageOptions: {
            parser: tseslint.parser,
            ecmaVersion: 2024,
            sourceType: 'module',
            parserOptions: { ecmaFeatures: { jsx: true } }
        },
        rules: {
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }
            ],
            '@typescript-eslint/no-explicit-any': 'warn',
            'no-console': 'off'
        }
    },

    // Replaces eslint-plugin-react. 'recommended-typescript' is the TS-aware but NOT type-checked
    // variant, so it needs no parserOptions.projectService and costs no extra lint time.
    { files: NEXT_APPS, ...eslintReact.configs['recommended-typescript'] },

    // App Router correctness — 'use client' / 'use server' boundaries. No extra dependencies.
    { files: NEXT_APPS, ...eslintReact.configs.rsc },

    { files: NEXT_APPS, ...reactHooks.configs.flat.recommended },

    {
        files: NEXT_APPS,
        plugins: { '@next/next': nextPlugin },
        rules: {
            ...nextPlugin.configs.recommended.rules,
            ...nextPlugin.configs['core-web-vitals'].rules
        }
    },

    {
        files: NEXT_APPS,
        rules: {
            // react-hooks 7 (the React Compiler rules) and @eslint-react now cover the same ground.
            // Running both double-reported 20 identical locations. Keep the React-team-maintained
            // react-hooks/* versions and silence @eslint-react's duplicates.
            '@eslint-react/set-state-in-effect': 'off',
            '@eslint-react/purity': 'off',
            '@eslint-react/exhaustive-deps': 'off',

            // Both apps are pure App Router — there is no pages/ directory anywhere in the repo — so
            // this rule can never do anything except print "Pages directory cannot be found" to
            // stderr on every run. settings.next.rootDir would not help; there is nothing to find.
            '@next/next/no-html-link-for-pages': 'off',

            // Every hit is the deliberate SSR-safe hydration pattern: state starts at the
            // server-rendered default and an on-mount effect swaps in the client-only value
            // (localStorage, resolved theme, a mounted guard). Setting state in that effect IS the
            // mechanism that avoids a hydration mismatch, so the rule is inverted here — it cannot
            // see the intent. The call sites already carry comments explaining each case.
            // react-hooks/purity is deliberately left ON: its hits are Date.now() in async Server
            // Components, handled with narrow inline disables so the rule stays live for client code.
            'react-hooks/set-state-in-effect': 'off'
        }
    },

    // KNOWN GAP - accessibility linting is intentionally absent.
    // eslint-plugin-jsx-a11y is one of the three minimatch@3 offenders and caps its ESLint peer at 9.
    // The eslint-plugin-jsx-a11y-x fork is clean (minimatch ^10, ESLint 10 peer) but sits at v0.2.0
    // with low adoption - rejected as too immature for a repo running save-exact and a 7-day
    // minimum-release-age policy.
    // REVISIT WHEN: eslint-plugin-jsx-a11y ships a release declaring eslint ^10 and minimatch >=9,
    // or jsx-a11y-x reaches a stable 1.x. Check: npm view eslint-plugin-jsx-a11y peerDependencies

    // Must stay last: it turns off every stylistic rule the plugins above enable, leaving formatting
    // entirely to .prettierrc.
    prettierConfig
]
