import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { Terminal } from "@earendil-works/pi-tui";
import { AgentSessionRuntime, createAgentSessionFromServices, createAgentSessionServices,
  InteractiveMode, SessionManager, SettingsManager, type FooterComponent, type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import jetbrainsIde from "../index.ts";
import { IdeProtocol } from "../protocol.ts";

class TestTerminal implements Terminal {
  columns = 120; rows = 40; kittyProtocolActive = false;
  output = "";
  input?: (data: string) => void;
  start(onInput: (data: string) => void): void { this.input = onInput; }
  stop(): void { this.input = undefined; }
  async drainInput(): Promise<void> {}
  write(data: string): void { this.output += data; }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

const stripAnsi = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
const renderTick = () => new Promise(resolve => setTimeout(resolve, 30));
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await renderTick(); }
  assert.fail("Timed out waiting for terminal review");
}

async function verifyUiRuntime(t: TestContext, omp: boolean, tuiMode: "regular" | "fullscreen"): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-edit-ui-runtime-")), agentDir = join(cwd, "agent");
  const home = process.env.HOME, piDir = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = cwd; process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
    if (piDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = piDir;
  });
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const connect = t.mock.method(IdeProtocol.prototype, "connect", async () => assert.fail("UI eagerly connected to IDE"));
  const settingsManager = SettingsManager.inMemory({ packages: [], quietStartup: true, retry: { enabled: false } });
  const require = createRequire(import.meta.url);
  const portableSettings = JSON.parse(await readFile(new URL("../../../config/settings.json", import.meta.url), "utf8"));
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ piOmpTheme: portableSettings.piOmpTheme }));
  const services = await createAgentSessionServices({ cwd, agentDir, settingsManager, resourceLoaderOptions: {
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    additionalExtensionPaths: [require.resolve("pi-code/extensions/plan-mode/index.ts"),
      ...omp ? [require.resolve("@nguyenquangthai/pi-omp-theme/dist/extensions/pi-omp-theme.ts")] : [],
    ],
    extensionFactories: [jetbrainsIde],
  } });
  assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
  const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(cwd) });
  const runtime = new AgentSessionRuntime(session, services, async () => assert.fail("Unexpected session replacement"));
  t.after(() => runtime.dispose());
  const terminal = new TestTerminal();
  const mode = new InteractiveMode(runtime, { terminal, tuiMode });
  t.after(() => mode.stop());
  await mode.init(); await renderTick();

  const internals = mode as unknown as { footer: FooterComponent; keybindings: KeybindingsManager };
  const statusLine = () => stripAnsi(internals.footer.render(120).at(-1)!);
  const reviewStatus = "[Edits: Review] [IDE: Not connected]", autoStatus = "[Edits: Auto] [IDE: Not connected]";
  assert.equal(statusLine(), reviewStatus);
  assert.ok(stripAnsi(terminal.output).includes(reviewStatus));
  const bindings = internals.keybindings.getEffectiveConfig();
  assert.ok(!Object.values(bindings).flat().includes("ctrl+q"));
  assert.ok(internals.keybindings.getKeys("app.session.rename").includes("ctrl+r"));
  const shortcuts = session.extensionRunner.getShortcuts(bindings);
  assert.ok(shortcuts.has("ctrl+q")); assert.ok(shortcuts.has("ctrl+alt+p"));
  assert.deepEqual(session.extensionRunner.getShortcutDiagnostics(), []);

  terminal.output = "";
  terminal.input!("\x11"); await renderTick();
  assert.equal(statusLine(), autoStatus);
  assert.ok(stripAnsi(terminal.output).includes(autoStatus));
  await session.prompt("/edit-mode review"); assert.equal(statusLine(), reviewStatus);
  await session.prompt("/edit-mode auto"); assert.equal(statusLine(), autoStatus);
  terminal.input!("\x11"); await renderTick(); assert.equal(statusLine(), reviewStatus);

  await session.prompt("/plan");
  assert.ok(statusLine().startsWith(reviewStatus)); assert.match(statusLine(), /plan/);
  const planStatus = statusLine().slice(reviewStatus.length), planTools = session.getActiveToolNames();
  terminal.input!("\x11"); await renderTick();
  assert.equal(statusLine(), `${autoStatus}${planStatus}`);
  assert.deepEqual(session.getActiveToolNames(), planTools);
  await session.prompt("/edit-mode review");
  assert.equal(statusLine(), `${reviewStatus}${planStatus}`);
  assert.deepEqual(session.getActiveToolNames(), planTools);
  await session.prompt("/plan");

  // Execute the registered wrappers against Pi's real UI without a model or IDE.
  const path = join(cwd, "file.txt"); await writeFile(path, "before\n");
  const ctx = session.extensionRunner.createToolContext("ui-test", undefined);
  const edit = session.getToolDefinition("edit")!, write = session.getToolDefinition("write")!;
  const execute = () => edit.execute("ui-test", { path, edits: [{ oldText: "before", newText: "after" }] }, undefined, undefined, ctx);
  const reviewVisible = () => stripAnsi(terminal.output).includes("Accept and switch to Auto");
  ctx.ui.setEditorText("unsent draft"); terminal.output = "";
  const declined = execute(), declinedResult = assert.rejects(declined, /User feedback: Keep the old API/);
  await waitFor(reviewVisible);
  assert.equal(await readFile(path, "utf8"), "before\n");
  assert.match(stripAnsi(terminal.output), /before/); assert.match(stripAnsi(terminal.output), /after/);
  terminal.input!("\x1b[B"); terminal.input!("\t"); terminal.input!("Keep the old API"); terminal.input!("\r");
  await declinedResult;
  assert.equal(await readFile(path, "utf8"), "before\n");
  assert.equal(ctx.ui.getEditorText(), "unsent draft"); assert.equal(statusLine(), reviewStatus);

  terminal.output = "";
  const newFile = write.execute("new-file", { path: join(cwd, "new/sub/file.txt"), content: "new content\n" }, undefined, undefined, ctx);
  const newFileRejected = assert.rejects(newFile, /User rejected/);
  await waitFor(reviewVisible);
  terminal.input!("\x1b[B"); terminal.input!("\r"); await newFileRejected;
  await assert.rejects(access(join(cwd, "new")), /ENOENT/);

  terminal.output = "";
  const accepted = execute(); await waitFor(reviewVisible); terminal.input!("\r"); await accepted;
  assert.equal(await readFile(path, "utf8"), "after\n"); assert.equal(statusLine(), reviewStatus);

  terminal.output = "";
  const written = write.execute("ui-write", { path, content: "written\n" }, undefined, undefined, ctx);
  await waitFor(reviewVisible);
  assert.match(stripAnsi(terminal.output), /after/); assert.match(stripAnsi(terminal.output), /written/);
  terminal.input!("\r"); await written;
  assert.equal(await readFile(path, "utf8"), "written\n");

  await writeFile(path, "before\n"); terminal.output = "";
  const acceptedAuto = execute(); await waitFor(reviewVisible);
  terminal.input!("\x1b[B"); terminal.input!("\x1b[B"); terminal.input!("\r"); await acceptedAuto;
  assert.equal(await readFile(path, "utf8"), "after\n"); assert.equal(statusLine(), autoStatus);
  terminal.output = "";
  await write.execute("auto-write", { path, content: "auto\n" }, undefined, undefined, ctx);
  assert.equal(await readFile(path, "utf8"), "auto\n"); assert.equal(reviewVisible(), false);

  await session.prompt("/edit-mode review"); await writeFile(path, "before\n"); terminal.output = "";
  const cancelled = execute(), cancelledResult = assert.rejects(cancelled, /cancelled|aborted/);
  await waitFor(reviewVisible); terminal.input!("\x11"); await cancelledResult;
  assert.equal(await readFile(path, "utf8"), "before\n"); assert.equal(statusLine(), autoStatus);
  assert.equal(ctx.ui.getEditorText(), "unsent draft"); assert.equal(connect.mock.callCount(), 0);
}

for (const omp of [false, true]) {
  for (const tuiMode of ["regular", "fullscreen"] as const) {
    test(`real Pi ${tuiMode} ${omp ? "OMP status UI" : "native footer"} supports CLI review without an IDE and keeps edit mode separate from Plan Mode`,
      { timeout: 20_000 }, t => verifyUiRuntime(t, omp, tuiMode));
  }
}
