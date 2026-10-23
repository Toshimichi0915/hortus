import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import {
  lastEntryId,
  listModels,
  loadConfig,
  loadSecrets,
  openSession,
  PROVIDERS,
  type ProviderName,
  saveConfig,
  saveSecrets,
} from "@phi/core";
import { Argument, Command } from "commander";
import { render } from "ink";
import { App } from "./app.tsx";
import { styles, transcript } from "./entry.ts";

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

const provider = () => new Argument("<provider>").choices(PROVIDERS);
const program = new Command("phi")
  .option("-r, --resume [uuid]", "resume the latest session, or the one matching uuid")
  .action(async ({ resume }: { resume?: string | true }) => {
    const session = await openSession(resume ? await lastEntryId(resume) : null);
    // report button presses, drags and wheel (1002) in SGR encoding (1006); always switched back off on exit
    stdout.write("\x1b[?1002h\x1b[?1006h");
    process.on("exit", () => stdout.write("\x1b[?1002l\x1b[?1006l"));
    await render(<App session={session} />, {
      alternateScreen: true,
      exitOnCtrlC: false,
      // lets the terminal report Shift+Enter apart from Enter
      kittyKeyboard: { mode: "auto" },
    }).waitUntilExit();
    // the alternate screen is gone on exit, so leave the conversation in normal scrollback
    for (const e of transcript) console.log(`${e.kind === "user" ? "\n" : ""}${styles[e.kind].prefix ?? ""}${e.text}`);
  });

const config = program
  .command("config")
  .description("show or change settings")
  .action(async () => {
    const config = await loadConfig();
    const secrets = await loadSecrets();
    console.log(`provider: ${config.provider ?? "(not set)"}`);
    console.log(`model:    ${config.model ?? "(provider default)"}`);
    for (const p of PROVIDERS) {
      const key = secrets[p]?.apiKey;
      console.log(`${`${p} key:`.padEnd(16)}${key ? `...${key.slice(-4)}` : "(not set)"}`);
    }
  });

config
  .command("set-provider")
  .addArgument(provider())
  .action(async (provider: ProviderName) => saveConfig({ ...(await loadConfig()), provider }));

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
  .description("store an API key (empty input removes it)")
  .addArgument(provider())
  .action(async (provider: ProviderName) => {
    const apiKey = await promptHidden(`${provider} API key (leave empty to remove): `);
    await saveSecrets({ ...(await loadSecrets()), [provider]: apiKey ? { apiKey } : undefined });
  });

await program.parseAsync();
