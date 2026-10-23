import { redact, sameUrl } from "../mirrors/common.ts";
import type { Finding } from "../report/finding.ts";
import type { EnvironmentCheck, EnvironmentContext } from "./types.ts";

function problem(rule: string, message: string, fix: string): Finding {
  return { level: "error", layer: "environment", rule: `mirrors/${rule}`, message, fix };
}

const mirror = (ctx: EnvironmentContext, key: string): string => {
  const value = ctx.resolution?.global[key]?.value;
  return typeof value === "string" ? value : "";
};

/** `go env GOPROXY GOSUMDB` as Go resolves them (environment, then the user's go env file); undefined without go. */
async function readGoEnv(ctx: EnvironmentContext): Promise<Record<string, string> | undefined> {
  try {
    const r = await ctx.exec({ file: "go", args: ["env", "-json", "GOPROXY", "GOSUMDB"], cwd: ctx.cwd });
    return r.code === 0 ? (JSON.parse(r.stdout) as Record<string, string>) : undefined;
  } catch {
    return undefined; // go is not installed: the tool-version check reports that
  }
}

/** Every GOPROXY entry is the mirror (or `off`): `direct` and other proxies fetch from outside. */
function proxyOk(value: string, proxy: string): boolean {
  const entries = value.split(/[,|]/).map((e) => e.trim());
  return entries.some((e) => sameUrl(e, proxy)) && entries.every((e) => e === "off" || sameUrl(e, proxy));
}

/** `sum.golang.org <mirror>`: the official key, fetched through the mirror (SPEC §10.2). */
function sumdbOk(value: string, sumdb: string): boolean {
  const [name, url, ...rest] = value.trim().split(/\s+/);
  return name === "sum.golang.org" && url !== undefined && sameUrl(url, sumdb) && rest.length === 0;
}

/**
 * Go's mirror settings are user-level (`go env -w`, SPEC §10.2): doctor reads them and prints the command to run; it
 * never changes them (§9.1). Only for repos with a Go component.
 */
export const goMirrorsCheck: EnvironmentCheck = {
  id: "go-mirrors",
  async run(ctx) {
    if (!ctx.resolution?.components.some((c) => c.language === "go")) return [];
    const values = await readGoEnv(ctx);
    if (!values) return [];
    const proxy = mirror(ctx, "mirrors.go");
    const sumdb = `sum.golang.org ${mirror(ctx, "mirrors.gosumdb")}`;
    const setSumdb = `go env -w GOSUMDB="${sumdb}"`;
    const findings: Finding[] = [];
    const goproxy = values.GOPROXY ?? "";
    if (!proxyOk(goproxy, proxy)) {
      const message = `GOPROXY = ${redact(goproxy)}，沒有只經由內部鏡像下載模組`;
      findings.push(problem("go-proxy", message, `go env -w GOPROXY=${proxy}`));
    }
    const gosumdb = (values.GOSUMDB ?? "").trim();
    if (gosumdb === "off") {
      const message = "GOSUMDB=off：go.sum 中還沒有的模組都會在未經驗證的情況下被接受";
      findings.push(problem("gosumdb-off", message, setSumdb));
    } else if (!sumdbOk(gosumdb, mirror(ctx, "mirrors.gosumdb"))) {
      const message = `GOSUMDB = ${redact(gosumdb)}，沒有經由內部鏡像連到 checksum 資料庫，在內網會失敗`;
      findings.push(problem("gosumdb", message, setSumdb));
    }
    return findings;
  },
};
