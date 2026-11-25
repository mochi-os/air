// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import configuration from '@mochi/web/configuration/eslint'

export default configuration(
  {
    directory: import.meta.dirname,
    ignores: ['tools'],
    strings: [
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
      '^(Sketchfab|Copernicus|OpenStreetMap|NOAA NCCOS|NOAA NCEI|NASA SVS|JPL Horizons|Unity Labs|CC BY 4\\.0)$',
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
    functions: ['*.getObjectByName', '*.getExtension'],
  },
  {
    // The game/ layer is the Three.js + WASM engine and wire protocol, not
    // React UI: no Lingui for canvas text or protocol tokens, untyped interop
    // allowed, engine.ts is @ts-nocheck. console.warn/error allowed,
    // console.log still banned. Must come after the i18n block to win for these
    // files.
    files: ['src/game/**/*.{ts,tsx}'],
    rules: {
      'lingui/no-unlocalized-strings': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    // The model viewer (/air/models) is a developer page, English only by
    // decision. Must come after the i18n block to win for these files.
    files: ['src/components/ModelViewer.tsx', 'src/routes/models.tsx'],
    rules: {
      'lingui/no-unlocalized-strings': 'off',
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
