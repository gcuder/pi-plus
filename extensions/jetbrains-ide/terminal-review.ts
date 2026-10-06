import { relative } from "node:path";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { generateDiffString, renderDiff } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  Input,
  Key,
  matchesKey,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { FileProposal } from "./diff.ts";
import type { ReviewDecision } from "./review.ts";

export type { ReviewDecision };

// Render a control character as inert, visible text so file-origin escape
// sequences stay readable but cannot drive the terminal. "\x1b[31m" in a file
// shows as the literal characters \x1b[31m, and a carriage return shows as \r.
function visibleControl(ch: string): string {
  switch (ch) {
    case "\r": return "\\r";
    case "\t": return "\\t";
    case "\n": return "\\n";
    case "\x1b": return "\\x1b";
  }
  return `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`;
}
// Multiline diff body: keep real newline (line structure) and real tab (renderDiff
// expands tabs) while every other control becomes a visible literal.
function sanitizeBlock(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, visibleControl);
}
// Single-line path: show every control, including tab and newline, as a literal.
function sanitizeInline(text: string): string {
  return text.replace(/[\u0000-\u001F\u007F-\u009F]/g, visibleControl);
}

type ActionId = "accept" | "decline" | "auto";
const ACTIONS: { id: ActionId; label: string; hint?: string }[] = [
  { id: "accept", label: "Accept" },
  { id: "decline", label: "Decline", hint: "Tab to add feedback" },
  { id: "auto", label: "Accept and switch to Auto" },
];

// Rows the dialog spends on everything but the diff body: header, a blank
// separator, three action rows, the action hint, and the scroll indicator, plus
// headroom for Pi's own status/footer row rendered below the component.
const CHROME_ROWS = 7;
const STATUS_RESERVE = 2;
const MIN_DIFF_ROWS = 1;
const DEFAULT_TERMINAL_ROWS = 24;
const H_SCROLL_STEP = 8;

export interface ReviewDialogOptions {
  file: FileProposal;
  displayPath?: string;
  theme: Theme;
  requestRender: () => void;
  done: (decision: ReviewDecision) => void;
  signal?: AbortSignal;
  onToggleMode?: () => void;
  /** Visible terminal height in rows; sizes the scrollable diff viewport live. */
  getTerminalRows?: () => number;
  /** Context lines around each change in the generated diff. */
  contextLines?: number;
}

/**
 * Terminal diff-review dialog. Replaces the input area while the user decides
 * whether to apply one proposed file edit. It renders a colored, scrollable diff
 * and a list of actions, and resolves exactly once through the supplied `done`
 * callback. AbortSignal, Enter/Escape, and the Decline feedback editor all route
 * through the same single-settlement path, so there are no leaks or double writes.
 */
export class ReviewDialog implements Component, Focusable {
  focused = false;

  private readonly theme: Theme;
  private readonly requestRender: () => void;
  private readonly onToggleMode?: () => void;
  private readonly getTerminalRows: () => number;
  private readonly gutterWidth: number;

  private readonly path: string;
  private readonly added: number;
  private readonly removed: number;
  private readonly rawDiff: string;
  private coloredLines?: string[];
  private contentWidthMax?: number;

  private selected = 0;
  private scroll = 0;
  private hScroll = 0;
  private lastWidth = 80;
  private feedbackOpen = false;
  private readonly input: Input;

  private settled = false;
  private readonly signal?: AbortSignal;
  private readonly onAbort = () => this.finish({ action: "cancel" });
  private readonly doneCallback: (decision: ReviewDecision) => void;

  constructor(options: ReviewDialogOptions) {
    this.theme = options.theme;
    this.requestRender = options.requestRender;
    this.onToggleMode = options.onToggleMode;
    this.getTerminalRows = options.getTerminalRows ?? (() => DEFAULT_TERMINAL_ROWS);
    this.doneCallback = options.done;
    this.signal = options.signal;

    this.path = sanitizeInline(options.displayPath ?? options.file.path);
    const original = options.file.originalContent ?? "";
    const proposed = options.file.proposedContent;
    // Diff detection runs on the exact contents; the gutter width matches the
    // padded line numbers generateDiffString emits, so slicing can preserve them.
    this.gutterWidth = 1 + String(Math.max(original.split("\n").length, proposed.split("\n").length)).length + 1;
    const { diff } = generateDiffString(original, proposed, options.contextLines ?? 4);
    this.rawDiff = sanitizeBlock(diff);
    let added = 0;
    let removed = 0;
    for (const line of this.rawDiff.split("\n")) {
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
    }
    this.added = added;
    this.removed = removed;

    this.input = new Input({ placeholder: "Reason for declining (optional)" });
    this.input.onSubmit = value => {
      const feedback = value.trim();
      this.finish(feedback ? { action: "decline", feedback } : { action: "decline" });
    };
    this.input.onEscape = () => this.closeFeedback();

    // Finish once even when the signal is already aborted. Registering first and
    // then checking avoids a race where abort fires between the two.
    if (this.signal) {
      this.signal.addEventListener("abort", this.onAbort, { once: true });
      if (this.signal.aborted) this.finish({ action: "cancel" });
    }
  }

  private cleanup(): void {
    this.signal?.removeEventListener("abort", this.onAbort);
  }

  private finish(decision: ReviewDecision): void {
    if (this.settled) return;
    this.settled = true;
    this.cleanup();
    this.doneCallback(decision);
  }

  private openFeedback(): void {
    this.feedbackOpen = true;
    this.input.setValue("");
    this.input.focused = this.focused;
    this.requestRender();
  }

  private closeFeedback(): void {
    this.feedbackOpen = false;
    this.selected = ACTIONS.findIndex(a => a.id === "decline");
    this.requestRender();
  }

  private get diffLines(): string[] {
    if (!this.coloredLines) this.coloredLines = renderDiff(this.rawDiff).split("\n");
    return this.coloredLines;
  }

  // Diff rows visible at once, derived from the live terminal height so the
  // actions stay on screen in short terminals and across resizes.
  private viewportRows(): number {
    return Math.max(MIN_DIFF_ROWS, this.getTerminalRows() - CHROME_ROWS - STATUS_RESERVE);
  }

  private maxContentWidth(): number {
    if (this.contentWidthMax === undefined) {
      let max = 0;
      for (const line of this.diffLines) {
        const vw = visibleWidth(line);
        if (vw > max) max = vw;
      }
      this.contentWidthMax = max;
    }
    return this.contentWidthMax;
  }

  private maxScroll(): number {
    return Math.max(0, this.diffLines.length - this.viewportRows());
  }

  private maxHScroll(width: number): number {
    return Math.max(0, this.maxContentWidth() - width);
  }

  private scrollBy(delta: number): void {
    const next = Math.min(this.maxScroll(), Math.max(0, this.scroll + delta));
    if (next !== this.scroll) {
      this.scroll = next;
      this.requestRender();
    }
  }

  private hScrollBy(delta: number): void {
    const next = Math.min(this.maxHScroll(this.lastWidth), Math.max(0, this.hScroll + delta));
    if (next !== this.hScroll) {
      this.hScroll = next;
      this.requestRender();
    }
  }

  handleInput(data: string): void {
    // Late keys cannot change anything once the decision is settled; in
    // particular Ctrl+Q must not toggle edit mode after an IDE won the race.
    if (this.settled) return;

    // Ctrl+Q keeps the global Review/Auto toggle live inside the dialog.
    if (matchesKey(data, Key.ctrl("q"))) {
      this.onToggleMode?.();
      this.requestRender();
      return;
    }

    if (this.feedbackOpen) {
      // Input owns Enter (submit) and Escape (back) through its callbacks.
      this.input.handleInput(data);
      this.requestRender();
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.finish({ action: "cancel" });
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.selected = (this.selected - 1 + ACTIONS.length) % ACTIONS.length;
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selected = (this.selected + 1) % ACTIONS.length;
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.left) || matchesKey(data, Key.alt("left"))) return this.hScrollBy(-H_SCROLL_STEP);
    if (matchesKey(data, Key.right) || matchesKey(data, Key.alt("right"))) return this.hScrollBy(H_SCROLL_STEP);
    if (matchesKey(data, Key.pageUp)) return this.scrollBy(-this.viewportRows());
    if (matchesKey(data, Key.pageDown)) return this.scrollBy(this.viewportRows());
    if (matchesKey(data, Key.home)) return this.scrollBy(-this.diffLines.length);
    if (matchesKey(data, Key.end)) return this.scrollBy(this.diffLines.length);
    if (matchesKey(data, Key.tab)) {
      if (ACTIONS[this.selected]!.id === "decline") this.openFeedback();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.confirm(ACTIONS[this.selected]!.id);
      return;
    }
    // Numbers select an action; Enter remains the explicit approval gesture.
    if (["1", "2", "3"].includes(data)) {
      this.selected = Number(data) - 1;
      this.requestRender();
    }
  }

  private confirm(id: ActionId): void {
    if (id === "accept") this.finish({ action: "accept" });
    else if (id === "auto") this.finish({ action: "auto" });
    else this.finish({ action: "decline" });
  }

  // Render one diff row with the line-number gutter pinned and the content
  // horizontally scrolled, so a far-right change can be scrolled into view
  // instead of being truncated away.
  private renderDiffRow(line: string, w: number): string {
    const body = w - this.gutterWidth;
    if (body <= 0) return truncateToWidth(line, w);
    // strict=true drops a wide character that would straddle the right edge,
    // so the row never exceeds the viewport width.
    const gutter = sliceByColumn(line, 0, this.gutterWidth, true);
    const content = sliceByColumn(line, this.gutterWidth + this.hScroll, body, true);
    return gutter + content;
  }

  render(width: number): string[] {
    const w = Math.max(1, width);
    this.lastWidth = w;
    const th = this.theme;
    const fit = (s: string) => truncateToWidth(s, w);
    const lines: string[] = [];

    const summary = `+${this.added} -${this.removed}`;
    lines.push(fit(th.style(`Review edit  ${this.path}  (${summary})`, { fg: "accent", bold: true })));

    const viewport = this.viewportRows();
    const total = this.diffLines.length;
    this.scroll = Math.min(this.scroll, Math.max(0, total - viewport));
    const maxH = this.maxHScroll(w);
    this.hScroll = Math.min(this.hScroll, maxH);
    const end = Math.min(total, this.scroll + viewport);
    for (const line of this.diffLines.slice(this.scroll, end)) lines.push(this.renderDiffRow(line, w));
    if (total > viewport) {
      lines.push(fit(th.style(`  lines ${this.scroll + 1}-${end} of ${total}  ·  PgUp/PgDn to scroll`, { fg: "dim" })));
    }

    lines.push("");

    if (this.feedbackOpen) {
      // Propagate focus so the Input emits CURSOR_MARKER and IME windows align.
      this.input.focused = this.focused;
      lines.push(fit(th.style("Decline with feedback:", { fg: "muted" })));
      for (const line of this.input.render(w)) lines.push(line);
      lines.push(fit(th.style("Enter declines with this feedback  ·  Esc returns to options", { fg: "dim" })));
      return lines;
    }

    for (let i = 0; i < ACTIONS.length; i++) {
      const action = ACTIONS[i]!;
      const active = i === this.selected;
      const pointer = active ? "> " : "  ";
      let label = `${pointer}${i + 1}. ${action.label}`;
      if (action.hint) label += `  (${action.hint})`;
      lines.push(fit(active ? th.style(label, { fg: "accent", bold: true }) : th.style(label, { fg: "muted" })));
    }
    const hint = maxH > 0
      ? "Up/Down select  ·  Left/Right scroll  ·  Enter confirm  ·  Esc cancel"
      : "Up/Down select  ·  Enter confirm  ·  Esc cancel";
    lines.push(fit(th.style(hint, { fg: "dim" })));
    return lines;
  }

  invalidate(): void {
    // A theme change clears cached ANSI. Rebuild colored diff lazily on next render.
    this.coloredLines = undefined;
    this.contentWidthMax = undefined;
    this.input.invalidate();
  }

  dispose(): void {
    // Idempotent; also runs when `done` resolves ctx.ui.custom and it disposes us.
    this.cleanup();
  }
}

/** Build a review dialog without the UI runtime. Exposed for isolated tests. */
export function createReviewDialog(options: ReviewDialogOptions): ReviewDialog {
  return new ReviewDialog(options);
}

/**
 * Review one proposed file edit in the terminal and resolve the user's decision.
 * Returns `{ action: "cancel" }` when there is no interactive terminal UI; the
 * caller coordinates IDE-only approvals in that case.
 */
export async function reviewInTerminal(
  ctx: ExtensionContext,
  file: FileProposal,
  signal: AbortSignal,
  onToggleMode?: () => void,
): Promise<ReviewDecision> {
  if (ctx.mode !== "tui" || !ctx.hasUI) return { action: "cancel" };
  return ctx.ui.custom<ReviewDecision>((tui, theme, _keybindings, done) =>
    createReviewDialog({
      file,
      displayPath: relative(ctx.cwd, file.path),
      theme,
      requestRender: () => tui.requestRender(),
      done,
      signal,
      onToggleMode,
      getTerminalRows: () => tui.terminal.rows,
    }),
  );
}
