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
    // air carries no unwrapped strings outside the exemptions below — promote
    // the rule from warn to error so any new untranslated literal fails CI
    // immediately.
    rules: {
      ...i18nConfig.rules,
      'lingui/no-unlocalized-strings': [
        'error',
        {
          ...i18nConfig.rules['lingui/no-unlocalized-strings'][1],
          ignore: [
            ...i18nConfig.rules['lingui/no-unlocalized-strings'][1].ignore,
            // Physical keyboard key labels shown in the control legends (the
            // GameCanvas help panel, MissionSetup ControlRows) and the "Shift+"
            // chord prefix — printed key names, not translatable UI prose.
            '^(W/S|A/D|Q/E|Space|Enter|Esc|Shift)$',
            '^Shift\\+',
            // Internal keybinding sentinels compared in the rebind logic (the
            // display maps them through pretty()/<Trans>), and the app name.
            '^(None|Vertical)$',
            '^Air$',
            // The ATC advisory annunciation: the control legend's label
            // (GameCanvas) quotes the glyph the HUD itself draws, verbatim.
            '^ATC$',
            // Attribution link labels in the credits: platform / data-source
            // proper nouns and a license identifier — brand names kept verbatim
            // (the glossary guard requires it), not translatable prose.
            '^(Sketchfab|Copernicus|OpenStreetMap|NOAA NCCOS|CC BY 4\\.0)$',
            // Missile designations in the loadout summary, alone or with a
            // count ("AIM-9M", "2× AIM-120C") — military type numbers, printed
            // as the jet prints them, like the Reference dialog's V-speeds.
            '^(?:\\d+× )?AIM-\\d+[A-Z]?(?: \\+ AIM-\\d+[A-Z]?)?$',
            // The stores presets are named for the brevity call they arm
            // ("Fox 2"), and the mission summary appends a brevity acronym
            // after a separator (" · BVR"). Radio brevity, not prose.
            '^Fox \\d$',
            '^\\s*·\\s*[A-Z0-9]+$',
            // Joystick profile names in lib/config.ts, matched against what the
            // HID layer reports — device names, never shown as translated text.
            '^(?:Turtle Beach VelocityOne Flightstick|Standard gamepad|Generic joystick)$',
          ],
          // Asset and API identifiers, not UI text: three.js scene-graph node
          // lookups ('Missile_3') and WebGL extension names.
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
    // Test fixtures quote wire payloads and designations verbatim ('AIM-9M' in
    // an ACMI record); wrapping them would change what is under test.
    files: ['**/*.{test,spec}.{ts,tsx}'],
    rules: {
      'lingui/no-unlocalized-strings': 'off',
    },
  },
  {
    // The game/ layer is the Three.js + WASM flight engine and the wire
    // protocol, not React UI. Lingui (React i18n) does not apply to text drawn
    // to the WebGL canvas or to protocol tokens/error codes; the WASM and Three
    // interop is inherently untyped; and engine.ts is intentionally @ts-nocheck.
    // Console keeps warn/error for genuine engine diagnostics but still bans
    // stray console.log. Ordinary hygiene (unused vars, const, empty blocks)
    // stays enforced here. Must come after the i18n block to win for these files.
    files: ['src/game/**/*.{ts,tsx}'],
    rules: {
      'lingui/no-unlocalized-strings': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    // GameCanvas is the engine's React host: it reports asset, WebGL and
    // transport failures the same way game/ does, so it gets the same
    // warn/error allowance — and the same ban on stray console.log.
    files: ['src/components/GameCanvas.tsx'],
    rules: {
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  }
)
