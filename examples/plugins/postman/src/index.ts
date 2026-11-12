import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findSkills, type Plugin } from "@hortus/core";

/** Port of `@postman/postman-plugin` 0.8.0 (Pi extension): its skills, its session mandate and the Postman MCP server. */
const root = fileURLToPath(new URL("..", import.meta.url));
const VERSION = "0.8.0";
const ENTRY_SKILL = "api-engineer";

// Pi's skill names are un-namespaced; the shared mandate names them `postman:<skill>` for the other hosts.
const mandate = (await readFile(join(root, "session-start-context.md"), "utf8")).replace(
  /`postman:([a-z0-9-]+)`/g,
  "`$1`",
);

const skills = await findSkills(join(root, "skills"));

export default {
  on: {
    skills: ({ skills: list }) => void list.push(...skills),
    // the mandate routes to a skill, so it goes only where that skill is offered
    prompt: ({ system, skills }) => {
      if (skills?.some((s) => s.name === ENTRY_SKILL)) system.push(`<postman>\n${mandate.trim()}\n</postman>`);
    },
    // A `postman` server in the user's own mcp.json wins (builtin:mcp applies it over this one).
    mcp_servers: async ({ servers }, ctx) => {
      // secrets.json: { "postman": { "type": "postman", "apiKey": "PMAK-…", "endpoint"?: "https://mcp.eu.postman.com/mcp" } }
      const [secret] = await ctx.secrets.find("postman");
      const apiKey = secret?.entry.apiKey;
      if (!apiKey) {
        await ctx.notify(
          'Postman\'s MCP server needs an API key: add { "type": "postman", "apiKey": "PMAK-…" } to ~/.hortus/secrets.json.',
          "warn",
        );
        return;
      }
      servers.postman = {
        url: typeof secret.entry.endpoint === "string" ? secret.entry.endpoint : "https://mcp.postman.com/mcp",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "X-Source": "postman-pi-plugin",
          "X-Plugin-Version": VERSION,
          "User-Agent": `postman-pi-plugin/${VERSION}`,
        },
      };
    },
  },
} satisfies Plugin;
