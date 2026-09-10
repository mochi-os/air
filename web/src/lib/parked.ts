// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// Catalogue entries for features that are parked rather than removed. The
// extraction runs with --clean, which drops every entry no source references,
// and the translations here would otherwise have to be redone in every locale
// when the feature returns. A plain module, not a component file, so fast
// refresh is untouched by the export.

import { msg } from '@lingui/core/macro'

// Head tracking (#57).
/** @public */
export const HEAD_MESSAGES = [msg`Head`, msg`Head tracking`, msg`Gain`, msg`Camera unavailable`]
