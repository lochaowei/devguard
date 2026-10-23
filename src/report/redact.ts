/**
 * Credentials never leave the CLI (SPEC §10.3): anything printed from a project or user file (fix and install
 * previews, printed snippets, finding messages) goes through here first. A value that only references an environment
 * variable (`${NAME}`, `${env.NAME}`) is not a secret and stays visible.
 */

const MASK = "***";

/** `scheme://user:password@`: the credentials a URL embeds. */
const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^/@\s"'<>]+@/gi;

/** URLs as they may be printed: never with the credentials they embed. */
export function redactUrl(text: string): string {
  return text.replace(URL_USERINFO, `$1${MASK}@`);
}

/** A value that is only an environment variable reference, optionally quoted and followed by a separator or comment. */
const ENV_ONLY = /^(["']?)\$\{[^}]+\}\1\s*[,;]?\s*(#.*)?$/;

/** `<password>…</password>` and friends (Maven settings.xml). */
const SECRET_ELEMENT = /<(\w*(?:password|passphrase|username|privatekey|token|secret)\w*)>([^<]*)<\/\1>/gi;

/** The last word of a key that names a credential: `NEXUS_PASSWORD`, `clientSecret`, `:_authToken`, `username`. */
const SECRET_WORD = /(password|passwd|passphrase|token|secret|apikey|username|privatekey)$/i;
/** npm's `_auth` (bare or registry-scoped); a plain `auth` key (`mirrors.auth: env`) is not a credential. */
const NPM_AUTH = /(^|[^a-z0-9])_auth$/i;

/** `key = value`, `key: value`, `"key": "value"` (INI, TOML, YAML, JSON, .env). */
const ASSIGNMENT = /^(\s*["']?)([\w./:@-]+)(["']?\s*[:=]\s*)(.*)$/;

function isSecretKey(key: string): boolean {
  const last = key.split(/[^A-Za-z0-9]+/).pop() ?? "";
  return NPM_AUTH.test(key) || SECRET_WORD.test(last);
}

function maskValue(value: string): string {
  if (value.trim() === "" || ENV_ONLY.test(value.trim()) || /^[{[]/.test(value.trim())) return value;
  const quoted = /^(["'])(.*?)\1(.*)$/.exec(value);
  if (quoted) return `${quoted[1] ?? ""}${MASK}${quoted[1] ?? ""}${quoted[3] ?? ""}`;
  return value.replace(/^[^\s#,;]+/, MASK);
}

function redactLine(line: string): string {
  let out = redactUrl(line).replace(SECRET_ELEMENT, (whole, name: string, content: string) =>
    ENV_ONLY.test(content.trim()) ? whole : `<${name}>${MASK}</${name}>`,
  );
  const m = ASSIGNMENT.exec(out);
  if (m && isSecretKey(m[2] ?? "")) out = `${m[1] ?? ""}${m[2] ?? ""}${m[3] ?? ""}${maskValue(m[4] ?? "")}`;
  return out;
}

/** Text with every literal credential masked, line by line. */
export function redactSecrets(text: string): string {
  return text.split("\n").map(redactLine).join("\n");
}
