import type { Language } from "../standard/types.ts";
import { javaChecker } from "./java.ts";
import type { CodeChecker } from "./types.ts";
import { goChecker } from "./go.ts";
import { pythonChecker } from "./python.ts";
import { typescriptChecker } from "./typescript.ts";

/** The code checker for each language; a language without one is not code-checked yet. */
export const CODE_CHECKERS: Readonly<Partial<Record<Language, CodeChecker>>> = {
  python: pythonChecker,
  typescript: typescriptChecker,
  go: goChecker,
  java: javaChecker,
};
