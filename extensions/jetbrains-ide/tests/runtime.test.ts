import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { createAgentSession, createEditToolDefinition, createWriteToolDefinition, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { registerReviewedEditing } from "../editing.ts";
import { EditReview } from "../review.ts";
import { IdeProtocol } from "../protocol.ts";

test("real Pi runtime retains argument preparation, validation and permission hooks for wrapped tools", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-review-runtime-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const agentDir = join(cwd, "agent"), path = join(cwd, "file.txt");
  await writeFile(path, "before\n");
  const ide = new IdeProtocol(); Object.defineProperty(ide.connection, "connected", { get: () => true });
  let reviews = 0, permitted = false, input: unknown;
  ide.closeTab = async () => {};
  ide.openDiff = async (_path, contents) => { reviews++; return { accepted: true, contents }; };
  const review = new EditReview(async () => ide);
  const settingsManager = SettingsManager.inMemory({ packages: [], retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [pi => {
      registerReviewedEditing(pi, review);
      pi.registerTool({ name: "probe", label: "Probe", description: "Test nested editing lifecycle", parameters: Type.Object({ tool: Type.String() }),
        execute: async (_id, params, signal, _update, ctx) => {
          const outcome = await ctx.executeTool(params.tool, input, { signal });
          return { ...outcome.result, details: { isError: outcome.isError } };
        },
      });
    }, pi => {
      pi.on("tool_call", event => {
        if (!permitted && ["edit", "write"].includes(event.toolName)) return { block: true, reason: "Permission denied" };
      });
    }],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const sessionManager = SessionManager.inMemory(cwd);
  sessionManager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "probe", name: "probe", arguments: { tool: "edit" } }],
    api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-4-5", stopReason: "toolUse", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader: loader,
    sessionManager, tools: ["edit", "write", "probe"],
  });
  t.after(() => { session.dispose(); });
  await session.bindExtensions({});
  const probe = session.agent.state.tools.find(tool => tool.name === "probe")!;
  const run = (tool: string) => probe.execute("probe", { tool });
  input = { path: "file.txt", oldText: "before", newText: "after" };
  const blocked = await run("edit");
  assert.match(JSON.stringify(blocked), /Permission denied/);
  assert.equal(reviews, 0); assert.equal(await readFile(path, "utf8"), "before\n");
  input = { path: "file.txt", content: "write" };
  assert.match(JSON.stringify(await run("write")), /Permission denied/);
  permitted = true;
  input = { path: "file.txt", edits: [] };
  assert.match(JSON.stringify(await run("edit")), /at least one/);
  input = { path: "file.txt" };
  assert.match(JSON.stringify(await run("write")), /validation|Expected string/i);
  assert.equal(reviews, 0);
  input = { path: "file.txt", oldText: "before", newText: "after" };
  assert.doesNotMatch(JSON.stringify(await run("edit")), /isError":true/);
  assert.equal(await readFile(path, "utf8"), "after\n"); assert.equal(reviews, 1);
  input = { path: "file.txt", content: "written\n" };
  await run("write"); assert.equal(await readFile(path, "utf8"), "written\n"); assert.equal(reviews, 2);

  const conflictingLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
    extensionFactories: [pi => {
      pi.registerTool(createEditToolDefinition(cwd));
      pi.registerTool(createWriteToolDefinition(cwd));
    }, pi => {
      registerReviewedEditing(pi, review);
      pi.registerTool(session.getToolDefinition("probe")!);
    }],
  });
  await conflictingLoader.reload();
  const { session: conflictingSession } = await createAgentSession({ cwd, agentDir, settingsManager, sessionManager,
    resourceLoader: conflictingLoader, tools: ["edit", "write", "probe"],
  });
  t.after(() => { conflictingSession.dispose(); });
  await conflictingSession.bindExtensions({});
  const conflictingProbe = conflictingSession.agent.state.tools.find(tool => tool.name === "probe")!;
  for (const tool of ["edit", "write"]) {
    input = tool === "edit" ? { path: "file.txt", edits: [{ oldText: "written", newText: "bypass" }] } : { path: "file.txt", content: "bypass" };
    assert.match(JSON.stringify(await conflictingProbe.execute("probe", { tool })), /conflicting editing extensions/);
  }
  assert.equal(await readFile(path, "utf8"), "written\n"); assert.equal(reviews, 2);
});
