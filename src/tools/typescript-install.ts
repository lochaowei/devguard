import { upwards } from "../repo/paths.ts";

/**
 * Yarn Berry (2 and later, checked against lockfile `version: 8` of Yarn 4) starts its lockfile with a `__metadata:`
 * block; Yarn classic (1.x, `# yarn lockfile v1`) has none.
 */
const yarnInstall = (text: string) =>
  /^__metadata:/m.test(text) ? "yarn install --immutable" : "yarn install --frozen-lockfile";

interface Lockfile {
  name: string;
  /** The package manager that writes it. */
  manager: string;
  /** The install that reproduces it exactly, from its contents. */
  install: (text: string) => string;
}

/** Each lockfile, in the order one directory's are tried when `deps.manager` names none of them. */
const LOCKFILES: readonly Lockfile[] = [
  { name: "package-lock.json", manager: "npm", install: () => "npm ci" },
  { name: "npm-shrinkwrap.json", manager: "npm", install: () => "npm ci" },
  { name: "pnpm-lock.yaml", manager: "pnpm", install: () => "pnpm install --frozen-lockfile" },
  { name: "yarn.lock", manager: "yarn", install: yarnInstall },
  { name: "bun.lock", manager: "bun", install: () => "bun install --frozen-lockfile" },
  { name: "bun.lockb", manager: "bun", install: () => "bun install --frozen-lockfile" },
];

/** The plain install of each `deps.manager`, for a project that has no lockfile yet. */
const INSTALLS: Readonly<Record<string, string>> = { npm: "npm install", pnpm: "pnpm install", yarn: "yarn install" };

export interface TypescriptInstall {
  /** Repo directory to run it in, normalized ("" for the repo root, otherwise ending in "/"). */
  dir: string;
  command: string;
}

/**
 * How to install a TypeScript component's packages (#117): the frozen install of the nearest lockfile, in its
 * directory (the workspace root); `manager`'s own lockfile first when one directory has several. Without a lockfile,
 * the plain install of `manager` (npm when unknown) where the nearest package.json is. As for Python, the lockfile
 * decides over `deps.manager`, which always has a value (the standard's default). `read` returns a repo file's
 * contents, or undefined when it does not exist.
 */
export function typescriptInstall(
  dir: string,
  manager: string | undefined,
  read: (repoPath: string) => string | undefined,
): TypescriptInstall {
  const dirs = upwards(dir);
  const order = [...LOCKFILES].sort((a, b) => Number(b.manager === manager) - Number(a.manager === manager));
  for (const d of dirs) {
    for (const lockfile of order) {
      const text = read(d + lockfile.name);
      if (text !== undefined) return { dir: d, command: lockfile.install(text) };
    }
  }
  const command = (manager === undefined ? undefined : INSTALLS[manager]) ?? "npm install";
  return { dir: dirs.find((d) => read(`${d}package.json`) !== undefined) ?? dir, command };
}
