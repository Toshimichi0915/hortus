import {
  Box,
  type BoxProps,
  type DOMElement,
  renderToString,
  Text,
  useApp,
  useBoxMetrics,
  useInput,
  useWindowSize,
} from "ink";
import { Component, type ReactNode, useMemo, useRef, useState } from "react";
import { CliContext, type CliPlugin, type Slots, useUi } from "./api.ts";
import type { Cli } from "./cli.ts";
import { CommandMenu, useCommandMenu } from "./command-menu.tsx";
import { theme } from "./entry.ts";
import { PromptInput } from "./prompt-input.tsx";
import { StatusBar } from "./status-bar.tsx";
import { builtinTools, genericTool, type ToolBlock, type ToolView } from "./tools.tsx";
import { type ToolLookup, Transcript } from "./transcript.tsx";

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
  { fallback: () => ReactNode; onError: (e: unknown) => void; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError = () => ({ failed: true });
  override componentDidCatch(e: unknown) {
    this.props.onError(e);
  }
  override render() {
    return this.state.failed ? this.props.fallback() : this.props.children;
  }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Built-in slots, each wrapped by every plugin's override in load order (later plugins end up outermost). */
export function composeSlots(plugins: CliPlugin[], onError: (text: string) => void): Slots {
  const slots: Slots = { statusBar: StatusBar };
  for (const { cli } of plugins)
    for (const k of Object.keys(slots) as (keyof Slots)[]) {
      const Override = cli?.[k];
      if (!Override) continue;
      const Default = slots[k];
      const fail = (e: unknown) => onError(`${k} plugin failed, showing the one it replaced: ${message(e)}`);
      slots[k] = () => (
        <Guard fallback={() => <Default />} onError={fail}>
          <Override Default={Default} />
        </Guard>
      );
    }
  return slots;
}

/**
 * Each tool's renderer: the built-in one for its name (else the generic one), wrapped by every plugin's `cli.tools`
 * override for that name in load order. An override that throws falls back to the one it replaced, reported once per
 * tool; one without `text` is copied as `renderToString` of what it draws, with `cli` as its context.
 */
export function composeTools(plugins: CliPlugin[], cli: Cli | undefined, onError: (text: string) => void): ToolLookup {
  const composed = new Map<string, ToolBlock>();
  const compose = (name: string) => {
    let current = builtinTools[name] ?? genericTool;
    let reported = false;
    const fail = (e: unknown) => {
      if (reported) return;
      reported = true;
      onError(`${name} renderer failed, showing the one it replaced: ${message(e)}`);
    };
    for (const { cli: c } of plugins) {
      const override = c?.tools?.[name];
      if (!override) continue;
      const { Render: Default, text: fallbackText } = current;
      const Override = override.Render;
      // biome-ignore lint/correctness/noComponentHookFactories: made once per tool name (cached below), so it's stable
      const Render = (view: ToolView) => (
        <Guard fallback={() => <Default {...view} />} onError={fail}>
          <Override {...view} Default={Default} />
        </Guard>
      );
      const text =
        override.text ??
        ((view: ToolView) =>
          renderToString(
            <CliContext value={cli}>
              <Render {...view} />
            </CliContext>,
            { columns: view.width },
          ));
      current = {
        Render,
        text: (view) => {
          try {
            return text(view);
          } catch (e) {
            fail(e);
            return fallbackText(view);
          }
        },
      };
    }
    return current;
  };
  return (name) => {
    const hit = composed.get(name);
    if (hit) return hit;
    const r = compose(name);
    composed.set(name, r);
    return r;
  };
}

/** The TUI; plugins' `cli` overrides are composed once into the slots and tool renderers it uses. */
export function App({ cli }: { cli: Cli }) {
  const slots = useMemo(() => composeSlots(cli.agent.plugins as CliPlugin[], cli.report), [cli]);
  const tools = useMemo(() => composeTools(cli.agent.plugins as CliPlugin[], cli, cli.report), [cli]);
  return (
    <CliContext value={cli}>
      <Layout cli={cli} slots={slots} tools={tools} />
    </CliContext>
  );
}

function Layout({ cli, slots, tools }: { cli: Cli; slots: Slots; tools: ToolLookup }) {
  const entries = useUi((s) => s.entries);
  const live = useUi((s) => s.live);
  const busy = useUi((s) => s.busy);
  const path = useUi((s) => s.session.path);
  const [input, setInput] = useState("");
  const menu = useCommandMenu(cli, input, setInput);
  // rows the input is scrolled up from its end; clamped on read by ScrollBox, so overshoot just sticks at the top
  const [inScroll, setInScroll] = useState(0);
  const { rows } = useWindowSize();
  const { exit } = useApp();

  useInput((input, key) => {
    if (key.ctrl && input === "d") exit();
    else if (key.ctrl && input === "c") {
      setInput("");
      setInScroll(0);
    } else if (key.tab && key.shift) cli.cycleEffort();
    else if (key.escape && menu.shown) menu.hide();
    else if (key.escape) cli.abort();
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
        // another session (/new) starts unscrolled, with nothing selected
        key={path}
        entries={shown}
        tools={tools}
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
            onKey={menu.onKey}
            // scroll just enough to keep the caret's row in view
            onCaretRow={(row) => setInScroll((n) => Math.min(row, Math.max(n, row - INPUT_ROWS + 1)))}
          />
        </ScrollBox>
      </Box>
      {menu.shown && <CommandMenu rows={menu.rows} at={menu.at} />}
      <slots.statusBar />
    </Box>
  );
}
