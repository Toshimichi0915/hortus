import { type Agent, createAgent, type Message, type Session, type ToolCall } from "@phi/core";
import { Box, type BoxProps, type DOMElement, Text, useApp, useBoxMetrics, useInput, useWindowSize } from "ink";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { type Entry, entry, formatTool, theme } from "./entry.ts";
import { PromptInput } from "./prompt-input.tsx";
import { Transcript } from "./transcript.tsx";

/** Clips children to its own height. `fromBottom` = rows scrolled up from the end, so 0 follows new content. */
function ScrollBox({ fromBottom, children, ...props }: BoxProps & { fromBottom: number; children: ReactNode }) {
  const view = useRef<DOMElement>(null);
  const content = useRef<DOMElement>(null);
  const max = Math.max(0, useBoxMetrics(content).height - useBoxMetrics(view).height);
  return (
    <Box
      ref={view}
      overflow="hidden"
      flexDirection="column"
      // size from the parent, not from the (taller/wider) content
      flexBasis={0}
      contentOffsetY={max - Math.min(fromBottom, max)}
      {...props}
    >
      <Box ref={content} flexShrink={0} flexDirection="column" width="100%">
        {children}
      </Box>
    </Box>
  );
}

const clamp = (n: number) => Math.max(0, Math.min(n, 10_000));
const k = (n: number) => `${(n / 1000).toFixed(1)}K`;
const pct = (n: number, of: number) => (of ? `${((n / of) * 100).toFixed(1)}%` : "-");

/** Totals over `messages`, context fill from the last reply, and the cache hit rate of the last reply. */
function usageLine(messages: Message[], window?: number) {
  const usages = messages.flatMap((m) => (m.role === "assistant" && m.usage ? [m.usage] : []));
  const sum = (f: (u: (typeof usages)[number]) => number) => usages.reduce((n, u) => n + f(u), 0);
  const input = sum((u) => u.input);
  const last = usages.at(-1);
  const ctx = window ? `${pct(last ? last.input + last.output : 0, window)}/${(window / 1e6).toFixed(1)}M` : "-/-";
  return `↑ ${k(input)} ↓ ${k(sum((u) => u.output))} ${ctx} CH ${pct(last?.cached ?? 0, last?.input ?? 0)}`;
}

export function App({ session, providers }: { session: Session; providers: string[] }) {
  const [entries, setEntries] = useState(() => [
    entry(
      "info",
      `Session: ${session.path} (${session.messages.length} messages)${session.provider ? ` · provider: ${session.provider}` : ""}${session.model ? ` · model: ${session.model}` : ""}`,
    ),
  ]);
  const [live, setLive] = useState({ thinking: "", text: "" });
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  // rows the input is scrolled up from its end; clamped on read by ScrollBox, so overshoot just sticks at the top
  const [inScroll, setInScroll] = useState(0);
  const [copied, setCopied] = useState<number>();
  const [status, setStatus] = useState<{ name: string; model: string; window?: number }>();
  const { rows } = useWindowSize();
  const { exit } = useApp();

  // PromptInput ignores ↑/↓, so they're free to scroll a long input
  useInput((input, key) => {
    if (key.ctrl && input === "d") exit();
    else if (key.ctrl && input === "c") {
      setInput("");
      setInScroll(0);
    } else if (key.escape) aborter.current?.abort();
    else if (key.upArrow) setInScroll((n) => clamp(n + 1));
    else if (key.downArrow) setInScroll((n) => clamp(n - 1));
  });

  const aborter = useRef<AbortController>(null);
  const push = (...e: Entry[]) => setEntries((prev) => [...prev, ...e]);
  // the agent outlives a turn, so its handlers write to the current turn through a ref
  const cur = useRef({ thinking: "", text: "", turn: [] as Message[] });
  // streamed-but-unfinished thinking and text become entries, then the live view resets
  const flush = () => {
    const { thinking, text } = cur.current;
    push(...(thinking ? [entry("thinking", thinking)] : []), ...(text ? [entry("assistant", text)] : []));
    cur.current.thinking = cur.current.text = "";
    setLive({ thinking: "", text: "" });
  };
  const agent = useRef<Promise<Agent>>(null);
  // pending tool blocks by call id, restyled in place when their result arrives
  const calls = useRef(new Map<string, { call: ToolCall; entry: Entry }>());

  // created on first use so a plugin load error is reported like any other
  const getAgent = () =>
    (agent.current ??= createAgent({
      on: {
        thinking: (delta) => {
          cur.current.thinking += delta;
          setLive({ ...cur.current });
        },
        text: (delta) => {
          cur.current.text += delta;
          setLive({ ...cur.current });
        },
        tool_call: (call) => {
          const e = entry("tool", formatTool(call));
          calls.current.set(call.id, { call, entry: e });
          push(e);
        },
        message: (message) => {
          if (message.role === "tool") {
            for (const r of message.results) {
              const c = calls.current.get(r.id);
              if (!c) continue;
              // mutated, not replaced, so the exit transcript sees the result too
              c.entry.kind = r.isError ? "toolError" : "toolOk";
              c.entry.text = formatTool(c.call, r);
              calls.current.delete(r.id);
            }
            setEntries((prev) => [...prev]);
          }
          // an assistant message closes the streamed thinking and text
          flush();
          cur.current.turn.push(message);
        },
      },
    }));

  // resolved again whenever /model or /provider changes the session's choice
  // biome-ignore lint/correctness/useExhaustiveDependencies: getAgent creates the agent once, through a ref
  useEffect(() => {
    getAgent()
      .then((a) => a.resolve({ model: session.model, provider: session.provider }))
      .then(async ({ name, model, provider }) => {
        setStatus({ name, model });
        const window = await provider.contextWindow?.(model).catch(() => undefined);
        setStatus({ name, model, window });
      })
      .catch(() => setStatus(undefined));
  }, [session.model, session.provider]);

  async function submit(value: string) {
    if (!value.trim() || busy) return;
    setInput("");
    setInScroll(0);
    setCopied(undefined);
    const cmd = value.trim().match(/^\/model(?:\s+(\S+))?$/);
    if (cmd) {
      if (!cmd[1]) return push(entry("info", `Model: ${session.model ?? "(config default)"}`));
      await session.setModel(cmd[1]);
      return push(entry("info", `Model set to ${cmd[1]}`));
    }
    const pcmd = value.trim().match(/^\/provider(?:\s+(\S+))?$/);
    if (pcmd) {
      if (!pcmd[1]) return push(entry("info", `Provider: ${session.provider ?? "(config default)"}`));
      if (!providers.includes(pcmd[1]))
        return push(entry("error", `Unknown provider: ${pcmd[1]} (${providers.join(", ")})`));
      await session.setProvider(pcmd[1]);
      return push(entry("info", `Provider set to ${pcmd[1]}`));
    }
    setBusy(true);
    // blank rows pad the message's background, as pi does
    push(entry("user", `\n${value}\n`));
    const turn: Message[] = [{ role: "user", content: value }];
    cur.current = { thinking: "", text: "", turn };
    const abort = new AbortController();
    aborter.current = abort;
    try {
      await (await getAgent())
        .run([...session.messages, ...turn], { model: session.model, provider: session.provider, signal: abort.signal })
        .catch((e) => {
          if (!abort.signal.aborted) throw e;
        });
      if (abort.signal.aborted) {
        // the partial reply stays on screen but not in history; completed messages are kept
        flush();
        // error entries get no separator row, so the leading newline adds one; the next turn adds the one below
        push(entry("error", "\nInterrupted"));
      }
      session.messages.push(...turn);
      // now counted through session.messages
      cur.current.turn = [];
      await session.append(turn);
    } catch (e) {
      flush();
      push(entry("error", e instanceof Error ? e.message : String(e)));
    }
    setBusy(false);
  }

  const prompt = (
    <Box
      flexShrink={0}
      marginTop={1}
      borderStyle="round"
      borderColor={busy ? theme.borderIdle : theme.border}
      paddingX={1}
    >
      <Text color={theme.accent}>{"> "}</Text>
      <ScrollBox flexGrow={1} maxHeight={8} fromBottom={inScroll}>
        <PromptInput value={input} onChange={setInput} onSubmit={submit} />
      </ScrollBox>
    </Box>
  );

  // stable across keystrokes, so Transcript doesn't re-wrap the whole history on every key
  const shown = useMemo(
    () => [
      ...entries,
      ...(live.thinking ? [{ id: -2, kind: "thinking" as const, text: live.thinking }] : []),
      ...(live.text ? [{ id: -1, kind: "assistant" as const, text: live.text }] : []),
    ],
    [entries, live],
  );

  return (
    <Box flexDirection="column" height={rows}>
      <Transcript entries={shown} onWheelBelow={(delta) => setInScroll((n) => clamp(n + delta))} onCopy={setCopied} />
      {prompt}
      <Box justifyContent="space-between">
        <Text color={theme.dim} wrap="truncate">
          {copied === undefined
            ? usageLine([...session.messages, ...cur.current.turn], status?.window)
            : `Copied ${copied} chars`}
        </Text>
        <Text color={theme.dim} wrap="truncate">
          {status && `(${status.name}) ${status.model}`}
        </Text>
      </Box>
    </Box>
  );
}
