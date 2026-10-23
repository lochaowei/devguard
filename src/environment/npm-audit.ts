import { NPM_AUTH_VARIABLE } from "../mirrors/npm.ts";
import type { Finding } from "../report/finding.ts";
import type { EnvironmentCheck, EnvironmentContext } from "./types.ts";

/**
 * Asks the bulk advisory endpoint with an empty request and returns the HTTP status; rejects when it cannot be
 * reached. `authorization` is the header value to send, when the mirror needs credentials.
 */
export type BulkProbe = (url: string, authorization?: string) => Promise<number>;

const TIMEOUT_MS = 5000;

/** The real probe: one POST of `{}`, given up after a few seconds. */
const httpProbe: BulkProbe = async (url, authorization) => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (authorization !== undefined) headers.authorization = authorization;
  const response = await fetch(url, { method: "POST", headers, body: "{}", signal: AbortSignal.timeout(TIMEOUT_MS) });
  return response.status;
};

/** npm audit's only endpoint since the old `/audits` was retired (SPEC §5.3). */
export const bulkEndpoint = (mirror: string): string =>
  `${mirror.endsWith("/") ? mirror : `${mirror}/`}-/npm/v1/security/advisories/bulk`;

export interface NpmAuditCheckOptions {
  /** Defaults to an HTTP POST; tests pass a fake so nothing goes over the network. */
  probe?: BulkProbe;
}

/** The HTTP status, or why the endpoint could not be reached. */
async function statusOf(probe: BulkProbe, url: string, auth: string | undefined): Promise<number | string> {
  try {
    return await probe(url, auth === undefined ? undefined : `Basic ${auth}`);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** The npm mirror to probe: only when some TypeScript component turns the scan on. */
function mirrorToProbe(resolution: EnvironmentContext["resolution"]): string | undefined {
  const scans = resolution?.components.some(
    (c) => c.language === "typescript" && c.effective["deps.vulnScan"]?.value === true,
  );
  const mirror = resolution?.global["mirrors.npm"]?.value;
  return scans === true && typeof mirror === "string" ? mirror : undefined;
}

/**
 * §5.3: npm audit through Nexus needs Sonatype Repository Firewall. When a TypeScript component turns the scan on,
 * doctor asks the npm mirror's bulk endpoint once; when it does not answer 200 the scan cannot work there, which is a
 * hint, not an error. The credentials variable is sent but never printed (§10.3).
 */
export function createNpmAuditCheck(options: NpmAuditCheckOptions = {}): EnvironmentCheck {
  const probe = options.probe ?? httpProbe;
  return {
    id: "npm-audit",
    async run({ resolution, env }) {
      const mirror = mirrorToProbe(resolution);
      if (mirror === undefined) return [];
      const auth = resolution?.global["mirrors.auth"]?.value === "env" ? env[NPM_AUTH_VARIABLE] : undefined;
      const url = bulkEndpoint(mirror);
      const status = await statusOf(probe, url, auth);
      if (status === 200) return [];
      const finding: Finding = {
        level: "hint",
        layer: "environment",
        rule: "environment/npm-audit-unavailable",
        message:
          `npm 鏡像的弱點查詢端點無法使用（${url}：${String(status)}），npm audit 在這裡無法執行；` +
          "需要 Sonatype Repository Firewall 授權與 Nexus ≥3.82",
        fix: "請 IT 確認 Firewall 授權；或在 CI 另行掃描",
      };
      return [finding];
    },
  };
}

export const npmAuditCheck: EnvironmentCheck = createNpmAuditCheck();
