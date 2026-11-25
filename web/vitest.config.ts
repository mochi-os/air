// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import configuration from '@mochi/web/configuration/vitest'
import { sizes } from './sizes'

export default configuration({
  directory: __dirname,
  environment: 'node',
  plugins: [sizes()],
})
