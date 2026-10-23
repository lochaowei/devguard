import { parse as parseToml } from "@decimalturn/toml-patch";
import type { Repair } from "../fix/repair.ts";
import {
  internal,
  mirrorFinding,
  redact,
  sameUrl,
  USERINFO,
  type MirrorChecker,
  type MirrorProblem,
  type MirrorSettings,
} from "./common.ts";

/** The index devguard manages in `[[tool.uv.index]]` (SPEC §10.2); uv reads its credentials from UV_INDEX_NEXUS_*. */
export const UV_INDEX_NAME = "nexus";
/** uv's credential variables for the `nexus` index: the index name upper-cased (SPEC §10.3). */
export const UV_AUTH_VARIABLES = ["UV_INDEX_NEXUS_USERNAME", "UV_INDEX_NEXUS_PASSWORD"] as const;

const AUTH_DETAIL = `帳密改由環境變數 ${UV_AUTH_VARIABLES.join(" / ")} 提供`;

type Toml = Record<string, unknown>;
const isTable = (v: unknown): v is Toml => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] =>
  (Array.isArray(v) ? v : [v]).filter((s): s is string => typeof s === "string");

function readToml(text: string | undefined): Toml | undefined {
  try {
    return text === undefined ? {} : (parseToml(text) as Toml);
  } catch {
    return undefined;
  }
}

/** Indexes and index settings other than the `nexus` index: each must stay on the mirror's host. */
function otherSources(file: string, uv: Toml, indexes: Toml[], mirror: string): MirrorProblem[] {
  const problems: MirrorProblem[] = [];
  for (const [i, index] of indexes.entries()) {
    const url = typeof index.url === "string" ? index.url : "";
    const label = `[[tool.uv.index]] ${typeof index.name === "string" ? index.name : String(i + 1)}`;
    if (USERINFO.test(url)) {
      const message = `${file} 的 ${label} 網址內含帳密；帳密不得進 repo`;
      problems.push({ rule: "plaintext-credentials", message, detail: `${AUTH_DETAIL}，並更換已外洩的帳密` });
    }
    if (index.name !== UV_INDEX_NAME && url !== "" && !internal(url, mirror)) {
      const message = `${file} 的 ${label} 指向外部來源 ${redact(url)}`;
      problems.push({ rule: "external", message, detail: "移除該 index，或改為內部鏡像的網址" });
    }
  }
  for (const key of ["index-url", "extra-index-url", "find-links"]) {
    for (const url of strings(uv[key]).filter((u) => !internal(u, mirror))) {
      const message = `${file} 的 [tool.uv] ${key} 指向外部來源 ${redact(url)}`;
      problems.push({ rule: "external", message, detail: `移除 ${key}，改用 [[tool.uv.index]]` });
    }
  }
  return problems;
}

/** The `nexus` index is missing: add it (with `authenticate` when the mirror needs credentials). */
function missingIndex(file: string, mirrors: MirrorSettings): MirrorProblem {
  const auth = mirrors.auth === "env" ? { authenticate: "always" } : {};
  const value = { name: UV_INDEX_NAME, url: mirrors.pypi, default: true, ...auth };
  return {
    rule: "missing",
    message: `${file} 沒有指向內部鏡像的 [[tool.uv.index]]（name = "${UV_INDEX_NAME}"）`,
    detail: `在 ${file} 加上 [[tool.uv.index]]（name = "${UV_INDEX_NAME}"、url = "${mirrors.pypi}"、default = true）`,
    repairs: [{ op: "add", file, path: ["tool", "uv", "index"], value }],
  };
}

/** The `nexus` index at position `at`: the mirror's URL, `default = true`, `authenticate = "always"` with auth env. */
function nexusProblems(file: string, nexus: Toml, at: number, mirrors: MirrorSettings): MirrorProblem[] {
  const set = (key: string, value: unknown): Repair[] => [
    { op: "set", file, path: ["tool", "uv", "index", at, key], value },
  ];
  const problems: MirrorProblem[] = [];
  const url = typeof nexus.url === "string" ? nexus.url : "";
  if (!sameUrl(url, mirrors.pypi)) {
    problems.push({
      rule: "external",
      message: `${file} 的 nexus index 指向 ${url === "" ? "（未設定）" : redact(url)}，不是內部鏡像`,
      detail: `改為 url = "${mirrors.pypi}"`,
      repairs: set("url", mirrors.pypi),
    });
  }
  if (nexus.default !== true) {
    const message = `${file} 的 nexus index 沒有 default = true，uv 仍會使用 PyPI`;
    problems.push({ rule: "missing", message, detail: "加上 default = true", repairs: set("default", true) });
  }
  if (mirrors.auth === "env" && nexus.authenticate !== "always") {
    problems.push({
      rule: "auth-missing",
      message: `mirrors.auth 為 env，但 ${file} 的 nexus index 沒有 authenticate = "always"`,
      detail: `加上 authenticate = "always"；${AUTH_DETAIL}`,
      repairs: set("authenticate", "always"),
    });
  }
  return problems;
}

/** uv: `[[tool.uv.index]]` named `nexus`, `default = true`, on the PyPI mirror (SPEC §10.2, §10.3). */
export const checkUv: MirrorChecker = async (component, mirrors, read) => {
  const file = `${component.dir}pyproject.toml`;
  // A pyproject.toml that is not valid TOML is the Python settings check's to report.
  const doc = readToml(await read(file));
  if (!doc) return [];
  const uv = isTable(doc.tool) && isTable(doc.tool.uv) ? doc.tool.uv : {};
  const indexes = (Array.isArray(uv.index) ? uv.index : []).filter(isTable);
  const at = indexes.findIndex((x) => x.name === UV_INDEX_NAME);
  const nexus = indexes[at];
  const problems = [
    ...otherSources(file, uv, indexes, mirrors.pypi),
    ...(nexus ? nexusProblems(file, nexus, at, mirrors) : [missingIndex(file, mirrors)]),
  ];
  return problems.map((p) => mirrorFinding(component, file, p));
};
