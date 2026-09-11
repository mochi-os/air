// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// A className template must never butt one interpolation straight against the
// next. Class names are whitespace-separated, so `${a}${b}` yields one glued
// token — and the separator cannot live as a leading space inside a quoted
// class string, because prettier-plugin-tailwindcss trims those when it sorts.
// That is exactly what happened on 2026-09-11: the app-wide reformat turned
// `${wide ? 'sm:max-w-4xl' : …}${steady ? ' h-[…]' : ''}` into
// `sm:max-w-4xlh-[…]`, and the Create mission dialog silently fell back to the
// default width. Build the list and join it instead.
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry) ? [path] : []
  })

// Every className={`…`} template in the file, found by walking to the closing
// backtick so a template spanning several lines is read whole.
const templates = (source: string) => {
  const found: string[] = []
  for (const opening of source.matchAll(/className=\{`/g)) {
    const start = opening.index + opening[0].length
    const end = source.indexOf('`', start)
    if (end > start) found.push(source.slice(start, end))
  }
  return found
}

describe('className templates separate their parts', () => {
  const files = sources(root)

  it('finds the components to scan', () => {
    expect(files.length).toBeGreaterThan(5)
  })

  it('has no interpolation butted against the next', () => {
    const glued: string[] = []
    for (const file of files) {
      for (const template of templates(readFileSync(file, 'utf8'))) {
        // Nothing at all between them. Any whitespace is a valid separator,
        // a newline in the literal text included, so only the bare join is a
        // fault — and a newline INSIDE an interpolation is not literal text.
        if (template.includes('}${')) {
          glued.push(`${file.slice(root.length + 1)}: ${template.trim()}`)
        }
      }
    }
    expect(glued).toEqual([])
  })
})
