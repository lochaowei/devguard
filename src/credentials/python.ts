import { readToml } from "./toml.ts";
import { hasUrlCredential, type CredentialProblem } from "./types.ts";
import { isRecord } from "../shared/guards.ts";

const FIX = "移除網址中的帳密，改由 uv／Poetry 讀取的環境變數或使用者層級設定提供，並更換已外洩的帳密";

/** Every string in a TOML value with its dotted key path, e.g. `tool.uv.index[0].url`, `project.dependencies[2]`. */
function strings(value: unknown, path: string): [string, string][] {
  if (typeof value === "string") return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, `${path}[${String(i)}]`));
  if (isRecord(value)) return Object.entries(value).flatMap(([k, v]) => strings(v, path === "" ? k : `${path}.${k}`));
  return [];
}

/**
 * pyproject.toml: no URL anywhere embeds a secret, so every place uv and Poetry read one is covered: indexes and
 * sources, `[tool.uv.pip]`, `[tool.uv.sources]` git and url entries, and direct-URL requirements (`pkg @ https://…`).
 * Invalid TOML is the Python settings check's to report.
 */
export function pyprojectProblems(file: string, text: string): CredentialProblem[] {
  const doc = readToml(text);
  if (!doc) return [];
  return strings(doc, "")
    .filter(([, value]) => hasUrlCredential(value))
    .map(([path]) => ({ file, message: `${file} 的 ${path} 網址內含帳密；帳密不得進 repo`, fix: FIX }));
}
