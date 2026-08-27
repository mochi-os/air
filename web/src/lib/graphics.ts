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

// release hands the probed context back. A WebGL context is not freed when the
// canvas holding it is dropped: it lives until garbage collection, and browsers
// allow only about sixteen live ones per page, force-losing the OLDEST when a
// new one passes that. The oldest is never this probe. Once the player is
// flying it is the game's own context, so a probe that does not let go can take
// the mission down.
function release(gl: WebGL2RenderingContext): void {
  try {
    const lose = gl.getExtension('WEBGL_lose_context') as { loseContext?: () => void } | null
    lose?.loseContext?.()
  } catch {
    // No extension, or a context that refuses to be lost. Nothing else to try.
  }
}

function probe(create: () => unknown): Verdict {
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
  } finally {
    release(gl)
  }
  return null
}

// What the hardware is cannot change inside a session, so a verdict reached
// against a real context is kept. The menu unmounts and remounts on every trip
// out to flight, and probing per mount was one context handed over per sortie.
let answer: { verdict: Verdict } | null = null

// diagnose probes a fresh context; the factory parameter exists for tests, and
// a caller supplying one neither reads nor writes the kept answer.
export function diagnose(create?: () => unknown): Verdict {
  if (create) return probe(create)
  if (answer) return answer.verdict
  const verdict = probe(() => document.createElement('canvas').getContext('webgl2'))
  if (verdict !== 'webgl2') answer = { verdict }
  return verdict
}
