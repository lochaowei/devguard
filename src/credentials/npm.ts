import type { CredentialProblem } from "./types.ts";

/** A value that only references an environment variable (`${NAME}`, `${NAME?}`), never the credential itself. */
const ENV_REFERENCE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\??\}$/;

/** An ini value without the quotes npm strips: `"${NPM_TOKEN}"` is the same reference as `${NPM_TOKEN}`. */
const unquoted = (value: string): string => (/^(["']).*\1$/.test(value) ? value.slice(1, -1) : value);

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

/** `.npmrc`: every credential key only references an environment variable. */
export function npmrcProblems(file: string, text: string): CredentialProblem[] {
  return iniEntries(text)
    .filter((e) => NPM_CREDENTIAL.test(e.key) && !ENV_REFERENCE.test(unquoted(e.value)))
    .map((e) => ({
      file,
      line: e.line,
      message: `${file} 第 ${String(e.line)} 行的 ${e.key} 直接寫入了帳密；帳密不得進 repo`,
      fix: `改為引用環境變數（例如 ${e.key}=\${NPM_TOKEN}），並更換已外洩的帳密`,
    }));
}
