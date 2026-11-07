import { readToml, stringOf, type Toml } from "./toml.ts";
import { USERINFO, type CredentialProblem } from "./types.ts";
import { isRecord } from "../shared/guards.ts";

const FIX = "移除網址中的帳密，改由 uv／Poetry 讀取的環境變數或使用者層級設定提供，並更換已外洩的帳密";

const strings = (v: unknown): string[] =>
  (Array.isArray(v) ? v : [v]).filter((s): s is string => typeof s === "string");

const tables = (v: unknown): Toml[] => (Array.isArray(v) ? v : []).filter(isRecord);

/** Every package source URL in a pyproject.toml, with how to name it: uv's indexes and index settings, Poetry's sources. */
function sources(doc: Toml): { label: string; url: string }[] {
  const tool = isRecord(doc.tool) ? doc.tool : {};
  const uv = isRecord(tool.uv) ? tool.uv : {};
  const poetry = isRecord(tool.poetry) ? tool.poetry : {};
  const named = (kind: string, list: Toml[]) =>
    list.map((t, i) => ({ label: `${kind} ${stringOf(t.name) || String(i + 1)}`, url: stringOf(t.url) }));
  return [
    ...named("[[tool.uv.index]]", tables(uv.index)),
    ...["index-url", "extra-index-url", "find-links"].flatMap((key) =>
      strings(uv[key]).map((url) => ({ label: `[tool.uv] ${key}`, url })),
    ),
    ...named("[[tool.poetry.source]]", tables(poetry.source)),
  ];
}

/** pyproject.toml: no package source URL embeds `user:password@`. Invalid TOML is the Python settings check's. */
export function pyprojectProblems(file: string, text: string): CredentialProblem[] {
  const doc = readToml(text);
  if (!doc) return [];
  return sources(doc)
    .filter((s) => USERINFO.test(s.url))
    .map((s) => ({ file, message: `${file} 的 ${s.label} 網址內含帳密；帳密不得進 repo`, fix: FIX }));
}
