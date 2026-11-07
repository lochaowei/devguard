/**
 * The environment of every Go run devguard starts (SPEC §3.2): `GOTOOLCHAIN=local`, so Go never fetches another
 * toolchain, plus `GOPROXY=off` for runs that must stay offline. Where modules come from otherwise is the developer's
 * own Go configuration (`go env -w GOPROXY=...`).
 */
export function goEnv({ offline = false }: { offline?: boolean } = {}): Record<string, string> {
  return offline ? { GOTOOLCHAIN: "local", GOPROXY: "off" } : { GOTOOLCHAIN: "local" };
}
