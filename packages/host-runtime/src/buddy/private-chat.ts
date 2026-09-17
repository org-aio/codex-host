import { createHash } from "node:crypto";
import { z } from "zod";
import { homePath, readConnection } from "@codexhost/buddy-engine";
import {
  buddyPrivateModelSchema,
  buddyPrivateRequestSchema,
  type BuddyPrivateModel,
  type BuddyPrivateSnapshot,
} from "@codexhost/shared-contracts";
import { privateJson } from "./private-transport.js";

type GatewayConfig = {
  modelsUrl: URL;
  completionUrl: URL;
  headers: Headers;
  endpoint: string;
};
type Session = {
  model: BuddyPrivateSnapshot["model"];
  messages: BuddyPrivateSnapshot["messages"];
  controller?: AbortController;
  endpoint: string;
  binding?: string;
};

// 隐私会话只驻留在 Host 内存，不进入 Codex 原生历史、规划、日志或插件工具。
export class BuddyPrivateChat {
  readonly #sessions = new Map<string, Session>();
  readonly #home: string;
  constructor(private readonly environment: NodeJS.ProcessEnv) {
    this.#home = homePath(environment.CODEX_HOME);
  }

  async #config() {
    try {
      const connection = await readConnection(this.#home, this.environment);
      const completionUrl = new URL(connection.url);
      completionUrl.pathname = completionUrl.pathname.replace(/\/models$/u, "/chat/completions");
      return {
        modelsUrl: connection.url,
        completionUrl,
        headers: connection.headers,
        endpoint: connection.url.origin + connection.url.pathname.replace(/\/models$/u, ""),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw new Error("无法读取 Codex 网关配置或凭据；未发送任何隐私内容。");
    }
  }

  async #models(config: GatewayConfig, signal: AbortSignal) {
    const catalog = await privateJson(config.modelsUrl, config.headers, signal);
    const parsed = z.object({ data: z.array(z.object({ id: z.string() })) }).safeParse(catalog);
    if (!parsed.success) {
      throw new Error("网关模型目录无效；未发送对话。");
    }
    const ids = new Set(parsed.data.data.map((model) => model.id));
    return buddyPrivateModelSchema.options.filter((id) => ids.has(id));
  }

  async handle(value: unknown, enabled: boolean): Promise<BuddyPrivateSnapshot> {
    const parsed = buddyPrivateRequestSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error("隐私请求无效；只允许 q3-4b、q3-14b 和纯文本。");
    }
    const input = parsed.data;
    if (!enabled) {
      this.close();
    }
    if (input.action === "reset") {
      this.#sessions.get(input.sessionId)?.controller?.abort();
      this.#sessions.delete(input.sessionId);
    }
    if (input.action === "cancel") {
      this.#sessions.get(input.sessionId)?.controller?.abort();
    }
    const config = await this.#config();
    let models: BuddyPrivateModel[] = [];
    if (enabled && config && input.action === "status") {
      models = await this.#models(config, AbortSignal.timeout(10_000));
    }
    if (input.action === "send") {
      if (!enabled) {
        throw new Error("请先启用离线隐私模式；内容没有发送。");
      }
      if (!config) {
        throw new Error("未配置 Codex 网关；内容没有发送。");
      }
      let session = this.#sessions.get(input.sessionId);
      if (session?.controller) {
        throw new Error("离线模型仍在回复，请等待或取消。");
      }
      if (session && session.endpoint !== config.modelsUrl.href) {
        throw new Error("网关地址已变更，请清空隐私对话后重试。");
      }
      if (!session) {
        if (this.#sessions.size >= 16) {
          throw new Error("隐私会话数量已达上限，请清空不用的会话。");
        }
        session = { model: null, messages: [], endpoint: config.modelsUrl.href };
        this.#sessions.set(input.sessionId, session);
      }
      if (
        session.messages.reduce((size, message) => size + message.text.length, 0) +
          input.text.length >
        96_000
      ) {
        throw new Error("隐私上下文已达上限，请清空后重新开始；不会调用在线摘要。");
      }
      const controller = new AbortController();
      session.controller = controller;
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]);
      try {
        const binding = createHash("sha256")
          .update(config.modelsUrl.href + "\n" + JSON.stringify([...config.headers].sort()))
          .digest("hex");
        if (session.binding && session.binding !== binding) {
          throw new Error("网关凭据已变更，请先清空隐私会话。");
        }
        session.binding = binding;
        models = await this.#models(config, signal);
        if (!models.includes(input.model)) {
          throw new Error("网关目录没有所选 q3 模型；未发送对话、未回退在线。");
        }
        signal.throwIfAborted();
        const messages = [...session.messages, { role: "user" as const, text: input.text }];
        const response = await privateJson(config.completionUrl, config.headers, signal, {
          model: input.model,
          messages: messages.map((message) => ({ role: message.role, content: message.text })),
          stream: false,
          store: false,
          max_tokens: 2048,
        });
        const completion = z
          .object({
            model: z.enum(["q3-4b", "q3-14b"]).optional(),
            choices: z
              .array(
                z.object({
                  message: z.object({
                    content: z.string(),
                    tool_calls: z.array(z.unknown()).length(0).nullable().optional(),
                  }),
                }),
              )
              .min(1),
          })
          .safeParse(response);
        if (
          !completion.success ||
          (completion.data.model && completion.data.model !== input.model)
        ) {
          throw new Error("离线响应模型不匹配或协议无效；已拒绝结果，未回退在线。");
        }
        signal.throwIfAborted();
        if (this.#sessions.get(input.sessionId) !== session) {
          throw new Error("隐私会话已清空。");
        }
        session.messages = [
          ...messages,
          { role: "assistant", text: completion.data.choices[0]?.message.content ?? "" },
        ];
        session.model = input.model;
      } catch (error) {
        if (signal.aborted) {
          throw new Error("离线请求已取消或超时；没有转交在线模型。");
        }
        throw error;
      } finally {
        delete session.controller;
      }
    }
    const session = this.#sessions.get(input.sessionId);
    return {
      sessionId: input.sessionId,
      configured: config !== null,
      endpoint: config?.endpoint ?? null,
      models,
      model: session?.model ?? null,
      busy: Boolean(session?.controller),
      messages: session?.messages ?? [],
    };
  }

  close(): void {
    for (const session of this.#sessions.values()) {
      session.controller?.abort();
    }
    this.#sessions.clear();
  }
}

// 普通输入只做本地明确标记拦截；不能宣称用规则识别了所有敏感信息。
export function explicitlyPrivate(params: unknown): boolean {
  return /(?:^|["\n])\s*(?:\/private\b|【隐私】|\[private\]|隐私[:：]|敏感[:：])|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu.test(
    JSON.stringify(params ?? {}),
  );
}

export function privacySafeRequest(method: string, params?: unknown): boolean {
  if (method === "thread/start" || method === "thread/resume") {
    // 允许桌面预热空任务，但不能携带提示、历史或配置注入，更不能开始回合。
    const emptyThread = z
      .object({
        model: z.string().nullable().optional(),
        modelProvider: z.string().nullable().optional(),
        cwd: z.string().nullable().optional(),
        serviceTier: z.string().nullable().optional(),
        approvalPolicy: z.string().nullable().optional(),
        sandbox: z.string().nullable().optional(),
        ephemeral: z.boolean().nullable().optional(),
        approvalsReviewer: z.string().nullable().optional(),
        permissions: z.string().nullable().optional(),
        personality: z.string().nullable().optional(),
        historyMode: z.string().nullable().optional(),
        projectId: z.string().nullable().optional(),
        serviceName: z.string().nullable().optional(),
        sessionStartSource: z.string().nullable().optional(),
        threadSource: z.string().nullable().optional(),
        multiAgentMode: z.string().nullable().optional(),
        allowProviderModelFallback: z.boolean().optional(),
        dynamicTools: z.array(z.never()).nullable().optional(),
        environments: z.array(z.never()).nullable().optional(),
        selectedCapabilityRoots: z.array(z.never()).nullable().optional(),
        runtimeWorkspaceRoots: z.array(z.string()).nullable().optional(),
        experimentalRawEvents: z.boolean().optional(),
        persistExtendedHistory: z.boolean().optional(),
        baseInstructions: z.null().optional(),
        developerInstructions: z.null().optional(),
        config: z.null().optional(),
      })
      .strict();
    if (method === "thread/resume") {
      return emptyThread
        .extend({
          threadId: z.string(),
          excludeTurns: z.boolean().optional(),
          history: z.null().optional(),
          path: z.null().optional(),
        })
        .safeParse(params).success;
    }
    return emptyThread.safeParse(params ?? {}).success;
  }
  return [
    "thread/list",
    "thread/read",
    "thread/items/list",
    "thread/turns/list",
    "thread/goal/get",
    "thread/queue/list",
    "thread/backgroundTerminals/list",
    "thread/timeline/list",
    "thread/loaded/list",
    "thread/unsubscribe",
    "turn/interrupt",
    "model/list",
    "config/read",
    "configRequirements/read",
    "experimentalFeature/list",
    "permissionProfile/list",
    "modelProvider/capabilities/read",
    "project/list",
    "project/read",
    "threadSection/list",
    "skills/list",
    "hooks/list",
    "plugin/list",
    "app/list",
    "mcpServerStatus/list",
    "environment/status",
    "account/read",
    "account/rateLimits/read",
    "account/usage/read",
    "collaborationMode/list",
    "codexhost/harness/plugins/list",
    "codexhost/harness/inspect",
    "codexhost/thread/inspect",
    "codexhost/thread/ownership/list",
  ].includes(method);
}
