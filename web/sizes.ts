// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import fs from 'fs'
import type { Plugin } from 'vite'

// A `?size` import of a file is its length in bytes as built: what a download
// of it decodes to, which a compressed response cannot say.
export function sizes(): Plugin {
  return {
    name: 'air-sizes',
    enforce: 'pre',
    load(id) {
      if (!id.endsWith('?size')) return null
      const file = id.slice(0, -'?size'.length)
      this.addWatchFile(file)
      // eslint-disable-next-line lingui/no-unlocalized-strings -- module source, never shown to users
      return `export default ${fs.statSync(file).size}`
    },
  }
}
