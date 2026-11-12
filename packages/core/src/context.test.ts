import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { tempDir } from "./testing.ts";
import {
  discoverSkills,
  expandSkill,
  findSkills,
  loadAgentsMd,
  parseFrontmatter,
  parseSkillMessage,
  projectDirs,
  projectRoot,
  readSkill,
} from "./context.ts";

async function put(path: string, text: string) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
}

const skill = (description: string, name?: string) =>
  `---\n${name ? `name: ${name}\n` : ""}description: ${description}\n---\n\n# Body\nSee ./ref.md\n`;

test("projectDirs walks up to projectRoot, the nearest .git (a file too), and is just cwd without one", async (t) => {
  const root = await tempDir(t, "hortus-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "a", "b");
  await mkdir(cwd, { recursive: true });
  assert.deepEqual(await projectDirs(cwd), [cwd]);
  assert.equal(await projectRoot(cwd), undefined);
  await writeFile(join(root, ".git"), "gitdir: elsewhere\n");
  assert.deepEqual(await projectDirs(cwd), [root, join(root, "a"), cwd]);
  assert.equal(await projectRoot(cwd), root);
  assert.equal(await projectRoot(root), root); // a relative cwd is resolved first
  assert.equal(await projectRoot("."), await projectRoot(process.cwd()));
  assert.ok(await projectRoot("."));
});

test("loadAgentsMd reads only AGENTS.md, from the repository root down to cwd", async (t) => {
  const root = await tempDir(t, "hortus-");
  const cwd = join(root, "a", "b");
  await mkdir(join(root, ".git"), { recursive: true });
  await put(join(root, "AGENTS.md"), "root");
  await put(join(root, "a", "CLAUDE.md"), "claude");
  await put(join(root, "a", "AGENTS.override.md"), "override");
  await put(join(cwd, "AGENTS.md"), "cwd");
  await put(join(cwd, "sub", "AGENTS.md"), "below cwd");
  const files = (await loadAgentsMd(cwd)).filter((f) => f.path.startsWith(root));
  assert.deepEqual(
    files.map((f) => f.content),
    ["root", "cwd"],
  );
});

test("discoverSkills finds SKILL.md under each .agents/skills, not below a skill, hidden dirs or without a description", async (t) => {
  const root = await tempDir(t, "hortus-");
  const cwd = join(root, "pkg");
  await mkdir(join(root, ".git"), { recursive: true });
  const skills = join(root, ".agents", "skills");
  await put(join(skills, "pdf", "SKILL.md"), skill("Handle PDFs"));
  await put(join(skills, "pdf", "nested", "SKILL.md"), skill("inside another skill", "nested"));
  await put(join(skills, "group", "deep", "SKILL.md"), skill("Grouped", "renamed"));
  await put(join(skills, ".hidden", "SKILL.md"), skill("hidden", "hidden"));
  await put(join(skills, "nodesc", "SKILL.md"), "---\nname: nodesc\n---\nbody");
  await put(join(cwd, ".agents", "skills", "local", "SKILL.md"), skill("From cwd"));
  const found = (await discoverSkills(cwd)).filter((s) => s.path.startsWith(root));
  assert.deepEqual(
    found.map((s) => [s.name, s.description]),
    [
      ["renamed", "Grouped"],
      ["pdf", "Handle PDFs"],
      ["local", "From cwd"],
    ],
  );
  // a plugin's own skills dir, with the same walk
  assert.deepEqual(
    (await findSkills(skills)).map((s) => s.name),
    ["renamed", "pdf"],
  );
});

test("expandSkill drops the frontmatter and appends the request", async (t) => {
  const root = await tempDir(t, "hortus-");
  const path = join(root, "pdf", "SKILL.md");
  await put(path, skill("Handle PDFs"));
  const text = await expandSkill({ name: "pdf", description: "Handle PDFs", path }, " split a.pdf ");
  assert.equal(
    text,
    `<skill name="pdf" location="${path}">\nReferences are relative to ${join(root, "pdf")}.\n\n# Body\nSee ./ref.md\n</skill>\n\nsplit a.pdf`,
  );
  assert.deepEqual(parseSkillMessage(text), { name: "pdf", request: "split a.pdf" });
  assert.deepEqual(parseSkillMessage(await expandSkill({ name: "pdf", description: "", path })), {
    name: "pdf",
    request: "",
  });
  assert.equal(parseSkillMessage("hi <skill>"), undefined);
});

test("every Markdown file with frontmatter under examples/plugins parses, and every SKILL.md names and describes its skill", async () => {
  const root = fileURLToPath(new URL("../../../examples/plugins/", import.meta.url));
  const files = (await readdir(root, { recursive: true })).filter(
    (f) => f.endsWith(".md") && !f.split(sep).some((p) => p === "node_modules" || p === "dist"),
  );
  assert.ok(files.length > 0);
  for (const f of files) {
    const text = await readFile(join(root, f), "utf8");
    if (!text.startsWith("---")) continue;
    // a formatter's blank line after the fence turns `key: value` lines into a heading
    assert.doesNotMatch(text, /^---\r?\n\s*\r?\n/, `${f}: blank line after ---`);
    const { meta } = parseFrontmatter(text);
    assert.ok(Object.keys(meta).length > 0, `${f}: frontmatter didn't parse`);
    if (f.endsWith("SKILL.md")) assert.ok(typeof meta.name === "string" && (await readSkill(join(root, f))), f);
  }
});
