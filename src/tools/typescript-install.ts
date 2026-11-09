import { upwards } from "../repo/paths.ts";

/** A Yarn Berry lockfile starts with a `__metadata:` block; a classic one (v1) has none. */
const yarnInstall = (text: string) =>
  /^__metadata:/m.test(text) ? "yarn install --immutable" : "yarn install --frozen-lockfile";

/** Each lockfile, in the order one directory's are tried, with the install that reproduces it exactly. */
const LOCKFILES: readonly (readonly [string, (text: string) => string])[] = [
  ["package-lock.json", () => "npm ci"],
  ["npm-shrinkwrap.json", () => "npm ci"],
  ["pnpm-lock.yaml", () => "pnpm install --frozen-lockfile"],
  ["yarn.lock", yarnInstall],
  ["bun.lock", () => "bun install --frozen-lockfile"],
  ["bun.lockb", () => "bun install --frozen-lockfile"],
];

/** The plain install of each `deps.manager`, for a project that has no lockfile yet. */
const INSTALLS: Readonly<Record<string, string>> = {
  npm: "npm install",
  pnpm: "pnpm install",
  yarn: "yarn install",
  bun: "bun install",
};

export interface TypescriptInstall {
  /** Repo directory to run it in, normalized ("" for the repo root, otherwise ending in "/"). */
  dir: string;
  command: string;
}

/**
 * How to install a TypeScript component's packages (#117): the frozen install of the nearest lockfile, in its
 * directory (the workspace root); without one, the plain install of `manager` (npm when unknown) where the nearest
 * package.json is. Like the Python manager, the lockfile decides; `manager` only fills in when there is none.
 * `read` returns a repo file's contents, or undefined when it does not exist.
 */
export function typescriptInstall(
  dir: string,
  manager: unknown,
  read: (repoPath: string) => string | undefined,
): TypescriptInstall {
  const dirs = upwards(dir);
  for (const d of dirs) {
    for (const [name, install] of LOCKFILES) {
      const text = read(d + name);
      if (text !== undefined) return { dir: d, command: install(text) };
    }
  }
  const command = (typeof manager === "string" ? INSTALLS[manager] : undefined) ?? "npm install";
  return { dir: dirs.find((d) => read(`${d}package.json`) !== undefined) ?? dir, command };
}
