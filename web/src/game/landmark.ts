// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// Face landmarker WORKER (#57): inference runs here, off the render thread, so
// head tracking can never inflate the frame times the dyn-res governor watches
// (a main-thread tracker could stamp a machine "too slow" with its own cost).
// The CPU (WASM-SIMD) delegate is deliberate: the GPU delegate would contend
// with the renderer — our scarce resource — while a spare CPU core usually
// costs nothing. Frames arrive as transferred ImageBitmaps at camera rate and
// are closed here after inference; poses go back as tiny messages.
//
// Protocol in:  {kind:'init', base, model}   wasm directory URL + model URL
//               {kind:'frame', bitmap, at}   transferred ImageBitmap + ms clock
// Protocol out: {kind:'ready'} | {kind:'dead', message}
//               {kind:'pose', ok, yaw, pitch, x, y, z, at}   radians / metres-ish

import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'

let landmarker: FaceLandmarker | null = null

self.onmessage = (event: MessageEvent) => {
  const data = event.data as { kind: string; base?: string; model?: string; bitmap?: ImageBitmap; at?: number }
  if (data.kind === 'init') {
    FilesetResolver.forVisionTasks((data.base as string).replace(/\/$/, ''))   // the resolver appends '/<file>' itself — a trailing slash 404s as '//'
      .then((files) =>
        FaceLandmarker.createFromOptions(files, {
          baseOptions: { modelAssetPath: data.model as string, delegate: 'CPU' },
          runningMode: 'VIDEO',
          numFaces: 1,
          outputFacialTransformationMatrixes: true,
          outputFaceBlendshapes: false,
        })
      )
      .then((made) => {
        landmarker = made
        self.postMessage({ kind: 'ready' })
      })
      .catch((error: unknown) => {
        self.postMessage({ kind: 'dead', message: String(error) })
      })
    return
  }
  if (data.kind === 'frame') {
    const bitmap = data.bitmap as ImageBitmap
    try {
      if (!landmarker) return
      const result = landmarker.detectForVideo(bitmap, data.at as number)
      const matrix = result.facialTransformationMatrixes?.[0]?.data
      if (!matrix) {
        self.postMessage({ kind: 'pose', ok: false, at: data.at })
        return
      }
      // Column-major 4x4 face-to-camera transform. The face's local axes in
      // camera space are the first three columns; yaw and pitch fall out of
      // where the face's +z (out of the face, toward the camera when facing
      // it) points. Signs are chosen so that the PLAYER turning left (their
      // face z swinging toward THEIR left, which is camera +x in the
      // unmirrored image) yields positive yaw, and looking up positive pitch.
      const zx = matrix[8], zy = matrix[9], zz = matrix[10]
      const yaw = Math.atan2(zx, zz)
      const pitch = Math.atan2(zy, Math.hypot(zx, zz))
      self.postMessage({
        kind: 'pose',
        ok: true,
        yaw,
        pitch,
        x: matrix[12],
        y: matrix[13],
        z: matrix[14],
        at: data.at,
      })
    } finally {
      try { bitmap.close() } catch { /* transferred bitmaps are ours to close */ }
    }
  }
}
