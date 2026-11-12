import { type AskEvent, PromptInput, useTheme } from "@hortus/cli";
import { Box, Text, useInput, useStdout } from "ink";
import { useEffect, useState } from "react";
import type { DialogAnswer, Question } from "./engine.ts";
import type { AskData, DialogResult } from "./index.tsx";

export const CUSTOM_ROW_LABEL = "Type something.";
export const NOTE_ROW_LABEL = "Add a note";

interface Tab {
  selected: string[];
  text?: string;
  note?: string;
}

type Focus = "browse" | "type" | "note";

const answered = (t: Tab) => t.selected.length > 0 || !!t.text?.trim();

/**
 * pi-decide's questionnaire dialog (`cli.asks.decide`): a tab per question plus a Submit tab that reviews the answers;
 * numbered options (checkboxes for `multiSelect`) with descriptions, ★ on the model's recommendation, the focused
 * option's preview, a "Type something." row and an "Add a note" row; `n` adds a note (on Submit, a global one);
 * `c` / Ctrl+] collapses it to one line. While the autopilot counts down it says so; the first key (or anyone engaging the
 * ask, e.g. a remote client) stops it.
 */
export function DecideDialog({ ask }: { ask: AskEvent }) {
  const theme = useTheme();
  const data = ask.data as AskData;
  const questions = data.questionnaire.questions;
  const { stdout } = useStdout();
  const [tabs, setTabs] = useState<Tab[]>(() => questions.map(() => ({ selected: [] })));
  const [tab, setTab] = useState(0);
  const [index, setIndex] = useState(0);
  const [focus, setFocus] = useState<Focus>("browse");
  const [noteTarget, setNoteTarget] = useState<"question" | "global">("question");
  const [draft, setDraft] = useState("");
  const [globalNote, setGlobalNote] = useState<string>();
  const [collapsed, setCollapsed] = useState(false);
  const [here, setHere] = useState(data.timeoutSeconds === undefined);
  // mounted when shown: the countdown (this plugin's `ask` handler) starts then too
  const [endsAt] = useState(() => Date.now() + (data.timeoutSeconds ?? 0) * 1000);
  const [now, setNow] = useState(Date.now);
  useEffect(() => void ask.engaged.then(() => setHere(true)), [ask]);

  useEffect(() => {
    if (data.bell) stdout.write("\x07");
  }, [data, stdout]);
  useEffect(() => {
    if (here) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [here]);

  const onSubmitTab = tab >= questions.length;
  const question = questions[tab] as Question | undefined;
  const state = tabs[tab];
  const countdown = here ? undefined : Math.max(0, Math.ceil((endsAt - now) / 1000));

  /** Any real interaction means a human is here: stop counting down. */
  const takeOver = () => ask.engage();
  const update = (i: number, change: Partial<Tab>) =>
    setTabs((all) => all.map((t, n) => (n === i ? { ...t, ...change } : t)));

  const submit = (final: Tab[]) => {
    if (ask.signal.aborted) return;
    const answers = final.map((t, i): [number, DialogAnswer] => [
      i,
      {
        selected: t.selected,
        ...(t.text !== undefined && { text: t.text }),
        ...(t.note !== undefined && { note: t.note }),
      },
    ]);
    const value: DialogResult = { answers, ...(globalNote !== undefined && { globalNote }) };
    ask.resolve(
      final.map((t, i) => `${questions[i]?.header}: ${t.text ?? (t.selected.join(", ") || "(no answer)")}`).join("; "),
      { value },
    );
  };

  /** After an answer: one question submits; else the next unanswered question, else the Submit tab. */
  const advance = (final: Tab[]) => {
    setTabs(final);
    if (questions.length === 1) return submit(final);
    setIndex(0);
    for (let off = 1; off <= final.length; off++) {
      const i = (tab + off) % final.length;
      if (!answered(final[i] as Tab)) return setTab(i);
    }
    setTab(questions.length);
  };

  const openEditor = (mode: "type" | "note", initial: string, target: "question" | "global" = "question") => {
    setFocus(mode);
    setNoteTarget(target);
    setDraft(initial);
  };

  const commit = (typed: string) => {
    const value = typed.trim() || undefined;
    setFocus("browse");
    setDraft("");
    if (focus === "note") {
      if (noteTarget === "global") setGlobalNote(value);
      else update(tab, { note: value });
      return;
    }
    if (!value) return update(tab, { text: undefined });
    advance(tabs.map((t, n) => (n === tab ? { ...t, text: value, selected: [] } : t)));
  };

  const options = question?.options ?? [];
  // the option rows, then "Type something." and "Add a note"
  const rowCount = options.length + 2;

  useInput(
    (input, key) => {
      const collapseKey = input === "\x1d" || (key.ctrl && input === "]");
      if (collapsed) {
        if (collapseKey || input === "c") setCollapsed(false);
        else if (key.escape) ask.resolve(undefined);
        return;
      }
      if (collapseKey || input === "c") return setCollapsed(true);
      if (key.escape) return ask.resolve(undefined);
      takeOver();
      if (questions.length > 1 && (key.tab || key.leftArrow || key.rightArrow)) {
        const total = questions.length + 1;
        setTab((tab + (key.leftArrow || (key.tab && key.shift) ? -1 : 1) + total) % total);
        setIndex(0);
        return;
      }
      if (onSubmitTab) {
        if (key.return) {
          const missing = tabs.findIndex((t) => !answered(t));
          if (missing === -1) submit(tabs);
          else {
            setTab(missing);
            setIndex(0);
          }
        } else if (input === "n") openEditor("note", globalNote ?? "", "global");
        return;
      }
      if (!question || !state) return;
      if (key.upArrow) return setIndex((i) => Math.max(0, i - 1));
      if (key.downArrow) return setIndex((i) => Math.min(rowCount - 1, i + 1));
      if (input === "n") return openEditor("note", state.note ?? "");
      if (index === options.length) return key.return && openEditor("type", state.text ?? "");
      if (index === options.length + 1) return key.return && openEditor("note", state.note ?? "");
      const label = options[index]?.label as string;
      const ordered = (picked: string[]) => options.map((o) => o.label).filter((l) => picked.includes(l));
      if (question.multiSelect) {
        if (input === " ") {
          const picked = state.selected.includes(label)
            ? state.selected.filter((l) => l !== label)
            : [...state.selected, label];
          update(tab, { selected: ordered(picked), text: undefined });
        } else if (key.return) {
          const picked = state.selected.length ? state.selected : [label];
          advance(tabs.map((t, n) => (n === tab ? { ...t, selected: ordered(picked), text: undefined } : t)));
        }
        return;
      }
      if (key.return) advance(tabs.map((t, n) => (n === tab ? { ...t, selected: [label], text: undefined } : t)));
      // while typing an answer or a note, its input box reads the keys
    },
    { isActive: focus === "browse" || collapsed },
  );

  const done = tabs.filter(answered).length;
  const name = onSubmitTab ? "submit" : (question?.header ?? "");
  if (collapsed)
    return (
      <Box flexShrink={0}>
        <Text color={theme.accent}>[ + expand ]</Text>
        <Text color={theme.dim}>
          {` ask_user_question · ${name} · ${done}/${questions.length} answered${countdown !== undefined ? ` · ⏱ ${countdown}s` : ""} · ctrl+] or c to expand`}
        </Text>
      </Box>
    );

  const hint =
    focus === "type"
      ? "Enter saves the answer · Esc back to the list"
      : focus === "note"
        ? "Enter saves the note · Esc discards"
        : onSubmitTab
          ? `Enter submit${questions.length > 1 ? " · Tab/←→ tabs" : ""} · n global note · Esc cancel · c collapse`
          : [
              "↑↓ move",
              "Enter pick",
              question?.multiSelect && "Space toggle",
              questions.length > 1 && "Tab/←→ tabs",
              "n note",
              "Esc cancel",
              "c collapse",
            ]
              .filter(Boolean)
              .join(" · ");
  const deadline = data.deadlineKind === "deadline";

  return (
    <Box
      flexShrink={0}
      flexDirection="column"
      borderStyle="single"
      borderLeft={false}
      borderRight={false}
      borderColor={theme.borderIdle}
    >
      <Box justifyContent="space-between">
        <Text color={theme.muted}> ask_user_question </Text>
        <Text color={theme.accent}>[ − collapse ]</Text>
      </Box>
      {questions.length > 1 && (
        <Box flexWrap="wrap" columnGap={1} marginBottom={1}>
          {questions.map((q, i) => {
            const t = tabs[i] as Tab;
            const label = ` ${answered(t) ? "■" : "□"} ${q.header} `;
            return i === tab ? (
              <Text key={q.header} bold inverse>
                {label}
              </Text>
            ) : (
              <Text key={q.header} color={answered(t) ? theme.green : theme.muted}>
                {label}
              </Text>
            );
          })}
          {onSubmitTab ? (
            <Text bold inverse>
              {" ✔ Submit "}
            </Text>
          ) : (
            <Text color={tabs.every(answered) ? theme.green : theme.dim}> ✔ Submit </Text>
          )}
        </Box>
      )}
      {onSubmitTab ? (
        <Review questions={questions} tabs={tabs} globalNote={globalNote} />
      ) : (
        question &&
        state && (
          <Box flexDirection="column">
            <Text>
              <Text color={theme.accent}>{` ${question.header}`}</Text>
              {question.category && <Text color={theme.dim}>{` · ${question.category}`}</Text>}
            </Text>
            <Text bold color={theme.text}>{` ${question.question}`}</Text>
            {question.recommendedBecause && (
              <Text color={theme.dim}>{` ★ ${question.recommended}: ${question.recommendedBecause}`}</Text>
            )}
            <Text> </Text>
            {options.map((o, i) => {
              const at = i === index;
              const marker = question.multiSelect ? (state.selected.includes(o.label) ? "✓ " : "▢ ") : `${i + 1}. `;
              return (
                <Box key={o.label} flexDirection="column">
                  <Text>
                    <Text color={theme.accent}>{at ? "❯ " : "  "}</Text>
                    <Text color={state.selected.includes(o.label) ? theme.green : theme.dim}>{marker}</Text>
                    <Text color={at ? theme.accent : theme.text}>{o.label}</Text>
                    {question.recommended === o.label && <Text color={theme.green}> ★</Text>}
                  </Text>
                  <Text color={theme.muted}>{`     ${o.description}`}</Text>
                  {at && o.preview && (
                    <Box borderStyle="single" borderColor={theme.borderIdle} marginLeft={5} flexDirection="column">
                      <Text color={theme.dim}>{`preview: ${o.label}`}</Text>
                      <Text>{o.preview}</Text>
                    </Box>
                  )}
                </Box>
              );
            })}
            {[
              state.text ? `${CUSTOM_ROW_LABEL} ${state.text}` : CUSTOM_ROW_LABEL,
              state.note ? `${NOTE_ROW_LABEL} — ${state.note}` : NOTE_ROW_LABEL,
            ].map((label, n) => {
              const i = options.length + n;
              return (
                <Text key={label}>
                  <Text color={theme.accent}>{i === index ? "❯ " : "  "}</Text>
                  <Text>{question.multiSelect ? "  " : `${i + 1}. `}</Text>
                  <Text color={i === index ? theme.accent : theme.muted}>{label}</Text>
                </Text>
              );
            })}
          </Box>
        )
      )}
      {focus !== "browse" && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.muted}>{focus === "type" ? " Your answer:" : " Note:"}</Text>
          <Box>
            <Text color={theme.accent}>{" > "}</Text>
            <Box flexGrow={1}>
              <PromptInput
                value={draft}
                onChange={setDraft}
                onSubmit={commit}
                onKey={(input, key) => {
                  takeOver();
                  if (key.escape) {
                    setFocus("browse");
                    setDraft("");
                  } else if (input === "\x1d" || (key.ctrl && input === "]")) setCollapsed(true);
                  else return false;
                  return true;
                }}
              />
            </Box>
          </Box>
        </Box>
      )}
      <Text> </Text>
      {countdown !== undefined && (
        <Text color={theme.yellow}>
          {`⏱  ${deadline ? "nobody answered — autopilot takes over in" : "autopilot answers in"} ${countdown}s — press any key to keep answering (${data.hint ?? (deadline ? "nobody has answered" : "autopilot will answer")})`}
        </Text>
      )}
      <Text color={theme.dim}>{`  ${hint}`}</Text>
    </Box>
  );
}

/** The Submit tab: unanswered questions first (they block submitting), then the answers and notes. */
function Review({ questions, tabs, globalNote }: { questions: Question[]; tabs: Tab[]; globalNote?: string }) {
  const theme = useTheme();
  const missing = questions.flatMap((q, i) => (answered(tabs[i] as Tab) ? [] : [q]));
  return (
    <Box flexDirection="column">
      <Text color={theme.accent}> Review before submitting</Text>
      <Text> </Text>
      {missing.map((q) => (
        <Text key={q.header}>
          <Text color={theme.accent}>{`  ${q.header} `}</Text>
          {q.category && <Text color={theme.dim}>{`(${q.category}) `}</Text>}
          <Text color={theme.yellow}>— unanswered</Text>
        </Text>
      ))}
      {questions.map((q, i) => {
        const t = tabs[i] as Tab;
        if (!answered(t)) return null;
        return (
          <Box key={q.header} flexDirection="column">
            <Text>
              <Text color={theme.accent}>{`  ${q.header} `}</Text>
              {q.category && <Text color={theme.dim}>{`(${q.category}) `}</Text>}
              <Text color={theme.text}>{t.text ?? t.selected.join(", ")}</Text>
            </Text>
            {t.note && <Text color={theme.muted}>{`    note: ${t.note}`}</Text>}
          </Box>
        );
      })}
      {globalNote && <Text color={theme.muted}>{`  global note: ${globalNote}`}</Text>}
      <Text> </Text>
      <Text color={missing.length ? theme.yellow : theme.green}>
        {missing.length ? "  Enter jumps to the first unanswered question" : "  Enter submits"}
      </Text>
    </Box>
  );
}
