import { createServer, type Server } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonObject, JsonRpcRequest } from "@codexhost/protocol-core";
import { BuddyRouter, specialist } from "../../src/buddy/router.js";
import { chooseModels, modelTier } from "../../src/buddy/models.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((clean) => clean()));
});

async function fixture(
  options: {
    holdPlan?: boolean;
    plannerFails?: boolean;
    interactivePlan?: boolean;
    ephemeral?: boolean;
    modelIds?: string[];
  } = {},
) {
  const home = await mkdtemp(join(tmpdir(), "buddy-router-test-"));
  let providerRequests = 0;
  const models = (options.modelIds ?? ["gpt-planner", "deepseek-flash"]).map((id) => ({ id }));
  const server: Server = createServer((req, res) => {
    providerRequests += 1;
    expect(req.url).toBe("/v1/models");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: models }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("No fixture address");
  }
  await writeFile(
    join(home, "config.toml"),
    `model_provider = "fixture"\nmodel = "gpt-planner"\n[model_providers.fixture]\nbase_url = "http://127.0.0.1:${address.port}/v1"\nexperimental_bearer_token = "fixture-only"\n`,
  );
  const sent: JsonObject[] = [];
  const forwarded: JsonRpcRequest[] = [];
  const requested: { method: string; params: JsonObject }[] = [];
  const replies: JsonObject[] = [];
  const router: BuddyRouter = new BuddyRouter({
    environment: { CODEX_HOME: home },
    request: async (method, params) => {
      requested.push({ method, params });
      switch (method) {
        case "model/list":
          return {
            result: { data: models, nextCursor: null },
          };
        case "thread/read":
          return { result: { thread: { ephemeral: options.ephemeral ?? false } } };
        case "thread/items/list":
          return {
            result: {
              data: [
                { type: "agentMessage", text: "已确认目标目录" },
                { type: "userMessage", content: [{ type: "text", text: "原需求" }] },
              ],
            },
          };
        case "thread/start":
          return { result: { thread: { id: "planner" } } };
        case "turn/start": {
          if (options.plannerFails) {
            return { error: { code: -1, message: "fixture planning failure" } };
          }
          router.observe({
            method: "turn/started",
            params: { threadId: "planner", turn: { id: "plan-turn" } },
          });
          if (options.interactivePlan) {
            router.observe({
              id: "question",
              method: "item/tool/requestUserInput",
              params: { threadId: "planner" },
            });
          } else if (!options.holdPlan) {
            router.observe({
              method: "item/completed",
              params: {
                threadId: "planner",
                item: {
                  type: "agentMessage",
                  text: JSON.stringify({
                    goal: "目标",
                    steps: ["只修改目标文件"],
                    checks: ["运行对应测试"],
                    clarification: null,
                  }),
                },
              },
            });
            router.observe({
              method: "turn/completed",
              params: { threadId: "planner", turn: { id: "plan-turn", status: "completed" } },
            });
          }
          return { result: { turn: { id: "plan-turn" } } };
        }
        default:
          return { result: {} };
      }
    },
    send: async (message) => {
      sent.push(message);
    },
    respond: async (message) => {
      replies.push(message);
    },
    forward: async (request) => {
      forwarded.push(request);
    },
    diagnose: () => undefined,
  });
  router.track({ id: 1, method: "thread/resume", params: { threadId: "work" } });
  router.observe({
    id: 1,
    result: {
      cwd: home,
      modelProvider: "fixture",
      model: "gpt-planner",
      sandbox: { type: "dangerFullAccess" },
      approvalPolicy: "never",
      thread: { id: "work", environments: [{ environmentId: "local" }] },
    },
  });
  const turn = (text: string, overrides: JsonObject = {}): JsonRpcRequest => ({
    id: 2,
    method: "turn/start",
    params: { threadId: "work", input: [{ type: "text", text }], ...overrides },
  });
  cleanups.push(async () => {
    router.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  });
  return {
    router,
    turn,
    sent,
    forwarded,
    requested,
    replies,
    home,
    providerRequests: () => providerRequests,
  };
}

describe("Buddy family policy", () => {
  it("uses the requested two tiers even when a name sounds powerful", () => {
    expect(
      ["gpt-6", "openai/gpt-6", "anthropic/claude-opus", "vendor:claude-4"].map(modelTier),
    ).toEqual(["夯", "夯", "夯", "夯"]);
    expect(
      ["deepseek-pro", "gemini-ultra", "o3", "fake-gpt-6", "gpt-image-1"].map(modelTier),
    ).toEqual(["垃", "垃", "垃", "垃", "夯"]);
  });
  it("requires live and native availability and never promotes a weak model", () => {
    const chosen = chooseModels(
      ["gpt-6", "deepseek-flash", "gemini-pro", "gpt-image-1"],
      new Set(["gpt-6", "deepseek-flash", "gpt-image-1"]),
      { executor: "gemini-pro" },
    );
    expect(chosen.executor).toBe("deepseek-flash");
    expect(chosen.models.find((model) => model.id === "gpt-image-1")?.eligible).toBe(false);
    expect(chooseModels(["gpt-6"], new Set(["gpt-6"]), {})).toMatchObject({
      planner: "gpt-6",
      executor: null,
    });
  });
  it("does not mistake development of Git features for a Git operation", () => {
    expect(specialist("实现 Git 智能体功能", "git")).toBe("executor");
    expect(specialist("推送代码", "git")).toBe("git");
    expect(specialist("跑起来看看", "project")).toBe("io");
  });
});

describe("Buddy native routing", () => {
  it("keeps a strong-only catalog observable but refuses to use it for execution", async () => {
    const f = await fixture({ modelIds: ["gpt-planner"] });
    expect((await f.router.refreshModels()).models).toEqual([
      { id: "gpt-planner", tier: "夯", eligible: true },
    ]);
    await f.router.route(f.turn("更新README"));
    expect(f.forwarded).toEqual([]);
    expect((await f.router.snapshot()).decisions[0]).toMatchObject({
      phase: "failed",
      acceptedModel: null,
    });
  });
  it("respects explicit plan mode without requiring or starting a weak executor", async () => {
    const f = await fixture({ modelIds: ["gpt-planner"] });
    await f.router.route(
      f.turn("设计数据库迁移", { collaborationMode: { mode: "plan", settings: {} } }),
    );
    expect(f.forwarded[0]?.params).toMatchObject({
      model: "gpt-planner",
      collaborationMode: { mode: "plan" },
    });
    expect(f.requested.some((request) => request.method === "thread/start")).toBe(false);
    expect((await f.router.snapshot()).decisions[0]?.executorModel).toBe(null);
  });
  it("bypasses both discovery and inference and keeps a failing real exit code", async () => {
    const f = await fixture();
    await f.router.route(f.turn("查看当前目录文件"));
    expect(f.providerRequests()).toBe(0);
    expect(f.requested).toEqual([]);
    expect(f.forwarded[0]?.method).toBe("thread/shellCommand");
    f.router.observe({ id: 2, result: {} });
    f.router.observe({
      method: "turn/started",
      params: { threadId: "work", turn: { id: "shell", status: "inProgress" } },
    });
    f.router.observe({
      method: "item/completed",
      params: {
        threadId: "work",
        turnId: "shell",
        item: { type: "commandExecution", exitCode: 17, status: "completed" },
      },
    });
    f.router.observe({
      method: "turn/completed",
      params: { threadId: "work", turn: { id: "shell", status: "completed" } },
    });
    expect((await f.router.snapshot()).decisions[0]).toMatchObject({
      phase: "failed",
      exitCode: 17,
      acceptedModel: null,
    });
    expect(f.router.hasActiveWork).toBe(false);
    expect(f.sent[0]).toMatchObject({ id: 2, result: { turn: { id: "shell" } } });
  });
  it("uses the weak model for bounded work and synchronizes nested model settings", async () => {
    const f = await fixture();
    await f.router.route(
      f.turn("更新README", {
        approvalPolicy: "on-request",
        sandboxPolicy: { type: "readOnly" },
        collaborationMode: {
          mode: "default",
          settings: {
            model: "gpt-planner",
            reasoning_effort: "high",
            developer_instructions: "保留原要求",
          },
        },
      }),
    );
    expect(f.providerRequests()).toBe(1);
    expect(f.requested.some((request) => request.method === "thread/start")).toBe(false);
    expect(f.forwarded[0]?.params).toMatchObject({
      model: "deepseek-flash",
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "readOnly" },
      effort: null,
      collaborationMode: { settings: { model: "deepseek-flash", reasoning_effort: null } },
    });
    expect(JSON.stringify(f.forwarded[0]?.params)).toContain("保留原要求");
    expect((await f.router.snapshot()).decisions[0]?.acceptedModel).toBe(null);
    f.router.observe({ id: 2, result: { turn: { id: "execute" } } });
    expect((await f.router.snapshot()).decisions[0]?.acceptedModel).toBe("deepseek-flash");
  });
  it("actually completes a read-only strong planner before starting the weak executor", async () => {
    const f = await fixture();
    await f.router.route(f.turn("重构跨模块的鉴权实现"));
    const planner = f.requested.find((request) => request.method === "thread/start");
    expect(planner?.params).toMatchObject({
      model: "gpt-planner",
      ephemeral: true,
      sandbox: "read-only",
      approvalPolicy: "never",
    });
    expect(f.forwarded).toHaveLength(1);
    expect(f.forwarded[0]?.params).toMatchObject({ model: "deepseek-flash" });
    expect(JSON.stringify(f.forwarded[0]?.params)).toContain("运行对应测试");
    expect(
      f.requested.find((request) => request.method === "thread/read")?.params.includeTurns,
    ).toBe(false);
    const planInput = f.requested.find((request) => request.method === "turn/start")?.params.input;
    expect(JSON.stringify(planInput)).toContain("原需求");
    expect(JSON.stringify(planInput)).toContain("已确认目标目录");
    expect((await f.router.snapshot()).decisions[0]).toMatchObject({
      phase: "executing",
      plannerModel: "gpt-planner",
      executorModel: "deepseek-flash",
      score: 85,
    });
  });
  it("cancellation stops planning without executing or replaying the original task", async () => {
    const f = await fixture({ holdPlan: true });
    const routing = f.router.route(f.turn("设计并实现数据库迁移"));
    await vi.waitFor(() =>
      expect(f.requested.some((request) => request.method === "turn/start")).toBe(true),
    );
    expect(f.router.hasActiveWork).toBe(true);
    f.router.cancel("work");
    await routing;
    expect(f.forwarded).toEqual([]);
    expect(f.sent[0]).toMatchObject({ id: 2, error: { code: -32800 } });
    expect((await f.router.snapshot()).decisions[0]?.phase).toBe("cancelled");
    expect(f.router.hasActiveWork).toBe(false);
  });
  it("does not request unavailable persisted history for an ephemeral thread", async () => {
    const f = await fixture({ ephemeral: true });
    await f.router.route(f.turn("设计数据库迁移"));
    expect(f.requested.some((request) => request.method === "thread/items/list")).toBe(false);
    expect(f.forwarded[0]?.params).toMatchObject({ model: "deepseek-flash" });
  });
  it("rejects hidden planner interaction and releases the native request without execution", async () => {
    const f = await fixture({ interactivePlan: true });
    await f.router.route(f.turn("设计数据库迁移"));
    expect(f.forwarded).toEqual([]);
    expect(f.replies[0]).toMatchObject({ id: "question", error: { code: -32090 } });
    expect(f.requested.some((request) => request.method === "turn/interrupt")).toBe(true);
    expect((await f.router.snapshot()).decisions[0]?.phase).toBe("failed");
  });
  it("planner rejection cannot silently start a strong executor or replay", async () => {
    const f = await fixture({ plannerFails: true });
    await f.router.route(f.turn("设计数据库迁移"));
    expect(f.forwarded).toEqual([]);
    expect((await f.router.snapshot()).decisions[0]?.phase).toBe("failed");
  });
  it("never bypasses a shell expression, a Git write, or unconfirmed permissions", async () => {
    const f = await fixture();
    f.router.track({ id: 3, method: "thread/settings/update", params: { threadId: "work" } });
    await f.router.route(f.turn("pwd", { cwd: f.home }));
    expect(f.forwarded.every((request) => request.method !== "thread/shellCommand")).toBe(true);
    const g = await fixture();
    await g.router.route(g.turn("ls; echo hacked"));
    expect(g.forwarded.every((request) => request.method !== "thread/shellCommand")).toBe(true);
  });
  it("off keeps the original native request path untouched", async () => {
    const f = await fixture();
    await f.router.configure({ enabled: false });
    expect(await f.router.route(f.turn("重构数据库"))).toBe(false);
    expect(f.requested).toEqual([]);
    expect(f.providerRequests()).toBe(0);
  });
});
