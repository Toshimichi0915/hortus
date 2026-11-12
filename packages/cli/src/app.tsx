import type { AskEvent, Ctx } from "@hortus/core";
import {
  Box,
  type BoxProps,
  type DOMElement,
  renderToString,
  Text,
  type Key,
  useApp,
  useBoxMetrics,
  useInput,
  useStdout,
  useWindowSize,
} from "ink";
import {
  Component,
  type ComponentType,
  createContext,
  type FunctionComponent,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CliContext, type CliPlugin, PluginCtx, type Slots, theme, useBorderColor, useTheme, useUi } from "./api.ts";
import { AskDialog } from "./ask-dialog.tsx";
import type { Cli } from "./cli.ts";
import { CommandMenu, useCommandMenu } from "./command-menu.tsx";
import type { Entry } from "./entry.ts";
import { PromptInput } from "./prompt-input.tsx";
import { StatusBar } from "./status-bar.tsx";
import {
  builtinTools,
  type EntryBlock,
  type EntryView,
  genericTool,
  type ToolBlock,
  type ToolChrome,
  type ToolView,
} from "./tools.tsx";
import { textBlock, type ToolLookup, Transcript } from "./transcript.tsx";

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
  const slots: Slots = {
    statusBar: StatusBar,
    prompt: InputBox,
    aboveInput: () => null,
    transcript: DefaultTranscript,
  };
  for (const { cli } of plugins)
    for (const k of Object.keys(slots) as (keyof Slots)[]) {
      const Override = cli?.[k];
      if (!Override) continue;
      const Default = slots[k] as ComponentType<object>;
      const Over = Override as ComponentType<{ Default: ComponentType<object> }>;
      const fail = (e: unknown) => onError(`${k} plugin failed, showing the one it replaced: ${message(e)}`);
      // a slot's props (the prompt's `prefix`) reach the override, which passes them on to `Default`
      slots[k] = (props: object) => (
        <Guard fallback={() => <Default {...props} />} onError={fail}>
          <Over {...props} Default={Default} />
        </Guard>
      );
    }
  return slots;
}

/** A renderer whose text is known, over views of type `V` (a tool's `ToolView`, a text entry's `EntryView`). */
interface Block<V> {
  Render: FunctionComponent<V>;
  text: (view: V) => string;
  chrome?: (view: V) => ToolChrome;
}
/** What a plugin gives for a kind: `Render` gets `Default`, `text` the replaced one's. */
interface Override<V> {
  Render: ComponentType<V & { Default: ComponentType<V> }>;
  text?: (view: V, Default: (view: V) => string) => string;
  chrome?: (view: V) => ToolChrome;
}

/**
 * `base` wrapped by `overrides` in order: an override that throws falls back to the one it replaced, reported once per
 * `name`; one without `text` is copied as `renderToString` of what it draws, with `cli` as its context.
 */
function wrapBlock<V extends { width: number }>(
  base: Block<V>,
  overrides: Override<V>[],
  name: string,
  cli: Cli | undefined,
  onError: (text: string) => void,
): Block<V> {
  let current = base;
  let reported = false;
  const fail = (e: unknown) => {
    if (reported) return;
    reported = true;
    onError(`${name} renderer failed, showing the one it replaced: ${message(e)}`);
  };
  for (const override of overrides) {
    const { Render: Default, text: fallbackText, chrome: inner } = current;
    const Over = override.Render as ComponentType<object>;
    // biome-ignore lint/correctness/noComponentHookFactories: made once per kind (cached by the caller), so it's stable
    const Render = (view: V) => (
      <Guard fallback={() => <Default {...view} />} onError={fail}>
        <Over {...view} Default={Default} />
      </Guard>
    );
    const own = override.text;
    const text = own
      ? (view: V) => own(view, fallbackText)
      : (view: V) =>
          renderToString(
            <CliContext value={cli}>
              <Render {...view} />
            </CliContext>,
            { columns: view.width },
          );
    const outer = override.chrome;
    current = {
      Render,
      ...((outer ?? inner) && {
        chrome: (view: V) => {
          try {
            return { ...inner?.(view), ...outer?.(view) };
          } catch (e) {
            fail(e);
            return inner?.(view) ?? {};
          }
        },
      }),
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
}

/** Each entry kind's renderer (see `CliPlugin.cli.entries`); undefined for a text kind no plugin draws. */
export interface EntryLookup {
  tool(name: string): ToolBlock;
  text(kind: string): EntryBlock | undefined;
}

/**
 * Every plugin's `cli.entries` (and `cli.tools`, its `tool:<name>` alias), composed in load order over the built-in
 * renderers: a tool's own, else `tool:*` (the generic one, which plugins may wrap too), then `tool:**` over either; a
 * text kind's own drawing.
 */
export function composeEntries(
  plugins: CliPlugin[],
  cli: Cli | undefined,
  onError: (text: string) => void,
): EntryLookup {
  const overrides = (key: string) =>
    plugins.flatMap(({ cli: c }) => {
      const tool = key.startsWith("tool:") ? c?.tools?.[key.slice(5)] : undefined;
      // biome-ignore lint/suspicious/noExplicitAny: a key's renderers are its view's (tool:* ToolView, else EntryView)
      return [c?.entries?.[key], tool].filter((o) => o !== undefined) as Override<any>[];
    });
  // a tool's renderer before `tool:**`
  const own = new Map<string, ToolBlock>();
  const ownOf = (name: string): ToolBlock => {
    let hit = own.get(name);
    if (!hit) {
      const base = name === "*" ? genericTool : (builtinTools[name] ?? ownOf("*"));
      hit = wrapBlock<ToolView>(base, overrides(`tool:${name}`), name, cli, onError);
      own.set(name, hit);
    }
    return hit;
  };
  const tools = new Map<string, ToolBlock>();
  const texts = new Map<string, EntryBlock | undefined>();
  const lookup: EntryLookup = {
    tool: (name) => {
      let hit = tools.get(name);
      if (!hit) {
        hit = wrapBlock<ToolView>(ownOf(name), overrides("tool:**"), name, cli, onError);
        tools.set(name, hit);
      }
      return hit;
    },
    text: (kind) => {
      if (!texts.has(kind)) {
        const o = overrides(kind);
        texts.set(kind, o.length ? wrapBlock<EntryView>(textBlock, o, kind, cli, onError) : undefined);
      }
      return texts.get(kind);
    },
  };
  return lookup;
}

/** Each tool's renderer: `composeEntries`' `tool:<name>`. */
export const composeTools = (plugins: CliPlugin[], cli: Cli | undefined, onError: (text: string) => void): ToolLookup =>
  composeEntries(plugins, cli, onError).tool;

/** Each ask kind's dialog: the generic one wrapped by every plugin's `cli.asks[kind]` in load order. */
export function composeAsks(plugins: CliPlugin[], onError: (text: string) => void) {
  const cache = new Map<string, ComponentType<{ ask: AskEvent }>>();
  return (kind: string | undefined) => {
    const key = kind ?? "";
    let hit = cache.get(key);
    if (!hit) {
      hit = AskDialog;
      for (const { cli } of plugins) {
        const Over = kind === undefined ? undefined : cli?.asks?.[kind];
        if (!Over) continue;
        const Default = hit;
        const fail = (e: unknown) => onError(`${kind} dialog failed, showing the one it replaced: ${message(e)}`);
        hit = ({ ask }) => (
          <Guard fallback={() => <Default ask={ask} />} onError={fail}>
            <Over ask={ask} Default={Default} />
          </Guard>
        );
      }
      cache.set(key, hit);
    }
    return hit;
  };
}

/** What the default slots share: the composed renderers and dialogs, and the prompt's scroll for the wheel below. */
interface Parts {
  entries: EntryLookup;
  asks: ReturnType<typeof composeAsks>;
  /** wheel rows over the prompt, sent from the transcript (which sees the mouse) */
  wheel: { current: (delta: number) => void };
}
const PartsContext = createContext<Parts | undefined>(undefined);
const useParts = () => {
  const parts = useContext(PartsContext);
  if (!parts) throw new Error("hortus's slots only work inside its TUI");
  return parts;
};
const useCliOf = () => {
  const cli = useContext(CliContext);
  if (!cli) throw new Error("hortus's slots only work inside its TUI");
  return cli;
};

/** `C` drawn with `ctx` as its plugin's (`usePluginCtx`). */
function withCtx<P extends object>(C: ComponentType<P>, ctx: Ctx): ComponentType<P> {
  return (props: P) => (
    <PluginCtx value={ctx}>
      <C {...props} />
    </PluginCtx>
  );
}
const mapValues = <T,>(o: Record<string, T> | undefined, fn: (v: T) => T) =>
  o && Object.fromEntries(Object.entries(o).map(([k, v]) => [k, fn(v)]));

/** `plugin` with every component it gives (slots, renderers, dialogs) drawn with its host ctx. */
function bindUi(plugin: CliPlugin, ctx: Ctx): CliPlugin {
  const c = plugin.cli;
  if (!c) return plugin;
  const out: NonNullable<CliPlugin["cli"]> = { ...c };
  for (const k of ["statusBar", "prompt", "aboveInput", "transcript"] as const) {
    const C = c[k];
    if (C) out[k] = withCtx(C, ctx);
  }
  // biome-ignore lint/suspicious/noExplicitAny: any renderer's `Render`, whatever its view
  const block = <R extends { Render: ComponentType<any> }>(r: R): R => ({ ...r, Render: withCtx(r.Render, ctx) });
  const entries = mapValues(c.entries, block);
  const tools = mapValues(c.tools, block);
  const asks = mapValues(c.asks, (A) => withCtx(A, ctx));
  return { ...plugin, cli: { ...out, ...(entries && { entries }), ...(tools && { tools }), ...(asks && { asks }) } };
}

/** The TUI; plugins' `cli` overrides are composed once into the slots, renderers and dialogs it uses. */
export function App({ cli }: { cli: Cli }) {
  const plugins = useMemo(
    () => cli.agent.plugins.map((p) => bindUi(p.plugin as CliPlugin, cli.agent.ctxOf?.(p.name) ?? cli.agent.ctx)),
    [cli],
  );
  const slots = useMemo(() => composeSlots(plugins, cli.report), [plugins, cli]);
  const parts = useMemo(
    (): Parts => ({
      entries: composeEntries(plugins, cli, cli.report),
      asks: composeAsks(plugins, cli.report),
      wheel: { current: () => {} },
    }),
    [plugins, cli],
  );
  return (
    <CliContext value={cli}>
      <PartsContext value={parts}>
        <Layout cli={cli} slots={slots} />
      </PartsContext>
    </CliContext>
  );
}

function Layout({ cli, slots }: { cli: Cli; slots: Slots }) {
  const { rows } = useWindowSize();
  const { exit, suspendTerminal } = useApp();
  // the stream itself: Ink's own `write` stays off the terminal while it's suspended
  const { stdout } = useStdout();
  const exiting = useUi((s) => s.exiting);
  const ask = useUi((s) => s.asks[0]);
  useEffect(() => {
    if (exiting) exit();
  }, [exiting, exit]);
  useEffect(() => {
    cli.attach({ suspend: (fn) => suspendTerminal(fn), write: (data) => void stdout.write(data) });
    return () => cli.attach(undefined);
  }, [cli, suspendTerminal, stdout]);

  // the only global keys: everything else belongs to the prompt slot (or what replaced it)
  useInput((input, key) => {
    if (key.ctrl && input === "d") exit();
    else if (key.ctrl && input === "o") cli.toggleExpanded();
  });

  return (
    <Box flexDirection="column" height={rows}>
      <slots.transcript />
      <slots.aboveInput />
      {ask ? <Ask ask={ask} /> : <slots.prompt />}
      <slots.statusBar />
    </Box>
  );
}

/** The built-in transcript: the session's entries, then what's streaming. */
function DefaultTranscript() {
  const cli = useCliOf();
  const { entries: lookup, wheel } = useParts();
  const entries = useUi((s) => s.entries);
  const live = useUi((s) => s.live);
  const path = useUi((s) => s.session.path);
  const expanded = useUi((s) => s.expanded);
  const theme = useUi((s) => s.theme);
  // the `header` entry, drawn only when a plugin renders it; a fresh one per session, so its cached text is redone
  const header = !!lookup.text("header");
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new object per session
  const HEADER = useMemo((): Entry => ({ id: -3, kind: "header", text: "" }), [path]);
  // stable across keystrokes, so Transcript doesn't re-wrap the whole history on every key
  const shown = useMemo(
    (): Entry[] => [
      ...(header ? [HEADER] : []),
      ...entries,
      ...(live.thinking
        ? [
            {
              id: -2,
              kind: "thinking" as const,
              text: live.thinking,
              live: live.endedAt === undefined,
              ...(live.startedAt !== undefined && { startedAt: live.startedAt }),
              ...(live.endedAt !== undefined && { endedAt: live.endedAt }),
            },
          ]
        : []),
      ...(live.text ? [{ id: -1, kind: "assistant" as const, text: live.text, live: true }] : []),
    ],
    [header, HEADER, entries, live],
  );
  return (
    <Transcript
      onScroller={cli.attachScroll}
      // another session (/new) starts unscrolled, with nothing selected
      key={path}
      entries={shown}
      tools={lookup.tool}
      texts={lookup.text}
      expanded={expanded}
      theme={theme}
      onWheelBelow={(delta) => wheel.current(delta)}
      onCopy={cli.copy}
    />
  );
}

let asked = 0;
const askIds = new WeakMap<AskEvent, number>();
const askId = (a: AskEvent) => {
  const id = askIds.get(a) ?? asked++;
  askIds.set(a, id);
  return id;
};

/**
 * The pending `ask`'s dialog (its kind's, else the generic one): in the prompt slot's place while one is pending, so a
 * prompt takeover never hides it.
 */
function Ask({ ask }: { ask: AskEvent }) {
  const { asks } = useParts();
  const Dialog = asks(ask.kind);
  // a new one starts fresh
  return <Dialog key={askId(ask)} ask={ask} />;
}

/**
 * The built-in prompt: the input with its `/` menu (`prefix`, default an accent `> `, before the text). Plugins'
 * `cli.keys` see each key first (and may take it); then it owns Esc (hide the menu, else abort the run), Ctrl+C (clear
 * the input) and Shift+Tab (cycle the effort).
 */
function InputBox({ prefix }: { prefix?: ReactNode }) {
  const cli = useCliOf();
  // its CommandMenu child re-renders with it
  useTheme();
  const { wheel } = useParts();
  const border = useBorderColor();
  const input = useUi((s) => s.input);
  const caret = useUi((s) => s.caret);
  const menu = useCommandMenu(cli, input, cli.setInput);
  // rows the input is scrolled up from its end; clamped on read by ScrollBox, so overshoot just sticks at the top
  const [inScroll, setInScroll] = useState(0);
  useEffect(() => {
    wheel.current = (delta) => setInScroll((n) => clamp(n + delta));
  }, [wheel]);

  const onKey = (input: string, key: Key) => {
    if (cli.keys(input, key)) return true;
    if (key.ctrl && input === "c") {
      cli.setInput("");
      setInScroll(0);
    } else if (key.tab && key.shift) cli.cycleEffort();
    else if (key.escape && menu.shown) menu.hide();
    else if (key.escape) cli.abort();
    else return menu.onKey(input, key);
    return true;
  };

  const submit = (value: string) => {
    if (cli.submit(value)) setInScroll(0);
  };

  return (
    <>
      <Box flexShrink={0} marginTop={1} borderStyle="round" borderColor={border} paddingX={1}>
        {prefix ?? <Text color={theme.accent}>{"> "}</Text>}
        <ScrollBox flexGrow={1} maxHeight={INPUT_ROWS} fromBottom={inScroll}>
          <PromptInput
            value={input}
            caret={caret}
            onChange={(value, caret) => cli.setInput(value, { caret })}
            onSubmit={submit}
            onKey={onKey}
            // scroll just enough to keep the caret's row in view
            onCaretRow={(row) => setInScroll((n) => Math.min(row, Math.max(n, row - INPUT_ROWS + 1)))}
          />
        </ScrollBox>
      </Box>
      {menu.shown && <CommandMenu rows={menu.rows} at={menu.at} />}
    </>
  );
}
