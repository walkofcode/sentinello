import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettierConfig from 'eslint-config-prettier'

export default [
    {
        ignores: [
            '**/dist/**',
            '**/.next/**',
            '**/node_modules/**',
            '**/drizzle/**',
            '**/*.config.js',
            '**/*.config.cjs',
            '**/*.config.mjs',
            '**/.turbo/**',
            'eslint.config.mjs'
        ]
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    prettierConfig,
    {
        files: ['**/*.ts'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module'
        },
        rules: {
            '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
            '@typescript-eslint/no-explicit-any': 'warn',
            'no-console': 'off'
        }
    }
]
