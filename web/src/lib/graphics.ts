// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// Graphics capability diagnosis (#55). The engine is THREE r160 on WebGL2, and
// the silent killer below that is the software fallback (SwiftShader, llvmpipe,
// Microsoft Basic Render), where the context creates fine and the game crawls.
// The frame-time governor only judges the machine when the verdict here is
// clear.

export type Verdict = 'webgl2' | 'software' | null

// diagnose probes a fresh context; the factory parameter exists for tests.
export function diagnose(
  create: () => unknown = () => document.createElement('canvas').getContext('webgl2')
): Verdict {
  let gl: WebGL2RenderingContext | null
  try {
    gl = create() as WebGL2RenderingContext | null
  } catch {
    gl = null
  }
  if (!gl) return 'webgl2'
  try {
    const info = gl.getExtension('WEBGL_debug_renderer_info') as { UNMASKED_RENDERER_WEBGL: number } | null
    const name = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))
    if (/swiftshader|llvmpipe|software|basic render/i.test(name)) return 'software'
  } catch {
    // The renderer name is unreadable — assume accelerated rather than warn on a guess.
  }
  return null
}
