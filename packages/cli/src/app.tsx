import { type Agent, createAgent, type Message, type Session, type ToolCall } from "@phi/core";
import { Box, type BoxProps, type DOMElement, Text, useApp, useBoxMetrics, useInput, useWindowSize } from "ink";
import { type ReactNode, useRef, useState } from "react";
import { type Entry, entry, formatTool } from "./entry.ts";
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
    push(entry("user", value));
    const turn: Message[] = [{ role: "user", content: value }];
    cur.current = { thinking: "", text: "", turn };
    const abort = new AbortController();
    aborter.current = abort;
    try {
      // created on first submit so a plugin load error is reported like any other
      agent.current ??= createAgent({
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
      });
      await (await agent.current)
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
      await session.append(turn);
    } catch (e) {
      flush();
      push(entry("error", e instanceof Error ? e.message : String(e)));
    }
    setBusy(false);
  }

  const prompt = (
    <Box flexShrink={0} marginTop={1} borderStyle="round" borderColor={busy ? "gray" : "cyan"} paddingX={1}>
      <Text color="cyan">{"> "}</Text>
      <ScrollBox flexGrow={1} maxHeight={8} fromBottom={inScroll}>
        <PromptInput value={input} onChange={setInput} onSubmit={submit} />
      </ScrollBox>
    </Box>
  );

  return (
    <Box flexDirection="column" height={rows}>
      <Transcript
        entries={[
          ...entries,
          ...(live.thinking ? [{ id: -2, kind: "thinking" as const, text: live.thinking }] : []),
          ...(live.text ? [{ id: -1, kind: "assistant" as const, text: live.text }] : []),
        ]}
        onWheelBelow={(delta) => setInScroll((n) => clamp(n + delta))}
        onCopy={setCopied}
      />
      {prompt}
      <Text dimColor wrap="truncate">
        {copied === undefined
          ? "Wheel/PgUp/PgDn scroll · ↑/↓ input · Shift+Enter newline · Esc interrupt · Ctrl+C clear · Ctrl+D quit"
          : `Copied ${copied} chars`}
      </Text>
    </Box>
  );
}
