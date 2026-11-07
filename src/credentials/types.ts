/** A credential written into a project file. Never holds the credential's value. */
export interface CredentialProblem {
  file: string;
  line?: number;
  message: string;
  /** What to do by hand: credentials are never rewritten by `devguard fix`. */
  fix: string;
}

/** Reads a repo-relative file; undefined when it does not exist. */
export type ReadFile = (file: string) => Promise<string | undefined>;

/** `user:password@` in a URL: a credential written into a project file. */
export const USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/i;
