import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { hortusDir } from "./config.ts";
import type { ContextFile, Ctx, Skill } from "./llm.ts";

/** How deep under a skills root a SKILL.md is looked for. */
const MAX_DEPTH = 6;

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** The project `cwd` is in: it or its nearest ancestor with a `.git` (a file in worktrees and submodules); undefined outside a repository. */
export async function projectRoot(cwd = process.cwd()): Promise<string | undefined> {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (await exists(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * `cwd` and its ancestors up to its `projectRoot`, root first; just `cwd` outside a repository, so nothing from an
 * unrelated parent (like `~`) is picked up.
 */
export async function projectDirs(cwd = process.cwd()): Promise<string[]> {
  const root = await projectRoot(cwd);
  const dirs = [cwd];
  for (let dir = cwd; root && dir !== root; dirs.unshift(dir)) dir = dirname(dir);
  return dirs;
}

/** `~/.hortus/AGENTS.md`, then the `AGENTS.md` of each of `projectDirs`, root first, so the most specific comes last. */
export async function loadAgentsMd(cwd = process.cwd()): Promise<ContextFile[]> {
  const paths = new Set([join(hortusDir(), "AGENTS.md"), ...(await projectDirs(cwd)).map((d) => join(d, "AGENTS.md"))]);
  const files = await Promise.all(
    [...paths].map(async (path) => {
      try {
        return { path, content: await readFile(path, "utf8") };
      } catch (e) {
        if (["ENOENT", "ENOTDIR", "EISDIR"].includes((e as NodeJS.ErrnoException).code ?? "")) return undefined;
        throw e;
      }
    }),
  );
  return files.filter((f) => f !== undefined);
}

/** A Markdown file's YAML frontmatter (between `---` lines; `{}` without one) and the rest. Throws on invalid YAML. */
export function parseFrontmatter(text: string): { meta: Record<string, unknown>; body: string } {
  const m = text.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!m) return { meta: {}, body: text };
  const meta: unknown = parse(m[1] ?? "");
  return {
    meta: meta && typeof meta === "object" ? (meta as Record<string, unknown>) : {},
    body: text.slice(m[0].length),
  };
}

/** The skill a SKILL.md declares; `name` defaults to its directory's name. Undefined without a `description`. */
export async function readSkill(path: string): Promise<Skill | undefined> {
  const { meta } = parseFrontmatter(await readFile(path, "utf8"));
  const { name, description } = meta;
  if (typeof description !== "string" || !description.trim()) return undefined;
  return { name: typeof name === "string" && name ? name : basename(dirname(path)), description, path };
}

/** SKILL.md files under `dir`; a directory with one is a skill, so nothing below it is searched. */
async function findSkillFiles(dir: string, depth = 0): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  if (entries.some((e) => e.name === "SKILL.md" && !e.isDirectory())) return [join(dir, "SKILL.md")];
  if (depth >= MAX_DEPTH) return [];
  // symlinks are followed (skills are often linked in); one to a file fails readdir and is skipped
  const subdirs = entries
    .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules" && (e.isDirectory() || e.isSymbolicLink()))
    .map((e) => e.name)
    .sort();
  return (await Promise.all(subdirs.map((name) => findSkillFiles(join(dir, name), depth + 1)))).flat();
}

/**
 * The skills plugins offer now: fires `skills` (builtin:skills pushes those on disk, others add, remove or replace any)
 * and keeps one per name, the last one pushed winning. builtin:skills calls it every run; hosts list skills with it.
 */
export async function listSkills(ctx: Pick<Ctx, "emit">): Promise<Skill[]> {
  const p = { skills: [] as Skill[] };
  await ctx.emit("skills", p);
  return [...new Map(p.skills.map((s) => [s.name, s])).values()];
}

/**
 * The skills under `dir` (e.g. a plugin's own `skills/`), as discovery finds them: SKILL.md up to depth 6, not below
 * another skill, skipping dot dirs and `node_modules`; one without a `description` (or unreadable) is skipped.
 */
export async function findSkills(dir: string): Promise<Skill[]> {
  const files = await findSkillFiles(dir);
  // ponytail: an unreadable or invalid SKILL.md is skipped silently; report them (like MCP errors, through ctx.notify) if that confuses
  const skills = await Promise.all(files.map((f) => readSkill(f).catch(() => undefined)));
  return skills.filter((s) => s !== undefined);
}

/** Skills in `~/.hortus/skills`, `~/.agents/skills`, then the `.agents/skills` of each of `projectDirs`, root first. */
export async function discoverSkills(cwd = process.cwd()): Promise<Skill[]> {
  const roots = new Set([
    join(hortusDir(), "skills"),
    join(homedir(), ".agents", "skills"),
    ...(await projectDirs(cwd)).map((d) => join(d, ".agents", "skills")),
  ]);
  return (await Promise.all([...roots].map(findSkills))).flat();
}

/** A user message running `skill`: its instructions without the frontmatter, then `request`. */
export async function expandSkill(skill: Skill, request = ""): Promise<string> {
  const { body } = parseFrontmatter(await readFile(skill.path, "utf8"));
  const block = `<skill name="${skill.name}" location="${skill.path}">\nReferences are relative to ${dirname(skill.path)}.\n\n${body.trim()}\n</skill>`;
  return request.trim() ? `${block}\n\n${request.trim()}` : block;
}

/** The skill name and request of a message made by `expandSkill`, so a host can show it without the instructions. */
export function parseSkillMessage(text: string): { name: string; request: string } | undefined {
  const m = text.match(/^<skill name="([^"]*)" location="[^"]*">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/);
  return m ? { name: m[1] ?? "", request: m[2] ?? "" } : undefined;
}

const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The system prompt part about AGENTS.md files, with the contents of `agentsMd`. */
export function agentsMdPrompt(agentsMd: readonly ContextFile[]): string {
  const parts = [
    "AGENTS.md files hold instructions for the directory tree they're in, deeper ones taking precedence. Those from the project root down to the working directory are below; when working elsewhere, check for any that apply.",
  ];
  if (agentsMd.length)
    parts.push(
      [
        "Project-specific instructions and guidelines:",
        ...agentsMd.map((f) => `<project_instructions path="${f.path}">\n${f.content.trim()}\n</project_instructions>`),
      ].join("\n\n"),
    );
  return parts.join("\n\n");
}

/** The system prompt part listing `skills` (the agentskills.io format); undefined without any. */
export function skillsPrompt(skills: readonly Skill[]): string | undefined {
  if (!skills.length) return undefined;
  return [
    "The following skills provide specialized instructions for specific tasks. When a task matches a skill's description, read its file and follow it. Resolve relative paths in it against the skill's directory (the parent of SKILL.md).",
    "",
    "<available_skills>",
    ...skills.map(
      (s) =>
        `  <skill>\n    <name>${escapeXml(s.name)}</name>\n    <description>${escapeXml(s.description.trim())}</description>\n    <location>${escapeXml(s.path)}</location>\n  </skill>`,
    ),
    "</available_skills>",
  ].join("\n");
}
