export interface GoEnvOptions {
  /** The module mirror (`mirrors.go`). */
  proxy?: string;
  /** The checksum database mirror (`mirrors.gosumdb`). */
  sumdb?: string;
  /** `GOPROXY=off`: resolving a `go tool` or `go mod` command must never download anything. */
  offline?: boolean;
}

/** `GOSUMDB` through the mirror, keeping the official public key (SPEC §10.2). */
export const goSumdb = (mirror: string): string => `sum.golang.org ${mirror}`;

/**
 * The environment of every Go run devguard starts (SPEC §3.2, §10.2): `GOTOOLCHAIN=local`, so Go never fetches another
 * toolchain, plus the mirrors, or `GOPROXY=off` for runs that must stay offline.
 */
export function goEnv({ proxy, sumdb, offline = false }: GoEnvOptions = {}): Record<string, string> {
  const env: Record<string, string> = { GOTOOLCHAIN: "local" };
  if (offline) env.GOPROXY = "off";
  else if (proxy !== undefined) env.GOPROXY = proxy;
  if (sumdb !== undefined) env.GOSUMDB = goSumdb(sumdb);
  return env;
}
