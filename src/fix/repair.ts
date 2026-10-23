/** A path of keys (and array indexes) inside a structured config file. */
export type KeyPath = readonly (string | number)[];

/** One change to a CLI-managed key of a structured shared file (SPEC §9.2), or to a line of a line-based file. */
export type KeyEdit =
  | { op: "set"; path: KeyPath; value: unknown }
  | { op: "delete"; path: KeyPath }
  /** Adds `value` to the array at `path` unless it is already there (creates the array). */
  | { op: "add"; path: KeyPath; value: unknown }
  /** Removes `value` from the array at `path`. */
  | { op: "remove"; path: KeyPath; value: unknown }
  /** Line-based files (.gitattributes, .gitignore): makes sure the line is present. */
  | { op: "line"; value: string };

/**
 * What `devguard fix` (and `install`) does for a file, attached by the check that found the problem. Which of these
 * actually touches the disk is decided by the file's category (src/fix/category.ts), not by the check.
 * Paths are repo-relative with forward slashes.
 */
export type Repair =
  | (KeyEdit & { file: string })
  /** A CLI-owned file: the whole content, regenerated. The "由 CLI 產生" header is added when it is written. */
  | { op: "generate"; file: string; content: string }
  /** Something only a person should apply (build files, code-form config): printed, never written. */
  | { op: "snippet"; file: string; text: string };
