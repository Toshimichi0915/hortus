import { Box, type BoxProps, type DOMElement, Text, useApp, useBoxMetrics, useInput, useWindowSize } from "ink";
import { Component, type ComponentType, type ReactNode, useMemo, useRef, useState } from "react";
import { CliContext, type CliPlugin, type Slots, useUi } from "./api.ts";
import type { Cli } from "./cli.ts";
import { theme } from "./entry.ts";
import { PromptInput } from "./prompt-input.tsx";
import { StatusBar } from "./status-bar.tsx";
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
const INPUT_ROWS = 8;

/** A throwing plugin component falls back to the one it replaced instead of taking the whole TUI down. */
class Guard extends Component<
  { fallback: ComponentType; onError: (e: unknown) => void; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError = () => ({ failed: true });
  override componentDidCatch(e: unknown) {
    this.props.onError(e);
  }
  override render() {
    const Fallback = this.props.fallback;
    return this.state.failed ? <Fallback /> : this.props.children;
  }
}

/** Built-in slots, each wrapped by every plugin's override in load order (later plugins end up outermost). */
export function composeSlots(plugins: CliPlugin[], onError: (text: string) => void): Slots {
  const slots: Slots = { statusBar: StatusBar };
  for (const { cli } of plugins)
    for (const k of Object.keys(slots) as (keyof Slots)[]) {
      const Override = cli?.[k];
      if (!Override) continue;
      const Default = slots[k];
      const fail = (e: unknown) =>
        onError(`${k} plugin failed, showing the one it replaced: ${e instanceof Error ? e.message : String(e)}`);
      slots[k] = () => (
        <Guard fallback={Default} onError={fail}>
          <Override Default={Default} />
        </Guard>
      );
    }
  return slots;
}

/** The TUI; plugins' `cli` overrides are composed once into the slots it renders. */
export function App({ cli }: { cli: Cli }) {
  const slots = useMemo(() => composeSlots(cli.plugins as CliPlugin[], cli.report), [cli]);
  return (
    <CliContext value={cli}>
      <Layout cli={cli} slots={slots} />
    </CliContext>
  );
}

function Layout({ cli, slots }: { cli: Cli; slots: Slots }) {
  const entries = useUi((s) => s.entries);
  const live = useUi((s) => s.live);
  const busy = useUi((s) => s.busy);
  const [input, setInput] = useState("");
  // rows the input is scrolled up from its end; clamped on read by ScrollBox, so overshoot just sticks at the top
  const [inScroll, setInScroll] = useState(0);
  const { rows } = useWindowSize();
  const { exit } = useApp();

  useInput((input, key) => {
    if (key.ctrl && input === "d") exit();
    else if (key.ctrl && input === "c") {
      setInput("");
      setInScroll(0);
    } else if (key.escape) cli.abort();
  });

  const submit = (value: string) => {
    if (!cli.submit(value)) return;
    setInput("");
    setInScroll(0);
  };

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
      <Transcript
        entries={shown}
        onWheelBelow={(delta) => setInScroll((n) => clamp(n + delta))}
        onCopy={cli.setCopied}
      />
      <Box
        flexShrink={0}
        marginTop={1}
        borderStyle="round"
        borderColor={busy ? theme.borderIdle : theme.border}
        paddingX={1}
      >
        <Text color={theme.accent}>{"> "}</Text>
        <ScrollBox flexGrow={1} maxHeight={INPUT_ROWS} fromBottom={inScroll}>
          <PromptInput
            value={input}
            onChange={setInput}
            onSubmit={submit}
            // scroll just enough to keep the caret's row in view
            onCaretRow={(row) => setInScroll((n) => Math.min(row, Math.max(n, row - INPUT_ROWS + 1)))}
          />
        </ScrollBox>
      </Box>
      <slots.statusBar />
    </Box>
  );
}
