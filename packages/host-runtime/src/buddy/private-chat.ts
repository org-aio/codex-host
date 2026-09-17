import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { homePath } from "@codexhost/buddy-engine";
import { buddyPrivateRequestSchema, type BuddyPrivateSnapshot } from "@codexhost/shared-contracts";
import { privateJson } from "./private-transport.js";

const configSchema = z
  .object({
    baseUrl: z.string().url(),
    offlineOnly: z.literal(true),
    apiKeyEnv: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
      .optional(),
    apiKeyFile: z.string().min(1).optional(),
  })
  .strict()
  .refine((value) => !(value.apiKeyEnv && value.apiKeyFile));
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
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(join(this.#home, "buddy-private.json"), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw new Error("无法读取离线专用配置；未发送任何隐私内容。");
    }
    const parsed = configSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error("离线专用配置无效；必须确认 offlineOnly，并使用独立地址与凭据。");
    }
    const url = new URL(parsed.data.baseUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("离线地址必须是无凭据、查询参数和片段的 HTTP(S) API 地址。");
    }
    url.pathname = url.pathname.replace(/\/$/u, "") + "/";
    return { ...parsed.data, url };
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
    if (input.action === "send") {
      if (!enabled) {
        throw new Error("请先启用离线隐私模式；内容没有发送。");
      }
      if (!config) {
        throw new Error("未配置离线专用端点；内容没有发送。");
      }
      let session = this.#sessions.get(input.sessionId);
      if (session?.controller) {
        throw new Error("离线模型仍在回复，请等待或取消。");
      }
      if (session && session.endpoint !== config.url.href) {
        throw new Error("离线地址已变更，请清空隐私对话后重试。");
      }
      if (!session) {
        if (this.#sessions.size >= 16) {
          throw new Error("隐私会话数量已达上限，请清空不用的会话。");
        }
        session = { model: null, messages: [], endpoint: config.url.href };
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
        let key: string | null = null;
        if (config.apiKeyEnv) {
          key = this.environment[config.apiKeyEnv]?.trim() ?? null;
          if (!key) {
            throw new Error("离线专用凭据环境变量未配置。");
          }
        }
        if (config.apiKeyFile) {
          try {
            key = (await readFile(config.apiKeyFile, "utf8")).trim();
          } catch {
            throw new Error("离线专用凭据文件不可读取。");
          }
          if (!key) {
            throw new Error("离线专用凭据文件为空。");
          }
        }
        if (key && /[\r\n\0]/u.test(key)) {
          throw new Error("离线专用凭据格式无效。");
        }
        const binding = createHash("sha256")
          .update(config.url.href + "\n" + (key ?? ""))
          .digest("hex");
        if (session.binding && session.binding !== binding) {
          throw new Error("离线凭据已变更，请先清空隐私会话。");
        }
        session.binding = binding;
        const catalog = await privateJson(new URL("models", config.url), key, signal);
        const models = z.object({ data: z.array(z.object({ id: z.string() })) }).safeParse(catalog);
        if (!models.success || !models.data.data.some((model) => model.id === input.model)) {
          throw new Error("离线端点没有所选 q3 模型；未发送对话、未回退在线。");
        }
        signal.throwIfAborted();
        const messages = [...session.messages, { role: "user" as const, text: input.text }];
        const response = await privateJson(new URL("chat/completions", config.url), key, signal, {
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
      endpoint: config?.url.href ?? null,
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
  if (method === "thread/start") {
    // 允许桌面预热空任务，但不能携带提示、历史或配置注入，更不能开始回合。
    const emptyThread = z
      .object({
        model: z.string().nullable().optional(),
        modelProvider: z.string().nullable().optional(),
        cwd: z.string().nullable().optional(),
        serviceTier: z.string().nullable().optional(),
        approvalPolicy: z.string().nullable().optional(),
        sandbox: z.string().nullable().optional(),
        ephemeral: z.boolean().optional(),
        experimentalRawEvents: z.boolean().optional(),
        persistExtendedHistory: z.boolean().optional(),
        baseInstructions: z.null().optional(),
        developerInstructions: z.null().optional(),
        config: z.null().optional(),
      })
      .strict();
    return emptyThread.safeParse(params ?? {}).success;
  }
  return [
    "thread/list",
    "thread/read",
    "thread/items/list",
    "thread/loaded/list",
    "thread/unsubscribe",
    "turn/interrupt",
    "model/list",
    "config/read",
    "account/read",
    "account/rateLimits/read",
    "collaborationMode/list",
    "codexhost/harness/plugins/list",
    "codexhost/harness/inspect",
    "codexhost/thread/inspect",
    "codexhost/thread/ownership/list",
  ].includes(method);
}
