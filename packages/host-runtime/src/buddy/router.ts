import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  assess,
  compatibleTurn,
  dispatchLifecycle,
  homePath,
  inspectProject,
  resolveDispatch,
  threadState,
  turnState,
  type ThreadContext,
} from "@codexhost/buddy-engine";
import {
  buddySettingsSchema,
  type BuddyDecision,
  type BuddyModel,
  type BuddySnapshot,
} from "@codexhost/shared-contracts";
import type { JsonObject, JsonRpcRequest, JsonValue } from "@codexhost/protocol-core";
import { BuddyPlanner, object, result, type NativeRequest } from "./planner.js";
import { discoverModels } from "./models.js";

const roleInstructions = {
  git: "你是 Git 智能体。先确认仓库、工作区、暂存区和冲突状态，只做用户已授权的 Git 操作。保留他人修改；推送、提交、合并以真实结果为准。遇到业务语义冲突或未定设计，停止猜测并返回现有证据与需要规划者解决的问题。",
  io: "你是 IO 操作智能体。负责文件查看、查找、移动，以及项目 CLI 启动、构建、测试和日志检查。严格按任务范围执行，保留原有权限和审批。启动进程不代表服务或页面已就绪；返回真实退出码和验证证据。",
  executor:
    "你是垃执行者。只实施已经确定的任务步骤并验收，不重新扩展架构设计。禁止递归委派。出现未定设计、范围变化或同一问题两次实施失败时，返回已改文件、真实错误和需要规划者决定的问题，不盲目重复具有副作用的操作。",
};

export function specialist(text: string, intent: string): BuddyDecision["role"] {
  if (
    /(?:开发|实现|设计|新增|添加|编写).*(?:功能|智能体|路由|插件|模块)|implement|design a/iu.test(
      text,
    )
  ) {
    return "executor";
  }
  if (intent === "git") {
    return "git";
  }
  return intent === "project" ||
    /文件|目录|日志|复制|移动|重命名|查找|搜索|跑起来|构建|测试|\b(?:ls|cp|mv|find|rg|npm|pnpm|cargo|gradle|pytest)\b/iu.test(
      text,
    )
    ? "io"
    : "executor";
}

const quote = (text: string): string => `'${text.replaceAll("'", "'\"'\"'")}'`;
export interface BuddyRouterOptions {
  environment: NodeJS.ProcessEnv;
  request: NativeRequest;
  respond(message: JsonObject): Promise<void>;
  send(message: JsonObject): Promise<void>;
  forward(request: JsonRpcRequest): Promise<void>;
  diagnose(error: unknown): void;
}

export class BuddyRouter {
  readonly #home: string;
  readonly #planner: BuddyPlanner;
  readonly #threads = new Map<string, ThreadContext>();
  readonly #tracked = new Map<string | number, JsonRpcRequest>();
  readonly #decisions = new Map<string, BuddyDecision>();
  readonly #jobs = new Map<string, AbortController>();
  readonly #active = new Set<string>();
  readonly #dispatch: ReturnType<typeof dispatchLifecycle>;
  #settings = buddySettingsSchema.parse({});
  #models: BuddyModel[] = [];

  constructor(private readonly options: BuddyRouterOptions) {
    this.#home = homePath(options.environment.CODEX_HOME);
    this.#planner = new BuddyPlanner(options.request, options.respond, options.diagnose);
    this.#dispatch = dispatchLifecycle({
      send: (message) => {
        void options.send(message as JsonObject).catch(options.diagnose);
      },
      warn: (threadId, message) => {
        this.#update(threadId, { reason: message });
      },
      record: (state) => {
        if (typeof state.threadId !== "string") {
          return;
        }
        this.#update(state.threadId, {
          phase:
            state.accepted === false || state.success === false
              ? "failed"
              : state.success === true
                ? "completed"
                : "bypass",
          exitCode: typeof state.exitCode === "number" ? state.exitCode : null,
          turnId: typeof state.turnId === "string" ? state.turnId : null,
        });
      },
      release: (threadId) => this.#active.delete(threadId),
    });
  }

  async #loadSettings(): Promise<void> {
    try {
      this.#settings = buddySettingsSchema.parse(
        JSON.parse(await readFile(join(this.#home, "buddy-router.json"), "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  async snapshot(): Promise<BuddySnapshot> {
    await this.#loadSettings();
    return {
      settings: this.#settings,
      models: this.#models,
      decisions: [...this.#decisions.values()],
    };
  }

  async refreshModels(): Promise<BuddySnapshot> {
    await this.#loadSettings();
    const inventory = await discoverModels({
      home: this.#home,
      environment: this.options.environment,
      settings: this.#settings,
      nativeIds: await this.#nativeModels(),
      signal: AbortSignal.timeout(10000),
    });
    this.#models = inventory.models;
    return this.snapshot();
  }

  async configure(value: unknown): Promise<BuddySnapshot> {
    const settings = buddySettingsSchema.parse(value);
    await mkdir(this.#home, { recursive: true });
    const file = join(this.#home, "buddy-router.json");
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, file);
    this.#settings = settings;
    if (!settings.enabled) {
      for (const controller of this.#jobs.values()) {
        controller.abort();
      }
    }
    return this.snapshot();
  }

  cancel(threadId: string): void {
    this.#jobs.get(threadId)?.abort();
  }

  get hasActiveWork(): boolean {
    return this.#jobs.size > 0 || this.#active.size > 0;
  }

  track(request: JsonRpcRequest): void {
    if (["thread/start", "thread/resume", "thread/fork", "turn/start"].includes(request.method)) {
      this.#tracked.set(request.id, request);
    }
    if (request.method === "thread/settings/update") {
      const params = object(request.params);
      if (typeof params.threadId === "string") {
        this.#threads.delete(params.threadId);
      }
    }
  }

  #update(threadId: string, patch: Partial<BuddyDecision>): void {
    const current = this.#decisions.get(threadId);
    if (current) {
      this.#decisions.set(threadId, { ...current, ...patch, updatedAt: new Date().toISOString() });
    }
  }

  observe(message: JsonValue): boolean {
    if (this.#planner.observe(message)) {
      return true;
    }
    if (this.#dispatch.handle(message)) {
      return true;
    }
    const value = object(message);
    const params = object(value.params);
    const threadId = typeof params.threadId === "string" ? params.threadId : "";
    const request =
      typeof value.id === "number" || typeof value.id === "string"
        ? this.#tracked.get(value.id)
        : undefined;
    if (!value.method && request) {
      this.#tracked.delete(request.id);
      const response = object(value.result);
      const thread = object(response.thread);
      const original = object(request.params);
      if (typeof thread.id === "string") {
        this.#threads.set(thread.id, threadState(response, original, this.#threads.get(thread.id)));
      }
      if (request.method === "turn/start" && typeof original.threadId === "string") {
        const id = original.threadId;
        if (value.error) {
          this.#update(id, {
            phase: "failed",
            acceptedModel: null,
            reason: "执行模型启动失败；没有自动重放。",
          });
          this.#active.delete(id);
        } else {
          this.#threads.set(id, turnState(original, this.#threads.get(id)));
          this.#update(id, {
            acceptedModel: typeof original.model === "string" ? original.model : null,
          });
        }
      }
    }
    if (value.method === "turn/started" && threadId) {
      this.#active.add(threadId);
      const turn = object(params.turn);
      this.#update(threadId, { turnId: typeof turn.id === "string" ? turn.id : null });
    }
    if (value.method === "turn/completed" && threadId) {
      this.#active.delete(threadId);
      const current = this.#decisions.get(threadId);
      if (current && current.command === null) {
        const status = object(params.turn).status;
        this.#update(threadId, {
          phase:
            status === "completed"
              ? "completed"
              : status === "interrupted"
                ? "cancelled"
                : "failed",
        });
      }
    }
    return false;
  }

  async #nativeModels(): Promise<Set<string>> {
    const ids = new Set<string>();
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const listing = result(
        await this.options.request("model/list", { includeHidden: true, limit: 100, cursor }),
      );
      for (const item of Array.isArray(listing.data) ? listing.data : []) {
        const row = object(item);
        for (const id of [row.id, row.model]) {
          if (typeof id === "string") {
            ids.add(id);
          }
        }
      }
      cursor = typeof listing.nextCursor === "string" ? listing.nextCursor : null;
      if (cursor && seen.has(cursor)) {
        throw new Error("客户端模型目录分页循环。");
      }
      if (cursor) {
        seen.add(cursor);
      }
    } while (cursor);
    return ids;
  }

  async route(request: JsonRpcRequest): Promise<boolean> {
    await this.#loadSettings();
    const params = object(request.params) as JsonObject;
    if (
      !this.#settings.enabled ||
      typeof params.threadId !== "string" ||
      !Array.isArray(params.input) ||
      !params.input.length ||
      params.toolOutput
    ) {
      return false;
    }
    const threadId = params.threadId;
    if (this.#jobs.has(threadId)) {
      await this.options.send({
        id: request.id,
        error: { code: -32090, message: "当前任务仍在规划；请等待或取消规划。" },
      });
      return true;
    }
    if (this.#active.has(threadId)) {
      return false;
    }
    const controller = new AbortController();
    this.#jobs.set(threadId, controller);
    try {
      await this.#route(request, params, threadId, controller.signal);
    } catch (error) {
      this.#active.delete(threadId);
      const cancelled = controller.signal.aborted;
      this.#update(threadId, {
        phase: cancelled ? "cancelled" : "failed",
        reason: cancelled
          ? "已取消；未启动执行模型。"
          : error instanceof Error
            ? error.message
            : "路由失败。",
      });
      await this.options.send({
        id: request.id,
        error: {
          code: cancelled ? -32800 : -32090,
          message: this.#decisions.get(threadId)?.reason ?? "Buddy 路由失败。",
        },
      });
    } finally {
      this.#jobs.delete(threadId);
    }
    return true;
  }

  async #route(
    request: JsonRpcRequest,
    params: JsonObject,
    threadId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const context = this.#threads.get(threadId);
    const cwd = typeof params.cwd === "string" ? params.cwd : context?.cwd;
    const input = params.input as JsonValue[];
    const text = input
      .map(object)
      .filter((v) => v.type === "text")
      .map((v) => v.text)
      .join("\n");
    const project = await inspectProject(cwd);
    const assessment = await assess(input, cwd, project);
    const role =
      this.#settings.role === "auto" ? specialist(text, assessment.intent) : this.#settings.role;
    const decision: BuddyDecision = {
      threadId,
      turnId: null,
      phase: "discovering",
      role,
      difficulty: assessment.tier,
      score: { simple: 15, standard: 45, advanced: 85 }[assessment.tier],
      reason: assessment.reason,
      plannerModel: null,
      executorModel: null,
      acceptedModel: null,
      plan: null,
      command: null,
      exitCode: null,
      updatedAt: new Date().toISOString(),
    };
    this.#decisions.set(threadId, decision);
    if (this.#decisions.size > 100) {
      const first = this.#decisions.keys().next().value;
      if (first) {
        this.#decisions.delete(first);
      }
    }
    if (!cwd) {
      throw new Error("未确认工作目录，无法路由。");
    }
    signal.throwIfAborted();
    if (this.#settings.bypass && compatibleTurn(params, context)) {
      let direct = await resolveDispatch(text, cwd, { project });
      const commands: Record<string, string[]> = {
        当前目录: ["pwd"],
        pwd: ["pwd"],
        查看当前目录文件: ["ls", "-la"],
        ls: ["ls", "-la"],
      };
      const argv = commands[text.trim()];
      if (argv) {
        direct = {
          route: "tool",
          recipe: { id: "io.inspect", argv, cwd, source: "builtin", action: "inspect" },
        };
      }
      if (direct.route === "tool" && direct.recipe) {
        const command = `cd ${quote(direct.recipe.cwd)} && exec ${direct.recipe.argv.map(quote).join(" ")}`;
        this.#update(threadId, {
          phase: "bypass",
          difficulty: "simple",
          score: 0,
          command,
          reason: "精确规则命中；未请求模型目录或推理。",
        });
        this.#active.add(threadId);
        const native = this.#dispatch.submit(request.id, threadId, {
          ...direct,
          command,
          timeoutMs: 3_600_000,
        });
        await this.options.forward(native as JsonRpcRequest);
        return;
      }
    }
    const nativeIds = await this.#nativeModels();
    signal.throwIfAborted();
    const inventory = await discoverModels({
      home: this.#home,
      environment: this.options.environment,
      settings: this.#settings,
      nativeIds,
      signal,
    });
    if (context?.provider && context.provider !== inventory.provider) {
      throw new Error("当前线程与配置供应商不同，未跨供应商自动切换。");
    }
    this.#models = inventory.models;
    let packet = "";
    const planOnly = object(params.collaborationMode).mode === "plan";
    this.#update(threadId, { executorModel: planOnly ? null : inventory.executor });
    if (!planOnly && !inventory.executor) {
      throw new Error("实时候选中没有可执行的垃模型，请检查供应商模型同步；未自动改用夯执行。");
    }
    if (assessment.tier === "advanced" && !planOnly) {
      if (!inventory.planner) {
        throw new Error("没有可用的夯规划模型，未把复杂设计交给垃执行。");
      }
      this.#update(threadId, { phase: "planning", plannerModel: inventory.planner });
      const metadata = result(
        await this.options.request("thread/read", { threadId, includeTurns: false }),
      );
      const history =
        object(metadata.thread).ephemeral === true
          ? { data: [] }
          : result(
              await this.options.request("thread/items/list", {
                threadId,
                limit: 16,
                sortDirection: "desc",
              }),
            );
      const recent = Array.isArray(history.data)
        ? history.data
            .filter((item) => ["userMessage", "agentMessage"].includes(String(object(item).type)))
            .reverse()
        : [];
      const plan = await this.#planner.plan({
        model: inventory.planner,
        cwd,
        task: input,
        context: JSON.stringify({ project, recent }).slice(0, 16000),
        signal,
      });
      signal.throwIfAborted();
      if (plan.clarification) {
        throw new Error(`规划需要补充信息：${plan.clarification}`);
      }
      if (!plan.steps.length || !plan.checks.length) {
        throw new Error("规划没有给出执行步骤和验收条件，未启动执行。");
      }
      packet = JSON.stringify(plan);
      this.#update(threadId, { plan: packet });
    }
    signal.throwIfAborted();
    if (planOnly && !inventory.planner) {
      throw new Error("没有可用的夯规划模型。");
    }
    const model = planOnly ? inventory.planner : inventory.executor;
    const originalMode = object(params.collaborationMode);
    const originalSettings = object(originalMode.settings);
    const guidance = [
      originalSettings.developer_instructions,
      planOnly ? "" : roleInstructions.executor,
      role === "executor" ? "" : roleInstructions[role],
      packet ? `夯规划者已完成只读调查，按以下任务包实施并验收：\n${packet}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const rewritten: JsonRpcRequest = {
      id: request.id,
      method: request.method,
      params: {
        ...params,
        model,
        effort: null,
        collaborationMode: {
          mode: planOnly ? "plan" : "default",
          settings: {
            ...originalSettings,
            model,
            reasoning_effort: null,
            developer_instructions: guidance,
          },
        },
      },
    };
    this.#update(threadId, {
      phase: planOnly ? "planning" : "executing",
      plannerModel: planOnly ? model : (this.#decisions.get(threadId)?.plannerModel ?? null),
    });
    this.track(rewritten);
    this.#active.add(threadId);
    await this.options.forward(rewritten);
  }

  close(): void {
    for (const controller of this.#jobs.values()) {
      controller.abort();
    }
    this.#dispatch.close();
  }
}
