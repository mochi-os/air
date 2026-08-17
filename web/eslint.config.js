// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { fileURLToPath } from 'url'
import { dirname } from 'path'
import globals from 'globals'
import js from '@eslint/js'
import pluginQuery from '@tanstack/eslint-plugin-query'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig } from 'eslint/config'
import i18nConfig from '@mochi/web/eslint-i18n-config'
import tseslint from 'typescript-eslint'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export default defineConfig(
  { ignores: ['dist', 'src/components/ui', 'tools'] },
  {
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
      ...pluginQuery.configs['flat/recommended'],
    ],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        project: ['./tsconfig.app.json', './tsconfig.node.json', './tsconfig.eslint.json'],
        tsconfigRootDir: __dirname,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      'no-console': 'error',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'all',
          argsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      // Enforce type-only imports for TypeScript types
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'inline-type-imports',
          disallowTypeAnnotations: false,
        },
      ],
      // Prevent duplicate imports from the same module
      'no-duplicate-imports': 'error',
      // Use wrapped toast/Toaster from @mochi/web
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'sonner',
              message: "Import toast/Toaster from '@mochi/web' instead.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/routes/**/*.{ts,tsx}', 'src/context/**/*.{ts,tsx}', 'src/test/**/*.{ts,tsx}'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    ...i18nConfig,
    // notifications has zero unwrapped strings — promote the rule from
    // warn to error so any new untranslated literal fails CI immediately.
    rules: {
      ...i18nConfig.rules,
      'lingui/no-unlocalized-strings': [
        'error',
        {
          ...i18nConfig.rules['lingui/no-unlocalized-strings'][1],
          ignore: [
            ...i18nConfig.rules['lingui/no-unlocalized-strings'][1].ignore,
            '^(W/S|A/D|Q/E|Space|Enter|Esc|Shift)$',
            '^Shift\\+',
            '^(None|Vertical)$',
            '^Air$',
            '^ATC$',
            '^(Sketchfab|Copernicus|OpenStreetMap|NOAA NCCOS|CC BY 4\\.0)$',
            '^(?:\\d+× )?AIM-\\d+[A-Z]?(?: \\+ AIM-\\d+[A-Z]?)?$',
            '^Fox \\d$',
            '^\\s*·\\s*[A-Z0-9]+$',
            '^(?:Turtle Beach VelocityOne Flightstick|Standard gamepad|Generic joystick)$',
          ],
          ignoreFunctions: [
            ...i18nConfig.rules['lingui/no-unlocalized-strings'][1].ignoreFunctions,
            '*.getObjectByName',
            '*.getExtension',
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.{test,spec}.{ts,tsx}'],
    rules: {
      'lingui/no-unlocalized-strings': 'off',
    },
  },
  {
    files: ['src/game/**/*.{ts,tsx}'],
    rules: {
      'lingui/no-unlocalized-strings': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['src/components/GameCanvas.tsx'],
    rules: {
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  }
)
