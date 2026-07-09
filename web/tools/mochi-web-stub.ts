// Stub for @mochi/web when running the interp-smoothness harness under Node.
// net.ts / flight.ts import these only for the lobby + error helpers, which the
// remote-aircraft interpolation under test never calls; the real UI package
// drags in the lingui/react macro chain that can't load outside the browser.
export function createAppClient() {
  return {}
}
export function getErrorMessage(_error: unknown, fallback: string) {
  return fallback
}
