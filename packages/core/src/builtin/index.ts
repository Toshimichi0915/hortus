import anthropic from "./anthropic.ts";
import bash from "./bash.ts";
import codemode from "./codemode.ts";
import compaction from "./compaction.ts";
import edit from "./edit.ts";
import mcp from "./mcp.ts";
import name from "./name.ts";
import openai from "./openai.ts";
import prompt from "./prompt.ts";
import read from "./read.ts";
import skills from "./skills.ts";
import write from "./write.ts";

/** The pieces hortus is made of, each disableable or replaceable by name; loaded before any other plugin. */
export const builtins = [prompt, skills, read, write, edit, bash, anthropic, openai, mcp, codemode, compaction, name];
