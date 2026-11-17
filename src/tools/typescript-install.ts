import { upwards } from "../repo/paths.ts";

/**
 * Yarn Berry (2 and later, checked against lockfile `version: 8` of Yarn 4) starts its lockfile with a `__metadata:`
 * block; Yarn classic (1.x, `# yarn lockfile v1`) has none.
 */
const isYarnBerry = (lockfile: string) => /^__metadata:/m.test(lockfile);

const yarnInstall = (text: string) =>
  isYarnBerry(text) ? "yarn install --immutable" : "yarn install --frozen-lockfile";

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

type Read = (repoPath: string) => string | undefined;

interface Project {
  /** The package manager: the nearest lockfile's, else `deps.manager`, else npm. */
  manager: string;
  /** The nearest lockfile, when there is one. */
  lockfile?: { dir: string; def: Lockfile; text: string };
  /** The nearest directory with a package.json; the component's own when there is none. */
  packageDir: string;
}

function project(dir: string, manager: string | undefined, read: Read): Project {
  const dirs = upwards(dir);
  const packageDir = dirs.find((d) => read(`${d}package.json`) !== undefined) ?? dir;
  const order = [...LOCKFILES].sort((a, b) => Number(b.manager === manager) - Number(a.manager === manager));
  for (const d of dirs) {
    for (const def of order) {
      const text = read(d + def.name);
      if (text !== undefined) return { manager: def.manager, lockfile: { dir: d, def, text }, packageDir };
    }
  }
  return { manager: manager !== undefined && manager in INSTALLS ? manager : "npm", packageDir };
}

/**
 * How to install a TypeScript component's packages (#117): the frozen install of the nearest lockfile, in its
 * directory (the workspace root); `manager`'s own lockfile first when one directory has several. Without a lockfile,
 * the plain install of `manager` (npm when unknown) where the nearest package.json is. As for Python, the lockfile
 * decides over `deps.manager`, which always has a value (the standard's default). `read` returns a repo file's
 * contents, or undefined when it does not exist.
 */
export function typescriptInstall(dir: string, manager: string | undefined, read: Read): TypescriptInstall {
  const { lockfile, manager: found, packageDir } = project(dir, manager, read);
  if (lockfile) return { dir: lockfile.dir, command: lockfile.def.install(lockfile.text) };
  return { dir: packageDir, command: INSTALLS[found] ?? "npm install" };
}

/** How each package manager adds a dev dependency; npm's is what `standard upgrade` runs (SPEC §5.5). */
const ADD_DEV: Readonly<Record<string, string>> = {
  npm: "npm install --save-dev",
  pnpm: "pnpm add --save-dev",
  yarn: "yarn add --dev",
  bun: "bun add --dev",
};

/** Whether a package.json declares workspaces: it is a workspace root. */
function declaresWorkspaces(text: string | undefined): boolean {
  if (text === undefined) return false;
  try {
    const json: unknown = JSON.parse(text);
    return typeof json === "object" && json !== null && "workspaces" in json;
  } catch {
    return false;
  }
}

/**
 * The flag without which the package manager refuses to add a dependency to a workspace root: pnpm's `-w`
 * (ERR_PNPM_ADDING_TO_ROOT) and Yarn classic's `-W`. npm, Yarn Berry and Bun add to a root without one.
 */
function workspaceRootFlag(found: Project, read: Read): string {
  const dir = found.packageDir;
  if (found.manager === "pnpm") return read(`${dir}pnpm-workspace.yaml`) === undefined ? "" : " -w";
  const classic = found.manager === "yarn" && found.lockfile !== undefined && !isYarnBerry(found.lockfile.text);
  return classic && declaresWorkspaces(read(`${dir}package.json`)) ? " -W" : "";
}

/**
 * How to add `spec` (a package, with its range when known) to the dev dependencies (#210): with the package manager
 * `typescriptInstall` uses, where the nearest package.json is, so the tool lands in the `node_modules` the component
 * runs it from.
 */
export function typescriptAddDev(
  dir: string,
  manager: string | undefined,
  read: Read,
  spec: string,
): TypescriptInstall {
  const found = project(dir, manager, read);
  const add = `${ADD_DEV[found.manager] ?? "npm install --save-dev"}${workspaceRootFlag(found, read)}`;
  return { dir: found.packageDir, command: `${add} ${/[<>\s]/.test(spec) ? `"${spec}"` : spec}` };
}
