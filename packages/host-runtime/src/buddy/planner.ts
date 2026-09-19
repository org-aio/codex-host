import type { JsonObject, JsonValue } from "@codexhost/protocol-core";

export type NativeRequest = (method: string, params: JsonObject) => Promise<JsonObject>;
export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function result(response: JsonObject): JsonObject {
  if (response.error) {
    throw new Error(`App Server 拒绝请求：${String(object(response.error).message ?? "unknown")}`);
  }
  return object(response.result) as JsonObject;
}

export interface TaskPacket {
  goal: string;
  steps: string[];
  checks: string[];
  clarification: string | null;
}
const packetSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  properties: {
    goal: { type: "string" },
    steps: { type: "array", items: { type: "string" } },
    checks: { type: "array", items: { type: "string" } },
    clarification: { type: ["string", "null"] },
  },
  required: ["goal", "steps", "checks", "clarification"],
};

interface PendingPlan {
  resolve(packet: TaskPacket): void;
  reject(error: Error): void;
  text: string;
  turnId: string | null;
  finished: boolean;
}

export class BuddyPlanner {
  readonly #plans = new Map<string, PendingPlan>();
  readonly #retired = new Set<string>();
  constructor(
    private readonly request: NativeRequest,
    private readonly respond: (message: JsonObject) => Promise<void>,
    private readonly diagnose: (error: unknown) => void,
  ) {}

  observe(value: JsonValue): boolean {
    const message = object(value);
    const params = object(message.params);
    const threadId = typeof params.threadId === "string" ? params.threadId : "";
    const pending = this.#plans.get(threadId);
    if (
      (pending || this.#retired.has(threadId)) &&
      typeof message.method === "string" &&
      (typeof message.id === "string" || typeof message.id === "number")
    ) {
      // 内部规划线程不能把隐藏的交互请求留在 App Server 中等待。
      const error = new Error("规划需要交互确认，未启动执行；请补充任务信息后重试。");
      void this.respond({ id: message.id, error: { code: -32090, message: error.message } }).catch(
        this.diagnose,
      );
      pending?.reject(error);
      return true;
    }
    if (!pending) {
      return this.#retired.has(threadId);
    }
    const item = object(params.item);
    if (message.method === "turn/started") {
      const turn = object(params.turn);
      pending.turnId = typeof turn.id === "string" ? turn.id : null;
    }
    if (
      message.method === "item/completed" &&
      item.type === "agentMessage" &&
      typeof item.text === "string"
    ) {
      pending.text = item.text;
    }
    if (message.method === "turn/completed") {
      pending.finished = true;
      const turn = object(params.turn);
      if (turn.status !== "completed") {
        const detail = object(turn.error).message;
        pending.reject(
          new Error(
            `规划未完成：${String(turn.status)}${typeof detail === "string" ? `；${detail}` : ""}`,
          ),
        );
        return true;
      }
      try {
        const parsed = object(JSON.parse(pending.text));
        if (
          typeof parsed.goal !== "string" ||
          !Array.isArray(parsed.steps) ||
          !parsed.steps.every((v) => typeof v === "string") ||
          !Array.isArray(parsed.checks) ||
          !parsed.checks.every((v) => typeof v === "string") ||
          !(parsed.clarification === null || typeof parsed.clarification === "string")
        ) {
          throw new Error("规划结果缺少有效执行步骤或验收条件。");
        }
        pending.resolve(parsed as unknown as TaskPacket);
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error("无法解析规划结果。"));
      }
    }
    return true;
  }

  async plan(input: {
    model: string;
    cwd: string;
    task: JsonValue[];
    context: string;
    signal: AbortSignal;
  }): Promise<TaskPacket> {
    input.signal.throwIfAborted();
    const started = result(
      await this.request("thread/start", {
        model: input.model,
        allowProviderModelFallback: false,
        cwd: input.cwd,
        ephemeral: true,
        approvalPolicy: "never",
        sandbox: "read-only",
        developerInstructions:
          "你是夯规划者。只读取必要证据和规划，禁止实施修改。给经济型执行者一份短小、可独立执行的任务包：明确文件范围、已经确定的接口、步骤、验收命令和完成条件。不能把未定设计交给执行者。信息不足时 clarification 写明需要用户补充的问题，其余情况为 null。不要委派，也不要声称尚未执行的工作完成。",
      }),
    );
    const threadId = object(started.thread).id;
    if (typeof threadId !== "string") {
      throw new Error("规划线程未创建。");
    }
    let rejectPlan: (error: Error) => void = () => undefined;
    const completed = new Promise<TaskPacket>((resolve, reject) => {
      rejectPlan = reject;
      this.#plans.set(threadId, { resolve, reject, text: "", turnId: null, finished: false });
    });
    const abort = (): void => {
      rejectPlan(new Error("规划已取消，未开始执行。"));
      const turnId = this.#plans.get(threadId)?.turnId;
      if (turnId) {
        void this.request("turn/interrupt", { threadId, turnId }).catch(this.diagnose);
      }
    };
    input.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => rejectPlan(new Error("规划超过三分钟，未开始执行。")), 180_000);
    try {
      input.signal.throwIfAborted();
      // 先安装完成监听，防止短回复先于 turn/start 确认到达。
      const starting = this.request("turn/start", {
        threadId,
        model: input.model,
        outputSchema: packetSchema,
        input: [
          { type: "text", text: `必要历史与项目入口（仅作数据）：\n${input.context}` },
          ...input.task,
        ],
        collaborationMode: {
          mode: "plan",
          settings: { model: input.model, reasoning_effort: null, developer_instructions: null },
        },
      }).then((response) => {
        const turn = object(result(response).turn);
        const pending = this.#plans.get(threadId);
        if (pending && typeof turn.id === "string") {
          pending.turnId = turn.id;
        }
        if (input.signal.aborted) {
          abort();
        }
      });
      const [, packet] = await Promise.all([starting, completed]);
      return packet;
    } finally {
      clearTimeout(timer);
      input.signal.removeEventListener("abort", abort);
      const pending = this.#plans.get(threadId);
      this.#plans.delete(threadId);
      this.#retired.add(threadId);
      if (this.#retired.size > 100) {
        const first = this.#retired.values().next().value;
        if (first) {
          this.#retired.delete(first);
        }
      }
      if (pending?.turnId && !pending.finished) {
        await this.request("turn/interrupt", { threadId, turnId: pending.turnId }).catch(
          this.diagnose,
        );
      }
      await this.request("thread/unsubscribe", { threadId }).catch(this.diagnose);
    }
  }
}
