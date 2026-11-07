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

/** The userinfo (`user:password`, `token`) of each URL in a text. */
const URL_USERINFO = /\b[a-z][a-z0-9+.-]*:\/\/([^/@\s"'<>]+)@/gi;

/** A username that is itself a token: GitHub, GitLab and Slack token prefixes. */
const TOKEN_USER = /^(gh[pousr]_|github_pat_|glpat-|xox[abp]-)/;

/** A password that only references a variable (`${PASS}`, `$PASS`, `%PASS%`), never the secret itself. */
const VARIABLE = /^(\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|%[A-Za-z_][A-Za-z0-9_]*%)$/;

/** `%7BPASS%7D` → `{PASS}`; a malformed escape is left as it is. */
function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * Whether a URL in `text` embeds a secret: a password (`user:pw@`, unless it only references a variable) or a token
 * used as the username (`ghp_…@`). A bare username (`git@`, `deploy@`) is not a secret.
 */
export function hasUrlCredential(text: string): boolean {
  return [...text.matchAll(URL_USERINFO)].some(([, info = ""]) => {
    const colon = info.indexOf(":");
    if (colon < 0) return TOKEN_USER.test(info);
    const password = info.slice(colon + 1);
    return password !== "" && !VARIABLE.test(decoded(password));
  });
}
