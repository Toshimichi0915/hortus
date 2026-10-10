export type Entry = { id: number; kind: "info" | "user" | "assistant" | "tool" | "error"; text: string };

/** Every entry ever shown, so fullscreen mode can print the conversation to normal scrollback on exit. */
export const transcript: Entry[] = [];

let nextId = 0;
export function entry(kind: Entry["kind"], text: string): Entry {
  const e = { id: nextId++, kind, text };
  transcript.push(e);
  return e;
}

export const styles: Record<Entry["kind"], { color?: string; dimColor?: boolean; prefix?: string }> = {
  info: { dimColor: true },
  user: { color: "cyan", prefix: "> " },
  assistant: {},
  tool: { color: "yellow", dimColor: true },
  error: { color: "red" },
};
