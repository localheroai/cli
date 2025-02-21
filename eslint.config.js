import pluginJs from "@eslint/js";
import globals from "globals";

export default [
    pluginJs.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                ...globals.node,  // Includes process, Buffer, console, etc.
                ...globals.browser  // Includes fetch, URL, URLSearchParams, etc.
            }
        },
        rules: {
            'no-console': 'off',
            'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
            'prefer-const': 'error',
            'object-shorthand': ['error', 'always'],
            'no-var': 'error'
        }
    },
    {
        files: ['**/*.test.js'],
        languageOptions: {
            globals: {
                ...globals.jest  // Includes test, expect, beforeEach, etc.
            }
        }
    }
];
