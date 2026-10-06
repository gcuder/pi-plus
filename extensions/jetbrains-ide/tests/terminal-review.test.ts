import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { createReviewDialog, reviewInTerminal, type ReviewDecision } from "../terminal-review.ts";
import type { FileProposal } from "../diff.ts";

// Public theme setup: initialize the global theme renderDiff reads from.
initTheme();

// A minimal theme that records nothing and returns text untouched. renderDiff
// (used for the diff body) uses the real global theme instead of this stub.
const theme = {
  style: (text: string) => text,
  fg: (_c: string, text: string) => text,
  bg: (_c: string, text: string) => text,
} as unknown as Theme;

// Terminal key byte sequences.
const KEY = {
  up: "\x1b[A",
  down: "\x1b[B",
  left: "\x1b[D",
  right: "\x1b[C",
  enter: "\r",
  tab: "\t",
  escape: "\x1b",
  pageDown: "\x1b[6~",
  pageUp: "\x1b[5~",
  home: "\x1b[H",
  end: "\x1b[F",
  ctrlQ: "\x11",
};

function makeFile(overrides: Partial<FileProposal> = {}): FileProposal {
  return {
    path: "/repo/src/example.ts",
    originalContent: "line one\nline two\nline three\n",
    proposedContent: "line one\nline TWO\nline three\n",
    ...overrides,
  };
}

function setup(overrides: {
  file?: Partial<FileProposal>;
  getTerminalRows?: () => number;
  onToggleMode?: () => void;
  signal?: AbortSignal;
} = {}) {
  const results: ReviewDecision[] = [];
  let renders = 0;
  const dialog = createReviewDialog({
    file: makeFile(overrides.file),
    theme,
    requestRender: () => { renders++; },
    done: d => results.push(d),
    signal: overrides.signal,
    onToggleMode: overrides.onToggleMode,
    getTerminalRows: overrides.getTerminalRows,
  });
  return { dialog, results, renderCount: () => renders };
}

const plain = (lines: string[]) => lines.map(stripTerminalSequences);

test("renders a header, a colored diff with line numbers, and the three actions in order", () => {
  const { dialog } = setup();
  const lines = plain(dialog.render(80));
  assert.match(lines[0]!, /Review edit/);
  assert.match(lines[0]!, /example\.ts/);
  assert.match(lines[0]!, /\+1 -1/);
  // Diff body carries line numbers and the changed lines.
  assert.ok(lines.some(l => /-2 line two/.test(l)), "shows removed line with number");
  assert.ok(lines.some(l => /\+2 line TWO/.test(l)), "shows added line with number");
  const accept = lines.findIndex(l => /1\. Accept\b/.test(l));
  const decline = lines.findIndex(l => /2\. Decline/.test(l));
  const auto = lines.findIndex(l => /3\. Accept and switch to Auto/.test(l));
  assert.ok(accept >= 0 && decline > accept && auto > decline, "actions appear in order");
  assert.match(lines[decline]!, /Tab to add feedback/);
});

test("arrow keys move the selection and Enter confirms accept/auto", () => {
  const a = setup();
  a.dialog.handleInput(KEY.enter); // Accept selected by default
  assert.deepEqual(a.results, [{ action: "accept" }]);

  const b = setup();
  b.dialog.handleInput(KEY.up); // wraps to last action: auto
  b.dialog.handleInput(KEY.enter);
  assert.deepEqual(b.results, [{ action: "auto" }]);

  const c = setup();
  c.dialog.handleInput(KEY.down); // -> decline
  c.dialog.handleInput(KEY.down); // -> auto
  c.dialog.handleInput(KEY.enter);
  assert.deepEqual(c.results, [{ action: "auto" }]);
});

test("Enter on Decline declines with no feedback", () => {
  const { dialog, results } = setup();
  dialog.handleInput(KEY.down); // -> decline
  dialog.handleInput(KEY.enter);
  assert.deepEqual(results, [{ action: "decline" }]);
});

test("Tab on Decline opens inline feedback, typing then Enter declines with feedback", () => {
  const { dialog, results } = setup();
  dialog.focused = true;
  dialog.handleInput(KEY.down); // -> decline
  dialog.handleInput(KEY.tab); // open feedback editor
  let lines = plain(dialog.render(80));
  assert.ok(lines.some(l => /Decline with feedback/.test(l)), "feedback editor shown");
  assert.ok(lines.some(l => /Esc returns to options/.test(l)), "feedback hint shown");
  for (const ch of "needs tests") dialog.handleInput(ch);
  lines = plain(dialog.render(80));
  assert.ok(lines.some(l => /needs tests/.test(l)), "typed feedback is visible");
  dialog.handleInput(KEY.enter);
  assert.deepEqual(results, [{ action: "decline", feedback: "needs tests" }]);
});

test("Escape inside feedback returns to the options without settling", () => {
  const { dialog, results } = setup();
  dialog.handleInput(KEY.down); // -> decline
  dialog.handleInput(KEY.tab); // open feedback
  dialog.handleInput(KEY.escape); // back to options
  assert.deepEqual(results, [], "still undecided after leaving feedback");
  const lines = plain(dialog.render(80));
  assert.ok(lines.some(l => /2\. Decline/.test(l)), "options restored");
  assert.ok(!lines.some(l => /Decline with feedback/.test(l)), "feedback editor closed");
  dialog.handleInput(KEY.enter); // decline is still selected
  assert.deepEqual(results, [{ action: "decline" }]);
});

test("the focused cursor marker is propagated to the feedback input", () => {
  const { dialog } = setup();
  dialog.focused = true;
  dialog.handleInput(KEY.down);
  dialog.handleInput(KEY.tab);
  const raw = dialog.render(80).join("\n");
  // CURSOR_MARKER is the APC sequence the Input emits only when focused.
  assert.ok(raw.includes("\u001b_pi:c\u0007"), "cursor marker present when focused");
});

test("Escape in options returns cancel", () => {
  const { dialog, results } = setup();
  dialog.handleInput(KEY.escape);
  assert.deepEqual(results, [{ action: "cancel" }]);
});

test("numeric shortcuts select an action but require Enter to confirm", () => {
  for (const [key, action] of [["1", "accept"], ["2", "decline"], ["3", "auto"]]) {
    const { dialog, results } = setup();
    dialog.handleInput(key!);
    assert.deepEqual(results, [], "selection alone must not authorize an edit");
    dialog.handleInput(KEY.enter);
    assert.deepEqual(results, [{ action }]);
  }
});

test("Ctrl+Q invokes the toggle callback without settling the dialog", () => {
  let toggled = 0;
  const { dialog, results } = setup({ onToggleMode: () => { toggled++; } });
  dialog.handleInput(KEY.ctrlQ);
  assert.equal(toggled, 1);
  assert.deepEqual(results, [], "dialog stays open after toggle");
  dialog.handleInput(KEY.enter);
  assert.deepEqual(results, [{ action: "accept" }]);
});

test("keys are ignored after settlement, so a late Ctrl+Q cannot change mode", () => {
  let toggled = 0;
  const { dialog, results } = setup({ onToggleMode: () => { toggled++; } });
  dialog.handleInput(KEY.enter); // accept -> settled
  assert.deepEqual(results, [{ action: "accept" }]);
  dialog.handleInput(KEY.ctrlQ); // late key after an IDE/decision won
  dialog.handleInput(KEY.escape);
  dialog.handleInput(KEY.enter);
  assert.equal(toggled, 0, "no mode toggle after settlement");
  assert.deepEqual(results, [{ action: "accept" }], "no further decisions after settlement");
});

test("diff viewport tracks terminal height so actions stay visible on resize", () => {
  const original = Array.from({ length: 60 }, (_, i) => `row ${i}`).join("\n") + "\n";
  const proposed = original.replace("row 0", "ROW 0").replace("row 59", "ROW 59");
  let rows = 20;
  const { dialog } = setup({ file: { originalContent: original, proposedContent: proposed }, getTerminalRows: () => rows });
  for (const height of [20, 10, 40, 15]) {
    rows = height; // simulate a resize between renders
    const out = dialog.render(80);
    assert.ok(out.length <= height, `total lines ${out.length} fit ${height} rows`);
    const p = plain(out);
    assert.ok(p.some(l => /1\. Accept\b/.test(l)), `Accept visible at ${height} rows`);
    assert.ok(p.some(l => /2\. Decline/.test(l)), `Decline visible at ${height} rows`);
    assert.ok(p.some(l => /3\. Accept and switch to Auto/.test(l)), `Auto visible at ${height} rows`);
    assert.ok(p.some(l => /Enter confirm/.test(l)), `footer visible at ${height} rows`);
  }
});

test("long diffs scroll with page keys while actions stay visible", () => {
  const original = Array.from({ length: 60 }, (_, i) => `row ${i}`).join("\n") + "\n";
  const proposed = original.replace("row 0", "ROW 0").replace("row 59", "ROW 59");
  // rows=15 leaves a 6-line diff viewport (15 - chrome 7 - status 2).
  const { dialog } = setup({ file: { originalContent: original, proposedContent: proposed }, getTerminalRows: () => 15 });
  const first = plain(dialog.render(80));
  assert.ok(first.some(l => /lines 1-6 of/.test(l)), "scroll indicator shows the window");
  assert.ok(first.some(l => /Up\/Down select/.test(l)), "actions visible before scrolling");
  dialog.handleInput(KEY.pageDown);
  const scrolled = plain(dialog.render(80));
  assert.ok(scrolled.some(l => /lines 7-12 of/.test(l)), "page down advances the window");
  assert.ok(scrolled.some(l => /Up\/Down select/.test(l)), "actions remain visible after scrolling");
  dialog.handleInput(KEY.end);
  const atEnd = plain(dialog.render(80));
  const endLine = atEnd.find(l => /lines \d+-\d+ of (\d+)/.test(l))!;
  const totalMatch = endLine.match(/of (\d+)/)!;
  assert.match(endLine, new RegExp(`-${totalMatch[1]} of ${totalMatch[1]}`));
  dialog.handleInput(KEY.home);
  assert.ok(plain(dialog.render(80)).some(l => /lines 1-6 of/.test(l)), "home returns to the top");
});

test("a far-right change is reachable by horizontal scrolling with the line number kept", () => {
  const original = "const value = 1;\n";
  const proposed = "const value = 1; /* padding padding padding padding padding padding padding padding padding */ FARRIGHT_CHANGE;\n";
  const { dialog } = setup({ file: { originalContent: original, proposedContent: proposed } });
  const width = 60;
  const atStart = plain(dialog.render(width));
  assert.ok(!atStart.some(l => /FARRIGHT_CHANGE/.test(l)), "far-right token hidden before scrolling");
  assert.ok(atStart.some(l => /Left\/Right scroll/.test(l)), "horizontal scroll hint is offered");
  for (let i = 0; i < 20; i++) dialog.handleInput(KEY.right);
  const scrolled = plain(dialog.render(width));
  const changeLine = scrolled.find(l => /FARRIGHT_CHANGE/.test(l));
  assert.ok(changeLine, "far-right token visible after scrolling");
  assert.match(changeLine!, /^\+\s*\d+/, "line-number gutter preserved while scrolled");
  for (const line of scrolled) assert.ok(visibleWidth(line) <= width, `line fits width ${width}`);
  // Left scroll brings the gutter-aligned start back into view.
  for (let i = 0; i < 20; i++) dialog.handleInput(KEY.left);
  assert.ok(!plain(dialog.render(width)).some(l => /FARRIGHT_CHANGE/.test(l)), "scrolling back hides it again");
});

test("every rendered line fits a narrow width and handles wide characters", () => {
  const original = "alpha\n";
  const proposed = "alpha 日本語テスト 🚀  growing much wider than any narrow terminal column budget\n";
  const { dialog } = setup({ file: { path: "/repo/深い/ディレクトリ/ファイル.ts", originalContent: original, proposedContent: proposed } });
  for (const width of [10, 20, 40]) {
    for (const line of dialog.render(width)) {
      assert.ok(visibleWidth(line) <= width, `line "${line}" exceeds width ${width}`);
    }
  }
});

test("control sequences in path and contents appear as inert visible literals", () => {
  const original = "safe\n";
  const proposed = "safe\nX\u001b[31mred\rmore\u0007\u0000bell\n";
  const { dialog } = setup({ file: { path: "/repo/\u001b]0;pwned\u0007evil\u0000.ts", originalContent: original, proposedContent: proposed } });
  const raw = dialog.render(120).join("\n");
  const text = stripTerminalSequences(raw); // drop the dialog's own styling ANSI
  // No raw control bytes survive (real newlines only separate our own rows).
  for (const bad of ["\u0000", "\u0007", "\r", "\u001b"]) {
    assert.ok(!text.includes(bad), `no raw ${JSON.stringify(bad)} in display`);
  }
  // Control-bearing changes stay visible and distinguishable as literals.
  assert.ok(text.includes("\\x1b[31m"), "escape shown as a literal, not executed");
  assert.ok(text.includes("\\r"), "carriage return shown as a literal");
  assert.ok(text.includes("\\x07"), "BEL shown as a literal");
  assert.ok(text.includes("\\x00"), "NUL shown as a literal");
  assert.ok(text.includes("\\x1b]0;pwned"), "path escape neutralized but still readable");
});

test("theme invalidation rebuilds the colored diff", () => {
  const { dialog } = setup();
  const before = dialog.render(80);
  dialog.invalidate();
  const after = dialog.render(80);
  assert.deepEqual(plain(after), plain(before), "content stable across invalidate");
});

test("abort settles once with cancel, then removes its listener", () => {
  const controller = new AbortController();
  const { dialog, results } = setup({ signal: controller.signal });
  controller.abort();
  controller.abort(); // second abort is a no-op anyway
  dialog.handleInput("\r"); // any further input must not settle again
  assert.deepEqual(results, [{ action: "cancel" }], "settled exactly once");
  dialog.dispose(); // idempotent cleanup
});

test("an already-aborted signal finishes immediately with cancel", () => {
  const controller = new AbortController();
  controller.abort();
  const { results } = setup({ signal: controller.signal });
  assert.deepEqual(results, [{ action: "cancel" }]);
});

test("dispose removes the abort listener so a later abort does not settle", () => {
  const controller = new AbortController();
  const { dialog, results } = setup({ signal: controller.signal });
  dialog.handleInput(KEY.enter); // accept -> settles and cleans up
  assert.deepEqual(results, [{ action: "accept" }]);
  dialog.dispose();
  controller.abort(); // listener already removed; no second result
  assert.deepEqual(results, [{ action: "accept" }]);
});

test("reviewInTerminal returns cancel without any UI when not in a TUI", async () => {
  let customCalls = 0;
  const ctx = {
    mode: "rpc",
    hasUI: false,
    ui: { custom: async () => { customCalls++; return { action: "accept" }; } },
  } as unknown as Parameters<typeof reviewInTerminal>[0];
  const decision = await reviewInTerminal(ctx, makeFile(), new AbortController().signal);
  assert.deepEqual(decision, { action: "cancel" });
  assert.equal(customCalls, 0, "no custom UI is shown outside a TUI");
});

test("reviewInTerminal drives ctx.ui.custom and resolves with the dialog decision", { timeout: 5_000 }, async () => {
  const ctx = {
    cwd: "/repo",
    mode: "tui",
    hasUI: true,
    ui: {
      theme,
      custom: <T,>(factory: (tui: any, th: Theme, kb: any, done: (r: T) => void) => any) =>
        new Promise<T>(resolve => {
          const tui = { requestRender: () => {}, terminal: { rows: 24 } };
          const dialog = factory(tui, theme, {}, resolve);
          assert.match(plain(dialog.render(80))[0]!, /Review edit  src\/example\.ts/);
          dialog.handleInput(KEY.enter); // accept
        }),
    },
  } as unknown as Parameters<typeof reviewInTerminal>[0];
  const decision = await reviewInTerminal(ctx, makeFile(), new AbortController().signal);
  assert.deepEqual(decision, { action: "accept" });
});
