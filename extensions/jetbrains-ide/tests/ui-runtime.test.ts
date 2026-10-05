import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function verifyUiRuntime(t: TestContext, omp: boolean): Promise<void> {
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
  const mode = new InteractiveMode(runtime, { terminal, tuiMode: "regular" });
  t.after(() => mode.stop());
  await mode.init();
  await renderTick();

  // Inspect Pi's actual footer and effective bindings; nothing in the extension replaces either.
  const internals = mode as unknown as { footer: FooterComponent; keybindings: KeybindingsManager };
  const statusLine = () => stripAnsi(internals.footer.render(120).at(-1)!);
  assert.equal(statusLine(), "REVIEW IDE: disconnected");
  assert.match(stripAnsi(terminal.output), /REVIEW IDE: disconnected/);
  const bindings = internals.keybindings.getEffectiveConfig();
  assert.ok(!Object.values(bindings).flat().includes("alt+r"));
  assert.ok(internals.keybindings.getKeys("app.session.rename").includes("ctrl+r"));
  const shortcuts = session.extensionRunner.getShortcuts(bindings);
  assert.ok(shortcuts.has("alt+r")); assert.ok(shortcuts.has("ctrl+alt+p"));
  assert.deepEqual(session.extensionRunner.getShortcutDiagnostics(), []);

  terminal.output = "";
  terminal.input!("\x1br"); // Legacy Alt+R, routed by Pi's real CustomEditor.
  await renderTick();
  assert.equal(statusLine(), "AUTO IDE: disconnected");
  assert.match(stripAnsi(terminal.output), /AUTO IDE: disconnected/);
  terminal.output = "";
  await session.prompt("/edit-mode review");
  assert.equal(statusLine(), "REVIEW IDE: disconnected");
  await renderTick();
  assert.match(stripAnsi(terminal.output), /REVIEW IDE: disconnected/);
  await session.prompt("/edit-mode auto");
  assert.equal(statusLine(), "AUTO IDE: disconnected");
  terminal.input!("\x1br"); await renderTick();
  assert.equal(statusLine(), "REVIEW IDE: disconnected");

  await session.prompt("/plan");
  assert.match(statusLine(), /REVIEW IDE: disconnected.*plan/);
  const planStatus = statusLine().split("IDE: disconnected")[1];
  const planTools = session.getActiveToolNames();
  terminal.input!("\x1br"); await renderTick();
  assert.equal(statusLine(), `AUTO IDE: disconnected${planStatus}`);
  assert.deepEqual(session.getActiveToolNames(), planTools);
  await session.prompt("/edit-mode review");
  assert.equal(statusLine(), `REVIEW IDE: disconnected${planStatus}`);
  assert.deepEqual(session.getActiveToolNames(), planTools);
  assert.equal(connect.mock.callCount(), 0);
}

for (const omp of [false, true]) {
  test(`real Pi ${omp ? "OMP status UI" : "native footer"} registers Alt+R and shows edit status alongside pi-code Plan Mode`,
    { timeout: 15_000 }, t => verifyUiRuntime(t, omp));
}
