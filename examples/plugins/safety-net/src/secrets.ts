import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";

/** What secret matching needs from the policy (`secret_protection`). */
export interface SecretPolicy {
  enabled: boolean;
  overrides: Record<string, "on" | "off">;
  allowPaths: string[];
  denyPaths: string[];
}

const BASENAMES: [string, string][] = [
  ["env", ".env"],
  ["npmrc", ".npmrc"],
  ["pypirc", ".pypirc"],
  ["netrc", ".netrc"],
  ["git-credentials", ".git-credentials"],
  ["id-rsa", "id_rsa"],
  ["id-ed25519", "id_ed25519"],
  ["id-ecdsa", "id_ecdsa"],
  ["credentials", "credentials"],
];
const BACKUPS = [".bak", ".backup", ".copy", ".disabled", ".old", ".orig", ".save", ".tmp"];
const HOME_PATHS: [string, string][] = [
  ["secret.home.ssh", ".ssh"],
  ["secret.home.aws", ".aws"],
  ["secret.home.gcp", ".gcp"],
  ["secret.home.gcloud-config", ".config/gcloud"],
  ["secret.home.kube-config", ".kube/config"],
  ["secret.home.docker-config", ".docker/config.json"],
  ...BACKUPS.map((b): [string, string] => [`secret.home.kube-config.${b.slice(1)}`, `.kube/config${b}`]),
  ...BACKUPS.map((b): [string, string] => [`secret.home.docker-config.${b.slice(1)}`, `.docker/config.json${b}`]),
  ["secret.home.gh-hosts", ".config/gh/hosts.yml"],
];
const VARIANT_PREFIXES: [string, string][] = [
  ["id_rsa", "id-rsa"],
  ["id_dsa", "id-dsa"],
  ["id_ed25519", "id-ed25519"],
  ["id_ecdsa", "id-ecdsa"],
  ["credentials", "credentials"],
];
const VARIANT_SUFFIXES = [".bak", ".backup", ".copy", ".disabled", ".key", ".old", ".orig", ".pem", ".save", ".tmp"];
const EXTENSIONS = [
  "agilekeychain",
  "asc",
  "bek",
  "cscfg",
  "fve",
  "gnucash",
  "jks",
  "keychain",
  "kwallet",
  "mdf",
  "ovpn",
  "p12",
  "pcap",
  "pem",
  "pfx",
  "pkcs12",
  "psafe3",
  "rdp",
  "sdf",
  "tblk",
  "tpm",
];
const EXT_PATTERNS: [string, RegExp][] = [
  ["secret.ext-pattern.key", /^key(pair)?$/],
  ["secret.ext-pattern.keystore", /^key(store|ring)$/],
  ["secret.ext-pattern.kdbx", /^kdbx?$/],
];

/**
 * Coding CLIs' credential files (always on) and configs (`.config`, off unless turned "on"): `~/` is home,
 * `<project>/` any directory, `<name>` any one segment. hortus's own `secrets.json` is added beside Pi's.
 */
export const CLI_PATHS: [string, string[]][] = [
  ["secret.cli.hortus", ["~/.hortus/secrets.json"]],
  ["secret.cli.claude-code", ["~/.claude/.credentials.json"]],
  [
    "secret.cli.claude-code.config",
    [
      "~/.claude/settings.json",
      "~/.claude/settings.local.json",
      "~/.claude.json",
      "<project>/.claude/settings.json",
      "<project>/.claude/settings.local.json",
      "<project>/.mcp.json",
    ],
  ],
  ["secret.cli.antigravity", ["~/.gemini/config/hooks.json", "~/.gemini/config/mcp_config.json"]],
  [
    "secret.cli.codex",
    ["~/.codex/auth.json", "~/.codex/.credentials.json", "~/.codex/secrets", "~/.codex/.sandbox-secrets"],
  ],
  ["secret.cli.codex.config", ["~/.codex/config.toml", "~/.codex/<name>.config.toml", "<project>/.codex/config.toml"]],
  [
    "secret.cli.gemini",
    [
      "~/.gemini/oauth_creds.json",
      "~/.gemini/mcp-oauth-tokens.json",
      "~/.gemini/a2a-oauth-tokens.json",
      "~/.gemini/gemini-credentials.json",
    ],
  ],
  [
    "secret.cli.gemini.config",
    [
      "~/.gemini/settings.json",
      "~/.gemini/google_accounts.json",
      "<project>/.gemini/settings.json",
      "/Library/Application Support/GeminiCli/settings.json",
      "/etc/gemini-cli/settings.json",
    ],
  ],
  ["secret.cli.copilot-cli", ["~/.copilot/config.json", "~/.copilot/mcp-oauth-config", "~/.copilot/mcp-secrets"]],
  ["secret.cli.copilot-cli.config", ["~/.copilot/mcp-config.json"]],
  [
    "secret.cli.kimi-code",
    ["~/.kimi-code/server.token", "~/.kimi-code/credentials", "~/.kimi/credentials", "~/.kimi/mcp-oauth"],
  ],
  [
    "secret.cli.kimi-code.config",
    [
      "~/.kimi-code/config.toml",
      "~/.kimi-code/mcp.json",
      "~/.kimi/config.toml",
      "~/.kimi/config.json",
      "~/.kimi/config.json.bak",
      "~/.kimi/mcp.json",
      "<project>/.kimi-code/mcp.json",
    ],
  ],
  [
    "secret.cli.opencode",
    [
      "~/.local/share/opencode/auth.json",
      "~/.local/share/opencode/mcp-auth.json",
      "~/.local/share/opencode/opencode.db",
    ],
  ],
  [
    "secret.cli.opencode.config",
    [
      "~/.config/opencode/opencode.json",
      "~/.config/opencode/opencode.jsonc",
      "~/.config/opencode/config.json",
      "/Library/Application Support/opencode/opencode.json",
      "/etc/opencode/opencode.json",
      "<project>/opencode.json",
      "<project>/opencode.jsonc",
    ],
  ],
  ["secret.cli.pi", ["~/.pi/agent/auth.json"]],
  ["secret.cli.pi.config", ["~/.pi/agent/models.json"]],
  ["secret.cli.amp", ["~/.local/share/amp/secrets.json", "~/.amp/oauth"]],
  [
    "secret.cli.amp.config",
    [
      "~/.config/amp/settings.json",
      "~/.config/amp/settings.jsonc",
      "<project>/.amp/settings.json",
      "<project>/.amp/settings.jsonc",
    ],
  ],
  [
    "secret.cli.cursor",
    ["~/.cursor/auth.json", "~/.config/cursor/auth.json", "~/.cursor/projects/<name>/mcp-auth.json"],
  ],
  ["secret.cli.cursor.config", ["~/.cursor/mcp.json", "<project>/.cursor/mcp.json"]],
  ["secret.cli.grok-build", ["~/.grok/auth.json", "~/.grok/mcp_credentials.json"]],
  [
    "secret.cli.grok-build.config",
    [
      "~/.grok/config.toml",
      "~/.grok/managed_config.toml",
      "~/.grok/requirements.toml",
      "<project>/.grok/config.toml",
      "/etc/grok/managed_config.toml",
      "/etc/grok/requirements.toml",
    ],
  ],
  [
    "secret.cli.droid",
    [
      "~/.factory/auth.encrypted",
      "~/.factory/auth.v2.file",
      "~/.factory/auth.v2.key",
      "~/.factory/auth.v2.loginkeychain",
    ],
  ],
  [
    "secret.cli.droid.config",
    ["~/.factory/settings.json", "~/.factory/hooks.json", "~/.factory/mcp.json", "<project>/.factory/mcp.json"],
  ],
  ["secret.cli.devin", ["~/.local/share/devin/credentials.toml", "~/.local/share/devin/mcp/oauth"]],
  ["secret.cli.devin.config", ["~/.config/devin/config.json"]],
];

/** Every built-in secret rule id, for `/safety-net rules`. */
export const SECRET_RULES: string[] = [
  ...BASENAMES.map(([slug]) => `secret.basename.${slug}`),
  "secret.pattern.env-variant",
  ...HOME_PATHS.map(([id]) => id),
  ...VARIANT_PREFIXES.map(([, slug]) => `secret.variant.${slug}.separator`),
  ...VARIANT_PREFIXES.flatMap(([, slug]) => VARIANT_SUFFIXES.map((s) => `secret.variant.${slug}.${s.slice(1)}`)),
  "secret.pattern.ssh-key-basename",
  ...EXTENSIONS.map((e) => `secret.ext.${e}`),
  ...EXT_PATTERNS.map(([id]) => id),
  ...CLI_PATHS.map(([id]) => id),
  "secret.deny-path",
];

export const SECRET_REASON = "Access to a sensitive path is not allowed.";

/** `~` and `$HOME` expanded, made absolute against `cwd` */
export function absolute(path: string, cwd: string): string {
  const home = homedir();
  const p = path.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, home);
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

const within = (path: string, dir: string) => path === dir || path.startsWith(dir.endsWith("/") ? dir : `${dir}/`);

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** a `~/`, `<project>/` or absolute pattern of `CLI_PATHS` against an absolute path */
function cliMatch(abs: string, pattern: string): boolean {
  const toRe = (p: string) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/<name>/g, "[^/]+");
  if (pattern.startsWith("<project>/")) return new RegExp(`/${toRe(pattern.slice(10))}$`).test(abs);
  const full = pattern.startsWith("~/") ? `${homedir()}${pattern.slice(1)}` : pattern;
  return new RegExp(`^${toRe(full)}$`).test(abs);
}

/** an allow path: exact file or dir, or `<dir>/**\/<name>` */
function allowed(abs: string, allow: string[], cwd: string): boolean {
  return allow.some((a) => {
    const m = /^(.*)\/\*\*\/([^/*?]+)$/.exec(a.trim());
    if (m) return within(abs, absolute(m[1] || "/", cwd)) && basename(abs) === m[2];
    return within(abs, absolute(a.trim(), cwd));
  });
}

/**
 * The secret rule `path` (as the agent wrote it, relative to `cwd`) hits, if any. `identity` marks an `ssh -i` key
 * file, allowed outside the home and CLI rules.
 */
export function secretRule(path: string, cwd: string, policy: SecretPolicy, identity = false): string | undefined {
  if (!path || /^[a-z][a-z0-9+.-]*:\/\/./i.test(path)) return;
  const abs = absolute(path, cwd);
  const on = (id: string, byDefault = true) => {
    const o = policy.overrides[id];
    return o ? o === "on" : byDefault;
  };
  // deny paths always win
  if (policy.denyPaths.some((d) => within(abs, absolute(d, cwd)))) return "secret.deny-path";
  if (!policy.enabled) return;
  const home = homedir();
  for (const [id, suffix] of HOME_PATHS) if (within(abs, `${home}/${suffix}`) && on(id) && !identity) return id;
  const name = basename(abs);
  for (const [id, patterns] of CLI_PATHS)
    if (patterns.some((p) => cliMatch(abs, p)) && on(id, !id.endsWith(".config"))) return id;
  if (allowed(abs, policy.allowPaths, cwd) || identity) return;
  if (
    name === ".env.defaults" ||
    (name.startsWith(".env.") && [".example", ".sample", ".template", ".tpl"].some((s) => name.endsWith(s)))
  )
    return;
  if (name.startsWith(".env.example.") || name.startsWith(".env.sample.")) return;
  if (["id_rsa.pub", "id_ed25519.pub", "id_ecdsa.pub"].includes(name)) return;
  // a directory named like a secret file isn't one
  if (isDir(abs)) return;
  for (const [slug, base] of BASENAMES)
    if (name === base && on(`secret.basename.${slug}`)) return `secret.basename.${slug}`;
  if (name.startsWith(".env.") && !/\s/.test(name) && on("secret.pattern.env-variant"))
    return "secret.pattern.env-variant";
  for (const [prefix, slug] of VARIANT_PREFIXES) {
    const rest = name.startsWith(prefix) ? name.slice(prefix.length) : undefined;
    if (!rest) continue;
    if ((rest[0] === "-" || rest[0] === "_") && on(`secret.variant.${slug}.separator`))
      return `secret.variant.${slug}.separator`;
    const sfx = VARIANT_SUFFIXES.find((s) => s === rest);
    if (sfx && on(`secret.variant.${slug}.${sfx.slice(1)}`)) return `secret.variant.${slug}.${sfx.slice(1)}`;
  }
  // vendored trees hold fixtures named like keys
  if (/\/(node_modules|__pycache__|vendor\/bundle|vendor\/cache)\//.test(abs)) return;
  if (!name.includes(".") && /_(rsa|dsa|ed25519|ecdsa)$/.test(name) && on("secret.pattern.ssh-key-basename"))
    return "secret.pattern.ssh-key-basename";
  const ext = name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "";
  if (ext && EXTENSIONS.includes(ext) && on(`secret.ext.${ext}`)) return `secret.ext.${ext}`;
  for (const [id, re] of EXT_PATTERNS) if (ext && re.test(ext) && on(id)) return id;
}
