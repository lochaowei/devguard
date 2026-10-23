import type { Repair } from "../fix/repair.ts";
import { internal, mirrorFinding, redact, sameUrl, type MirrorChecker, type MirrorProblem } from "./common.ts";

/** The npm variable `.npmrc` references when the mirror needs credentials (SPEC §10.3). */
export const NPM_AUTH_VARIABLE = "NEXUS_NPM_AUTH";

/** A value that only references an environment variable (`${NAME}`, `${NAME?}`), never the credential itself. */
const ENV_REFERENCE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\??\}$/;

/** npm's credential keys (`_auth`, `_authToken`, `_password`), bare or registry-scoped (`//host/path/:_auth`). */
const NPM_CREDENTIAL = /(^|:)(_auth|_authToken|_password)$/;

export interface IniEntry {
  key: string;
  value: string;
  line: number;
}

/** The `key=value` lines of an `.npmrc`, with 1-based line numbers. */
export function iniEntries(text: string): IniEntry[] {
  return text.split(/\r?\n/).flatMap((raw, i) => {
    const line = raw.trim();
    const at = line.indexOf("=");
    if (line.startsWith("#") || line.startsWith(";") || at < 0) return [];
    return [{ key: line.slice(0, at).trim(), value: line.slice(at + 1).trim(), line: i + 1 }];
  });
}

/** The `${NAME}` variables an `.npmrc` references (names only). */
export function npmrcVariables(text: string): string[] {
  return [...text.matchAll(/(?<!\\)\$\{([A-Za-z_][A-Za-z0-9_]*)\??\}/g)].flatMap((m) => (m[1] ? [m[1]] : []));
}

/** `https://host/path/` -> `//host/path/`, the prefix npm scopes credentials with. */
const npmScope = (url: string): string => url.replace(/^[a-z]+:/i, "").replace(/\/*$/, "/");

/** npm / pnpm / yarn: the component's `.npmrc` sets `registry=` to the npm mirror (SPEC §10.2, §10.3). */
export const checkNpm: MirrorChecker = async (component, mirrors, read) => {
  const file = `${component.dir}.npmrc`;
  const entries = iniEntries((await read(file)) ?? "");
  const setTo = (key: string, value: string): Repair[] => [{ op: "set", file, path: [key], value }];
  const problems: MirrorProblem[] = [];

  const registries = entries.filter((e) => e.key === "registry" || e.key.endsWith(":registry"));
  if (!registries.some((e) => e.key === "registry")) {
    const detail = `在 ${file} 寫入 registry=${mirrors.npm}`;
    problems.push({
      rule: "missing",
      message: `${file} 沒有設定 registry`,
      detail,
      repairs: setTo("registry", mirrors.npm),
    });
  }
  // The registry itself must be the mirror; a scope may use another repository of the same Nexus.
  const fine = (r: IniEntry) => (r.key === "registry" ? sameUrl : internal)(r.value, mirrors.npm);
  for (const e of registries.filter((r) => !fine(r))) {
    problems.push({
      rule: "external",
      message: `${file} 的 ${e.key} 指向外部來源 ${redact(e.value)}`,
      detail: `改為 ${e.key}=${mirrors.npm}`,
      repairs: setTo(e.key, mirrors.npm),
      line: e.line,
    });
  }

  const scope = npmScope(mirrors.npm);
  const authKey = `${scope}:_auth`;
  const reference = `\${${NPM_AUTH_VARIABLE}}`;
  const credentials = entries.filter((e) => NPM_CREDENTIAL.test(e.key));
  for (const e of credentials.filter((c) => !ENV_REFERENCE.test(c.value))) {
    problems.push({
      rule: "plaintext-credentials",
      message: `${file} 第 ${String(e.line)} 行的 ${e.key} 直接寫入了帳密；帳密不得進 repo`,
      detail: `改為引用環境變數：${authKey}=${reference}，並更換已外洩的帳密`,
      repairs: setTo(e.key, reference),
      line: e.line,
    });
  }
  const scoped = credentials.some((c) => c.key === `${scope}:_auth` || c.key === `${scope}:_authToken`);
  if (mirrors.auth === "env" && !scoped) {
    problems.push({
      rule: "auth-missing",
      message: `mirrors.auth 為 env，但 ${file} 沒有 ${authKey}`,
      detail: `在 ${file} 寫入 ${authKey}=${reference}（${NPM_AUTH_VARIABLE} 是「帳號:密碼」的 base64）`,
      repairs: setTo(authKey, reference),
    });
  }
  return problems.map((p) => mirrorFinding(component, file, p));
};
