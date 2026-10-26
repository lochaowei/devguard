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
import { readToml, stringOf, type Toml } from "./toml.ts";
import { isRecord } from "../shared/guards.ts";

/** The source devguard manages in `[[tool.poetry.source]]` (SPEC §10.2). */
export const POETRY_SOURCE_NAME = "nexus";
/** Poetry's credential variables for the `nexus` source: the source name upper-cased (SPEC §10.3). */
export const POETRY_AUTH_VARIABLES = ["POETRY_HTTP_BASIC_NEXUS_USERNAME", "POETRY_HTTP_BASIC_NEXUS_PASSWORD"] as const;

const AUTH_DETAIL = `帳密改由環境變數 ${POETRY_AUTH_VARIABLES.join(" / ")} 提供`;

/** The `nexus` source is missing: add it as the primary source, which also stops Poetry from using PyPI. */
function missingSource(file: string, mirrors: MirrorSettings): MirrorProblem {
  const value = { name: POETRY_SOURCE_NAME, url: mirrors.pypi, priority: "primary" };
  return {
    rule: "missing",
    message: `${file} 沒有指向內部鏡像的 [[tool.poetry.source]]（name = "${POETRY_SOURCE_NAME}"）`,
    detail: `在 ${file} 加上 [[tool.poetry.source]]（name = "${POETRY_SOURCE_NAME}"、url = "${mirrors.pypi}"、priority = "primary"）`,
    repairs: [{ op: "add", file, path: ["tool", "poetry", "source"], value }],
  };
}

/** Every source: no credentials in its URL. Sources other than `nexus`: each must stay on the mirror's host. */
function otherSources(file: string, sources: Toml[], mirror: string): MirrorProblem[] {
  return sources.flatMap((source, i): MirrorProblem[] => {
    const url = stringOf(source.url);
    const label = `[[tool.poetry.source]] ${stringOf(source.name) || String(i + 1)}`;
    const problems: MirrorProblem[] = [];
    if (USERINFO.test(url)) {
      const message = `${file} 的 ${label} 網址內含帳密；帳密不得進 repo`;
      problems.push({ rule: "plaintext-credentials", message, detail: `${AUTH_DETAIL}，並更換已外洩的帳密` });
    }
    if (source.name !== POETRY_SOURCE_NAME && url !== "" && !internal(url, mirror)) {
      const message = `${file} 的 ${label} 指向外部來源 ${redact(url)}`;
      problems.push({ rule: "external", message, detail: "移除該 source，或改為內部鏡像的網址" });
    }
    return problems;
  });
}

/** The `nexus` source at position `at`: the mirror's URL and `priority = "primary"`. */
function nexusProblems(file: string, nexus: Toml, at: number, mirrors: MirrorSettings): MirrorProblem[] {
  const set = (key: string, value: unknown): Repair[] => [
    { op: "set", file, path: ["tool", "poetry", "source", at, key], value },
  ];
  const problems: MirrorProblem[] = [];
  const url = stringOf(nexus.url);
  if (!sameUrl(url, mirrors.pypi)) {
    problems.push({
      rule: "external",
      message: `${file} 的 nexus source 指向 ${url === "" ? "（未設定）" : redact(url)}，不是內部鏡像`,
      detail: `改為 url = "${mirrors.pypi}"`,
      repairs: set("url", mirrors.pypi),
    });
  }
  if (nexus.priority !== "primary") {
    const message = `${file} 的 nexus source 沒有 priority = "primary"，Poetry 仍會使用 PyPI`;
    const detail = '改為 priority = "primary"';
    problems.push({ rule: "missing", message, detail, repairs: set("priority", "primary") });
  }
  return problems;
}

/** Poetry: `[[tool.poetry.source]]` named `nexus`, `priority = "primary"`, on the PyPI mirror (SPEC §10.2, §10.3). */
export const checkPoetry: MirrorChecker = async (component, mirrors, read) => {
  const file = `${component.dir}pyproject.toml`;
  // A pyproject.toml that is not valid TOML is the Python settings check's to report.
  const doc = readToml(await read(file));
  if (!doc) return [];
  const poetry = isRecord(doc.tool) && isRecord(doc.tool.poetry) ? doc.tool.poetry : {};
  const sources = (Array.isArray(poetry.source) ? poetry.source : []).filter(isRecord);
  const at = sources.findIndex((x) => x.name === POETRY_SOURCE_NAME);
  const nexus = sources[at];
  const problems = [
    ...(nexus ? nexusProblems(file, nexus, at, mirrors) : [missingSource(file, mirrors)]),
    ...otherSources(file, sources, mirrors.pypi),
  ];
  return problems.map((p) => mirrorFinding(component, file, p));
};
