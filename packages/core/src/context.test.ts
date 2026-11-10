import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { discoverSkills, expandSkill, loadAgentsMd, parseSkillMessage, projectDirs } from "./context.ts";

async function put(path: string, text: string) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
}

const skill = (description: string, name?: string) =>
  `---\n${name ? `name: ${name}\n` : ""}description: ${description}\n---\n\n# Body\nSee ./ref.md\n`;

test("projectDirs walks up to the nearest .git (a file too), and is just cwd without one", async () => {
  const root = await mkdtemp(join(tmpdir(), "hortus-"));
  const cwd = join(root, "a", "b");
  await mkdir(cwd, { recursive: true });
  assert.deepEqual(await projectDirs(cwd), [cwd]);
  await writeFile(join(root, ".git"), "gitdir: elsewhere\n");
  assert.deepEqual(await projectDirs(cwd), [root, join(root, "a"), cwd]);
});

test("loadAgentsMd reads only AGENTS.md, from the repository root down to cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "hortus-"));
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

test("discoverSkills finds SKILL.md under each .agents/skills, not below a skill, hidden dirs or without a description", async () => {
  const root = await mkdtemp(join(tmpdir(), "hortus-"));
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
});

test("expandSkill drops the frontmatter and appends the request", async () => {
  const root = await mkdtemp(join(tmpdir(), "hortus-"));
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
