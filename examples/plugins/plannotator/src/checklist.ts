/** Plan checklists (`- [ ] step`), as Plannotator's shared checklist module parses and updates them. */
export interface ChecklistItem {
  /** 1-based, what `[DONE:n]` and `plannotator_mark_done` name */
  step: number;
  text: string;
  completed: boolean;
}

// `[^\S\n]`: whitespace except newline, so a blank checkbox line never swallows the next line as its text
const pattern = /^[-*][^\S\n]*\[([ xX])\][^\S\n]+(.+)$/gm;

export function parseChecklist(content: string): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  for (const m of content.matchAll(pattern)) {
    const text = (m[2] ?? "").trim();
    if (text) items.push({ step: items.length + 1, text, completed: m[1] !== " " });
  }
  return items;
}

/** `content` with the boxes of completed `items` checked (never unchecked), everything else as it was. */
export function renderCompleted(content: string, items: ChecklistItem[]): string {
  let step = 0;
  return content.replace(pattern, (line, box: string, text: string) => {
    if (!text.trim()) return line;
    const item = items[step++];
    return box === " " && item?.completed ? line.replace("[ ]", "[x]") : line;
  });
}

/** The steps `[DONE:n]` markers in `text` name. */
export const doneSteps = (text: string) => [...text.matchAll(/\[DONE:(\d+)\]/gi)].map((m) => Number(m[1]));

export const sameSteps = (a: ChecklistItem[], b: ChecklistItem[]) =>
  a.length === b.length && a.every((item, i) => item.text === b[i]?.text);

export function formatTodoList(items: ChecklistItem[]) {
  const remaining = items.filter((i) => !i.completed);
  return {
    todoList: remaining.map((i) => `- [ ] ${i.step}. ${i.text}`).join("\n"),
    completedCount: items.length - remaining.length,
    totalCount: items.length,
    remainingCount: remaining.length,
  };
}

/** The 10 items around the next open one (the progress panel's window). */
export function checklistWindow<T extends { completed: boolean }>(items: readonly T[], max = 10): T[] {
  if (items.length <= max) return [...items];
  const next = items.findIndex((i) => !i.completed);
  const end = next === -1 ? items.length : Math.max(max, next + 1);
  return items.slice(end - max, end);
}
