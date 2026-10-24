import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import {
  lastEntryId,
  listModels,
  loadConfig,
  loadPlugins,
  loadSecrets,
  openSession,
  saveConfig,
  saveSecrets,
} from "@phi/core";
import { Argument, Command } from "commander";
import { render } from "ink";
import { App } from "./app.tsx";
import { transcript } from "./entry.ts";

async function promptHidden(question: string) {
  stdout.write(question);
  // terminal echo goes to a muted stream so the key isn't shown
  const muted = new Writable({ write: (_chunk, _enc, cb) => cb() });
  const rl = createInterface({ input: stdin, output: muted, terminal: true });
  const answer = await rl.question("");
  rl.close();
  stdout.write("\n");
  return answer.trim();
}

const types = Object.keys((await loadPlugins()).providers);
// the names configured in secrets.json, each pointing at one of `types`
const providers = Object.keys(await loadSecrets());
const provider = () => new Argument("<provider>").choices(providers);
const program = new Command("phi")
  .option("-r, --resume [uuid]", "resume the latest session, or the one matching uuid")
  .action(async ({ resume }: { resume?: string | true }) => {
    const session = await openSession(resume ? await lastEntryId(resume) : null);
    // report button presses, drags and wheel (1002) in SGR encoding (1006); always switched back off on exit
    stdout.write("\x1b[?1002h\x1b[?1006h");
    process.on("exit", () => stdout.write("\x1b[?1002l\x1b[?1006l"));
    await render(<App session={session} providers={providers} />, {
      alternateScreen: true,
      exitOnCtrlC: false,
      // lets the terminal report Shift+Enter apart from Enter
      kittyKeyboard: { mode: "auto" },
    }).waitUntilExit();
    // the alternate screen is gone on exit, so leave the conversation in normal scrollback
    for (const e of transcript) console.log(`${e.kind !== "info" && e.kind !== "error" ? "\n" : ""}${e.text}`);
  });

const config = program
  .command("config")
  .description("show or change settings")
  .action(async () => {
    const config = await loadConfig();
    const secrets = await loadSecrets();
    console.log(`provider: ${config.provider ?? "(not set)"}`);
    console.log(`model:    ${config.model ?? "(provider default)"}`);
    for (const [name, s] of Object.entries(secrets)) {
      if (!s) continue;
      console.log(`${`${name}:`.padEnd(16)}${s.type} ...${s.apiKey.slice(-4)}${s.endpoint ? ` ${s.endpoint}` : ""}`);
    }
  });

config
  .command("set-provider")
  .addArgument(provider())
  .action(async (provider: string) => saveConfig({ ...(await loadConfig()), provider }));

config
  .command("set-model")
  .argument("<id>")
  .action(async (model: string) => saveConfig({ ...(await loadConfig()), model }));

config
  .command("models")
  .description("list models of every provider with an API key")
  .action(async () => {
    for (const { provider, id } of await listModels()) console.log(`${provider}: ${id}`);
  });

config
  .command("set-key")
  .description("store an API key under <name> (empty input removes it)")
  .argument("<name>", "name to select with set-provider, e.g. openrouter")
  .addArgument(new Argument("[type]", "provider type (default: the existing one, or <name>)").choices(types))
  .option("--endpoint <url>", "base URL, e.g. https://openrouter.ai/api/v1")
  .action(async (name: string, type: string | undefined, { endpoint }: { endpoint?: string }) => {
    const secrets = await loadSecrets();
    type ??= secrets[name]?.type ?? name;
    if (!types.includes(type)) throw new Error(`Unknown provider type: ${type} (${types.join(", ")})`);
    const apiKey = await promptHidden(`${name} API key (leave empty to remove): `);
    await saveSecrets({ ...secrets, [name]: apiKey ? { type, apiKey, endpoint } : undefined });
  });

await program.parseAsync();
