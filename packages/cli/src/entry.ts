export type Entry = { id: number; kind: "info" | "user" | "thinking" | "assistant" | "tool" | "error"; text: string };

/** Every entry ever shown, so fullscreen mode can print the conversation to normal scrollback on exit. */
export const transcript: Entry[] = [];

let nextId = 0;
export function entry(kind: Entry["kind"], text: string): Entry {
  const e = { id: nextId++, kind, text };
  transcript.push(e);
  return e;
}

type Style = { color?: string; dimColor?: boolean; italic?: boolean; prefix?: string };

export const styles: Record<Entry["kind"], Style> = {
  info: { dimColor: true },
  user: { color: "cyan", prefix: "> " },
  thinking: { dimColor: true, italic: true },
  assistant: {},
  tool: { color: "yellow", dimColor: true },
  error: { color: "red" },
};
