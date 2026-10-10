import { type Message, runAgent } from "@kanai/core";
import { Box, type BoxProps, type DOMElement, Text, useApp, useBoxMetrics, useInput, useWindowSize } from "ink";
import { type ReactNode, useRef, useState } from "react";
import { type Entry, entry } from "./entry.ts";
import { PromptInput } from "./prompt-input.tsx";
import { Transcript } from "./transcript.tsx";

type Session = { path: string; messages: Message[]; append: (msgs: Message[]) => Promise<void> };
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

export function App({ session }: { session: Session }) {
  const [entries, setEntries] = useState(() => [
    entry("info", `Session: ${session.path} (${session.messages.length} messages)`),
  ]);
  const [live, setLive] = useState("");
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
    } else if (key.upArrow) setInScroll((n) => clamp(n + 1));
    else if (key.downArrow) setInScroll((n) => clamp(n - 1));
  });

  const push = (...e: Entry[]) => setEntries((prev) => [...prev, ...e]);

  async function submit(value: string) {
    if (!value.trim() || busy) return;
    setInput("");
    setInScroll(0);
    setCopied(undefined);
    setBusy(true);
    push(entry("user", value));
    const turn: Message[] = [{ role: "user", content: value }];
    let text = "";
    try {
      for await (const event of runAgent([...session.messages, ...turn], (delta) => {
        text += delta;
        setLive(text);
      })) {
        if (event.type === "tool-call") push(entry("tool", `[${event.call.name}] ${JSON.stringify(event.call.input)}`));
        else {
          // an assistant message closes the streamed text
          if (event.message.role === "assistant" && text) push(entry("assistant", text));
          text = "";
          setLive("");
          turn.push(event.message);
        }
      }
      session.messages.push(...turn);
      await session.append(turn);
    } catch (e) {
      if (text) push(entry("assistant", text));
      setLive("");
      push(entry("error", e instanceof Error ? e.message : String(e)));
    }
    setBusy(false);
  }

  const prompt = (
    <Box flexShrink={0} marginTop={1} borderStyle="round" borderColor={busy ? "gray" : "cyan"} paddingX={1}>
      <Text color="cyan">{"> "}</Text>
      {busy ? (
        <Text dimColor>thinking…</Text>
      ) : (
        <ScrollBox flexGrow={1} maxHeight={8} fromBottom={inScroll}>
          <PromptInput value={input} onChange={setInput} onSubmit={submit} />
        </ScrollBox>
      )}
    </Box>
  );

  return (
    <Box flexDirection="column" height={rows}>
      <Transcript
        entries={live ? [...entries, { id: -1, kind: "assistant", text: live }] : entries}
        onWheelBelow={(delta) => setInScroll((n) => clamp(n + delta))}
        onCopy={setCopied}
      />
      {prompt}
      <Text dimColor wrap="truncate">
        {copied === undefined
          ? "Wheel/PgUp/PgDn scroll · ↑/↓ input · Shift+Enter newline · Ctrl+C clear · Ctrl+D quit"
          : `Copied ${copied} chars`}
      </Text>
    </Box>
  );
}
