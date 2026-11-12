// src/edit-screen.tsx
// The edit flow for one issue: load the team's options -> pick -> confirm -> save.
// It floats as a panel over whatever screen you were on. The screens themselves are in
// edit-views.tsx; the rules (what is offered, what is sent) are in edit.ts; the
// write itself is in mutations.ts.
//
// RISK: pressing Enter on the confirm screen changes real data in Linear. Safeguards:
//  - nothing is sent until the confirm screen's Enter
//  - the save is guarded by a ref, so a second Enter can never send a second request
//  - a burst of keys in one chunk is ignored for Enter (see keys.ts)
//  - if the chosen value is what the issue already has, nothing is sent

import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { useInput, useWindowSize } from "ink";
import type { Key } from "ink";
import { ConfirmView, MessageView, PickerView, confirmHeight, messageHeight, pickerHeight, pickerWindow } from "./edit-views.tsx";
import { useMouse } from "./mouse-context.ts";
import { HEADER_HEIGHT, Panel, insidePanel, panelGeometry } from "./panel.tsx";
import {
  EDIT_FIELD,
  EDIT_TITLE,
  buildOptions,
  changeFor,
  currentLabel,
  describeChange,
  isCurrent,
  needsTeamSettings,
  startIndex,
  warningFor,
} from "./edit.ts";
import type { EditKind, EditOption } from "./edit.ts";
import { expandBurst } from "./keys.ts";
import { getAuthHeader } from "./auth/app-session.ts";
import { cleanText } from "./linear.ts";
import type { Issue } from "./linear.ts";
import { fetchTeamSettings, isDryRun, updateIssue } from "./mutations.ts";

// Where we are in the flow. Once there are options, `cursor` is the chosen one.
type Stage =
  | { name: "loading" }
  | { name: "message"; text: string; error: boolean } // not supported, or couldn't load
  | { name: "pick"; options: EditOption[]; cursor: number }
  | { name: "confirm"; options: EditOption[]; cursor: number }
  | { name: "saving"; options: EditOption[]; cursor: number }
  | { name: "failed"; options: EditOption[]; cursor: number; message: string };

// Priority needs no network, so it starts on the picker. The others load first.
function initialStage(kind: EditKind, issue: Issue): Stage {
  if (needsTeamSettings(kind)) return { name: "loading" };
  const offer = buildOptions(kind, issue, null);
  return "options" in offer
    ? { name: "pick", options: offer.options, cursor: startIndex(kind, issue, offer.options) }
    : { name: "message", text: offer.unsupported, error: false };
}

const errorText = (err: unknown) => cleanText(err instanceof Error ? err.message : String(err));

export function EditScreen({
  issue,
  kind,
  onCancel,
  onDone,
}: {
  issue: Issue;
  kind: EditKind;
  onCancel: () => void; // closed without changing anything
  onDone: (message: string) => void; // the change was applied (or simulated)
}) {
  const { columns, rows } = useWindowSize();

  // The stage lives in a ref so key handlers always see the LATEST one (state would
  // lag a render behind); `rerender` just asks React to redraw.
  const stageRef = useRef<Stage>(initialStage(kind, issue));
  const [, rerender] = useState(0);
  const setStage = (next: Stage) => {
    stageRef.current = next;
    rerender((n) => n + 1);
  };
  // True while a write is in flight. Flipped immediately, so a second Enter can
  // never start a second write.
  const savingRef = useRef(false);

  // Status and estimate need the team's settings first. `cancelled` stops a slow
  // reply from updating the screen after it has closed.
  useEffect(() => {
    if (stageRef.current.name !== "loading") return;
    let cancelled = false;
    void (async () => {
      try {
        const settings = await fetchTeamSettings(await getAuthHeader(), issue.team.key);
        if (cancelled) return;
        const offer = buildOptions(kind, issue, settings);
        setStage(
          "options" in offer
            ? { name: "pick", options: offer.options, cursor: startIndex(kind, issue, offer.options) }
            : { name: "message", text: offer.unsupported, error: false },
        );
      } catch (err) {
        if (!cancelled) setStage({ name: "message", text: errorText(err), error: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [issue, kind]);

  // THE WRITE. Only reachable from Enter on the confirm (or retry) screen.
  const save = async () => {
    const stage = stageRef.current;
    if (stage.name !== "confirm" && stage.name !== "failed") return;
    const option = stage.options[stage.cursor];
    if (!option || savingRef.current) return;
    if (isCurrent(kind, issue, option)) {
      onCancel(); // already that value: nothing to send
      return;
    }

    savingRef.current = true;
    setStage({ name: "saving", options: stage.options, cursor: stage.cursor });
    try {
      const result = await updateIssue(await getAuthHeader(), issue.identifier, changeFor(kind, option));
      onDone(`${result.dryRun ? "(dry run) " : ""}${describeChange(kind, issue, option)}`);
    } catch (err) {
      setStage({ name: "failed", options: stage.options, cursor: stage.cursor, message: errorText(err) });
    } finally {
      savingRef.current = false;
    }
  };

  const moveCursor = (delta: number) => {
    const stage = stageRef.current;
    if (stage.name !== "pick") return;
    const cursor = Math.max(0, Math.min(stage.options.length - 1, stage.cursor + delta));
    setStage({ ...stage, cursor });
  };

  const handleKey = (input: string, key: Key) => {
    const stage = stageRef.current;
    const cancel = key.escape || input === "q";

    switch (stage.name) {
      case "loading":
        if (cancel) onCancel();
        return;
      case "saving":
        return; // a write in flight can't be interrupted, so keys do nothing
      case "message":
        if (cancel || key.return) onCancel();
        return;
      case "pick":
        if (cancel) onCancel();
        else if (key.downArrow || input === "j") moveCursor(1);
        else if (key.upArrow || input === "k") moveCursor(-1);
        else if (input === "g") moveCursor(-stage.options.length);
        else if (input === "G") moveCursor(stage.options.length);
        else if (key.return) setStage({ name: "confirm", options: stage.options, cursor: stage.cursor });
        return;
      case "confirm":
      case "failed":
        if (key.return) void save(); // on "failed" this retries
        else if (key.escape) setStage({ name: "pick", options: stage.options, cursor: stage.cursor });
        else if (input === "q") onCancel();
        return;
    }
  };

  // A chunk like "jj" counts as two presses; a chunk like "\r\r" is ignored
  // (see keys.ts), so a double Enter in one chunk can't double-apply.
  useInput((input, key) => {
    for (const char of expandBurst(input)) handleKey(char, key);
  });

  // ---- Mouse --------------------------------------------------------------------
  // A click can only MOVE AROUND the flow; it can never save. Saving stays Enter on the
  // confirm screen (`save()` is not called from here, and a test checks no write is sent).
  //  - wheel: moves the cursor in the picker
  //  - click outside the panel: cancel (nothing is sent), except while a write is in flight
  //  - click on an option: choose it, which goes to the CONFIRM screen
  // `geometryRef` is set while drawing below, so a click uses the panel as last drawn.
  const geometryRef = useRef<ReturnType<typeof panelGeometry> | null>(null);
  useMouse((event) => {
    const stage = stageRef.current;
    const geometry = geometryRef.current;
    if (stage.name === "saving" || !geometry) return;
    if (event.kind === "wheel") {
      moveCursor(event.direction === "up" ? -1 : 1);
    } else if (event.kind === "press" && event.button === "left") {
      if (!insidePanel(geometry, event.x, event.y)) {
        onCancel();
      } else if (stage.name === "pick") {
        const { start, room } = pickerWindow(stage.options.length, stage.cursor, geometry.contentHeight);
        const row = event.y - (geometry.top + 1 + HEADER_HEIGHT); // 0 = the first visible option
        if (row >= 0 && row < room && start + row < stage.options.length) {
          setStage({ name: "confirm", options: stage.options, cursor: start + row });
        }
      }
    }
  });

  // ---- Drawing ----------------------------------------------------------------
  // The edit flow is a panel that floats, centred, over the screen below. The width
  // depends only on the terminal; each stage then says how tall it needs to be; and
  // the panel is sized and placed from that.
  const title = EDIT_TITLE[kind];
  const stage = stageRef.current;
  const contentWidth = panelGeometry(columns, rows, 0).contentWidth;
  const maxContent = Math.max(3, rows - 4); // leave a line above and below, plus the border

  // What to show: how many lines it wants, and how to draw it at a given height.
  type View = { wanted: number; render: (height: number) => ReactElement };
  const messageView = (text: string, tone: "info" | "error", hint: string): View => ({
    wanted: messageHeight(contentWidth, text),
    render: (height) => (
      <MessageView title={title} issue={issue} message={text} tone={tone} hint={hint} width={contentWidth} height={height} />
    ),
  });

  let view: View;
  if (stage.name === "loading") {
    view = messageView("Loading this team's options…", "info", "esc cancel");
  } else if (stage.name === "message") {
    view = messageView(stage.text, stage.error ? "error" : "info", "esc close");
  } else if (stage.name === "pick") {
    const { options, cursor } = stage;
    view = {
      wanted: pickerHeight(options.length, maxContent),
      render: (height) => (
        <PickerView
          title={title}
          issue={issue}
          options={options}
          cursor={cursor}
          currentIndex={options.findIndex((option) => isCurrent(kind, issue, option))}
          width={contentWidth}
          height={height}
        />
      ),
    };
  } else {
    const option = stage.options[stage.cursor];
    if (!option) return null; // can't happen: the cursor always points at an option
    if (stage.name === "saving") {
      view = messageView(isDryRun() ? "Simulating the change (dry run)…" : "Saving to Linear…", "info", "please wait");
    } else if (stage.name === "failed") {
      view = messageView(`Linear didn't apply the change: ${stage.message}`, "error", "enter retry  esc back  q cancel");
    } else {
      const details = {
        field: EDIT_FIELD[kind],
        from: currentLabel(kind, issue),
        to: option.label,
        toColor: option.color,
        warning: warningFor(kind, option),
        dryRun: isDryRun(),
        noChange: isCurrent(kind, issue, option),
      };
      view = {
        wanted: confirmHeight(contentWidth, details),
        render: (height) => <ConfirmView title={title} issue={issue} {...details} width={contentWidth} height={height} />,
      };
    }
  }

  const geometry = panelGeometry(columns, rows, view.wanted);
  geometryRef.current = geometry;
  return <Panel geometry={geometry}>{view.render(geometry.contentHeight)}</Panel>;
}
