import type { Language } from "../standard/types.ts";
import type { TestChecker } from "./types.ts";
import { goTests } from "./go.ts";
import { javaTests } from "./java.ts";
import { pythonTests } from "./python.ts";
import { typescriptTests } from "./typescript.ts";

/** The test checker for each language; a language without one has no tests run. */
export const TEST_CHECKERS: Readonly<Partial<Record<Language, TestChecker>>> = {
  python: pythonTests,
  go: goTests,
  java: javaTests,
  typescript: typescriptTests,
};
