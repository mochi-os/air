// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The filled Button variant is a dialog's one primary action. A button that
// switches to it to say "this option is in force" puts a second primary
// beside Done or Fly; a selected option is an outline button with a primary
// tint and aria-pressed.
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.tsx$/.test(entry) ? [path] : []
  })

describe('a selected option', () => {
  it('is never drawn with the filled variant', () => {
    const files = sources(root)
    expect(files.length).toBeGreaterThan(5)
    const filled: string[] = []
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      for (const found of source.matchAll(
        /variant=\{[^}]*\?\s*'default'\s*:[^}]*\}|variant=\{[^}]*:\s*'default'\s*\}/g
      ))
        filled.push(`${file.slice(root.length + 1)}: ${found[0]}`)
    }
    expect(filled).toEqual([])
  })
})
