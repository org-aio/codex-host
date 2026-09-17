import { PassThrough } from "node:stream";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { homePath, readConnection } from "@codexhost/buddy-engine";
import { AppServerHost } from "../../packages/host-runtime/dist/index.js";
import assert from "node:assert/strict";

// 只在用户主动运行本脚本时发起真实规划与执行，所有任务限制在新建的验证目录。
const cwd = await mkdtemp(join(tmpdir(), "codex-buddy-live-"));
await writeFile(join(cwd, "README.md"), "Buddy read-only validation fixture.\n");
const input = new PassThrough();
const output = new PassThrough();
const diagnostic = new PassThrough();
const host = new AppServerHost({
  stockCodexPath:
    process.env.CODEXHOST_STOCK_CODEX_PATH ?? "/Applications/ChatGPT.app/Contents/Resources/codex",
  arguments: ["app-server", "--listen", "stdio://"],
  defaultAgent: "codex",
  buddyRouting: true,
  environment: process.env,
  desktopInput: input,
  desktopOutput: output,
  diagnosticOutput: diagnostic,
});
const run = host.run();
const pending = new Map();
const events = [];
let id = 0;
const lines = createInterface({ input: output });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method) {
    events.push(message);
  } else {
    const request = pending.get(message.id);
    if (request) {
      pending.delete(message.id);
      message.error
        ? request.reject(new Error(message.error.message))
        : request.resolve(message.result);
    }
  }
});
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const requestId = ++id;
    pending.set(requestId, { resolve, reject });
    input.write(JSON.stringify({ id: requestId, method, params }) + "\n");
  });
let poll;
const timeout = setTimeout(() => {
  console.error("Live validation timed out");
  host.close();
  process.exitCode = 1;
}, 240000);
try {
  await request("initialize", {
    clientInfo: { name: "codex_buddy_validation", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  });
  input.write(JSON.stringify({ method: "initialized" }) + "\n");
  const connection = await readConnection(homePath());
  const started = await request("thread/start", {
    model: connection.config.model,
    cwd,
    sandbox: "danger-full-access",
    approvalPolicy: "never",
    ephemeral: true,
  });
  const threadId = started.thread.id;
  let lastPhase = "";
  poll = setInterval(async () => {
    try {
      const snapshot = await request("codexhost/buddy/status", {});
      const current = snapshot.decisions.find((value) => value.threadId === threadId);
      if (current && lastPhase !== current.phase) {
        lastPhase = current.phase;
        console.log(JSON.stringify(current));
      }
    } catch (error) {
      console.error(error.message);
    }
  }, 1000);
  const bypass = await request("turn/start", {
    threadId,
    input: [{ type: "text", text: "当前目录" }],
  });
  await waitTurn(threadId, bypass.turn.id);
  const bypassStatus = (await request("codexhost/buddy/status", {})).decisions.find(
    (item) => item.threadId === threadId,
  );
  assert.equal(bypassStatus.phase, "completed");
  assert.equal(bypassStatus.exitCode, 0);
  assert.equal(bypassStatus.acceptedModel, null);
  console.log("BYPASS", JSON.stringify(bypassStatus));
  if (process.argv.includes("--planning")) {
    const turn = await request("turn/start", {
      threadId,
      input: [
        {
          type: "text",
          text: "为只读验证设计一个最小方案并执行：读取当前目录 README.md，确认内容含 Buddy，然后报告结果。不要修改、创建、删除任何文件；不需要询问用户。",
        },
      ],
    });
    await waitTurn(threadId, turn.turn.id);
    const execution = (await request("codexhost/buddy/status", {})).decisions.find(
      (item) => item.threadId === threadId,
    );
    assert.equal(execution.phase, "completed");
    assert.ok(execution.plan);
    assert.ok(execution.plannerModel);
    assert.equal(execution.acceptedModel, execution.executorModel);
    assert.notEqual(execution.plannerModel, execution.executorModel);
    const items = events
      .filter(
        (event) =>
          event.method === "item/completed" &&
          event.params.threadId === threadId &&
          event.params.turnId === turn.turn.id,
      )
      .map((event) => event.params.item);
    const commands = items.filter((item) => item.type === "commandExecution");
    assert.ok(commands.length > 0, "Executor must perform the read-only check itself");
    assert.ok(commands.every((item) => item.exitCode === 0));
    console.log("PLANNING_EXECUTION", JSON.stringify(execution));
    console.log("EXECUTOR_EVIDENCE", JSON.stringify(items));
  }
} finally {
  clearInterval(poll);
  clearTimeout(timeout);
  host.close();
  await run;
  lines.close();
  await rm(cwd, { recursive: true, force: true });
}

async function waitTurn(threadId, turnId) {
  const deadline = Date.now() + 210000;
  while (Date.now() < deadline) {
    const done = events.find(
      (event) =>
        event.method === "turn/completed" &&
        event.params.threadId === threadId &&
        event.params.turn.id === turnId,
    );
    if (done) {
      if (done.params.turn.status !== "completed") {
        throw new Error(`Native turn failed: ${done.params.turn.status}`);
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Native turn did not complete");
}
