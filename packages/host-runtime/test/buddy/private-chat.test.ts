import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BuddyPrivateChat,
  explicitlyPrivate,
  privacySafeRequest,
} from "../../src/buddy/private-chat.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((clean) => clean()));
});

async function server(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const instance = createServer(handler);
  await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
  const address = instance.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture address missing");
  }
  cleanups.push(async () => {
    instance.closeAllConnections();
    await new Promise<void>((resolve) => instance.close(() => resolve()));
  });
  return `http://127.0.0.1:${address.port}/v1`;
}

async function fixture(
  options: {
    status?: number;
    redirect?: boolean;
    redirectOnPost?: boolean;
    missingModel?: boolean;
    modelIds?: string[];
    wrongModel?: boolean;
    hold?: boolean;
    configured?: boolean;
  } = {},
) {
  const home = await mkdtemp(join(tmpdir(), "buddy-private-test-"));
  let onlineRequests = 0;
  const online = await server((_req, res) => {
    onlineRequests += 1;
    res.end("online must never receive a private request");
  });
  const requests: {
    url: string;
    body: Record<string, unknown>;
    authorization: string | undefined;
  }[] = [];
  const offline = await server((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      requests.push({ url: req.url ?? "", body, authorization: req.headers.authorization });
      if (options.redirect) {
        res.writeHead(307, { Location: online + "/chat/completions" });
        res.end();
        return;
      }
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/v1/models") {
        res.end(
          JSON.stringify({
            data: (
              options.modelIds ??
              (options.missingModel
                ? ["gpt-online"]
                : ["gpt-online", "q3-4b", "q3-14b", "deepseek-flash"])
            ).map((id) => ({
              id,
            })),
          }),
        );
        return;
      }
      if (options.redirectOnPost) {
        res.writeHead(307, { Location: online + "/chat/completions" });
        res.end();
        return;
      }
      if (options.hold) {
        return;
      }
      if (options.status) {
        res.writeHead(options.status);
        res.end(JSON.stringify({ echo: body }));
        return;
      }
      res.end(
        JSON.stringify({
          model: options.wrongModel ? "gpt-online" : body.model,
          choices: [{ message: { content: "仅来自离线端点的测试回复", tool_calls: null } }],
        }),
      );
    });
  });
  await writeFile(
    join(home, "auth.json"),
    JSON.stringify({ OPENAI_API_KEY: "fixture-gateway-key" }),
    { mode: 0o600 },
  );
  if (options.configured !== false) {
    await writeFile(
      join(home, "config.toml"),
      `model_provider = "gateway"\n[model_providers.gateway]\nbase_url = ${JSON.stringify(offline)}\nrequires_openai_auth = true\n`,
    );
  }
  const chat = new BuddyPrivateChat({
    CODEX_HOME: home,
    OPENAI_API_KEY: "wrong-online-key",
    HTTPS_PROXY: online,
    HTTP_PROXY: online,
    NODE_USE_ENV_PROXY: "1",
  });
  cleanups.push(async () => {
    chat.close();
    await rm(home, { recursive: true, force: true });
  });
  return {
    chat,
    home,
    requests,
    onlineRequests: () => onlineRequests,
    sessionId: randomUUID(),
    offline,
  };
}

describe("gateway q3 privacy channel", () => {
  it("refreshes live availability and rejects a model removed before send", async () => {
    const options = { modelIds: ["gpt-online", "q3-14b", "q3-4b-online"] };
    const f = await fixture(options);
    const request = { action: "status", sessionId: f.sessionId };
    expect((await f.chat.handle(request, true)).models).toEqual(["q3-14b"]);
    options.modelIds = ["gpt-online"];
    await expect(
      f.chat.handle(
        { action: "send", sessionId: f.sessionId, model: "q3-14b", text: "SYNTHETIC_PRIVATE" },
        true,
      ),
    ).rejects.toThrow("没有所选");
    expect((await f.chat.handle(request, true)).models).toEqual([]);
    expect(f.requests.every((request) => request.url === "/v1/models")).toBe(true);
    expect(f.onlineRequests()).toBe(0);
  });
  it("discovers only allowed private models from the configured mixed gateway without extra config", async () => {
    const f = await fixture();
    const status = await f.chat.handle({ action: "status", sessionId: f.sessionId }, true);
    expect(status).toMatchObject({
      configured: true,
      endpoint: f.offline,
      models: ["q3-4b", "q3-14b"],
      messages: [],
    });
    expect(f.requests).toEqual([
      { url: "/v1/models", body: {}, authorization: "Bearer fixture-gateway-key" },
    ]);
    expect(await readdir(f.home)).not.toContain("buddy-private.json");
    expect(f.onlineRequests()).toBe(0);
  });
  it("permits empty UI prewarming but never prompts, injected instructions or a model turn", () => {
    expect(
      privacySafeRequest("thread/start", { model: "gpt-6", cwd: "/synthetic", config: null }),
    ).toBe(true);
    expect(privacySafeRequest("thread/start", { input: [{ text: "SYNTHETIC_PRIVATE" }] })).toBe(
      false,
    );
    expect(privacySafeRequest("thread/start", { developerInstructions: "SYNTHETIC_PRIVATE" })).toBe(
      false,
    );
    expect(privacySafeRequest("thread/start", { config: { model: "online" } })).toBe(false);
    expect(privacySafeRequest("turn/start", {})).toBe(false);
    expect(privacySafeRequest("configRequirements/read", null)).toBe(true);
    expect(privacySafeRequest("experimentalFeature/list", {})).toBe(true);
    expect(privacySafeRequest("skills/list", { cwds: ["/synthetic"] })).toBe(true);
    expect(
      privacySafeRequest("thread/resume", { threadId: "saved-thread", excludeTurns: true }),
    ).toBe(true);
    expect(
      privacySafeRequest("thread/resume", {
        threadId: "saved-thread",
        history: [{ text: "SYNTHETIC_PRIVATE" }],
      }),
    ).toBe(false);
  });
  it("does not transfer existing private history after an endpoint or credential change", async () => {
    const f = await fixture();
    const input = {
      action: "send",
      sessionId: f.sessionId,
      model: "q3-4b",
      text: "SYNTHETIC_PRIVATE",
    };
    await f.chat.handle(input, true);
    await writeFile(
      join(f.home, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: "fixture-different-scope-key" }),
    );
    await expect(f.chat.handle(input, true)).rejects.toThrow("凭据已变更");
    await writeFile(
      join(f.home, "config.toml"),
      `model_provider = "gateway"\n[model_providers.gateway]\nbase_url = ${JSON.stringify(f.offline + "/other")}\nrequires_openai_auth = true\n`,
    );
    await expect(f.chat.handle(input, true)).rejects.toThrow("地址已变更");
    expect(f.requests).toHaveLength(2);
    expect(f.onlineRequests()).toBe(0);
    expect(
      (await f.chat.handle({ action: "status", sessionId: f.sessionId }, false)).messages,
    ).toEqual([]);
  });
  it("uses the Codex gateway credentials and only q3 models, retaining private history outside native tasks", async () => {
    const f = await fixture();
    const first = await f.chat.handle(
      {
        action: "send",
        sessionId: f.sessionId,
        model: "q3-4b",
        text: "SYNTHETIC_PRIVATE_CANARY_1",
      },
      true,
    );
    expect(first.messages).toHaveLength(2);
    const second = await f.chat.handle(
      {
        action: "send",
        sessionId: f.sessionId,
        model: "q3-14b",
        text: "SYNTHETIC_PRIVATE_CANARY_2",
      },
      true,
    );
    expect(second.messages).toHaveLength(4);
    expect(f.onlineRequests()).toBe(0);
    expect(f.requests.every((entry) => entry.authorization === "Bearer fixture-gateway-key")).toBe(
      true,
    );
    const post = f.requests.filter((entry) => entry.url.endsWith("chat/completions"));
    expect(post.map((entry) => entry.body.model)).toEqual(["q3-4b", "q3-14b"]);
    expect(post[1]?.body).toMatchObject({ store: false, stream: false });
    expect(JSON.stringify(post[1]?.body.messages)).toContain("SYNTHETIC_PRIVATE_CANARY_1");
    expect(post[1]?.body).not.toHaveProperty("tools");
    expect(await readdir(f.home)).toEqual(expect.arrayContaining(["config.toml", "auth.json"]));
    expect(await readdir(f.home)).toHaveLength(2);
    f.chat.close();
    expect(
      (await f.chat.handle({ action: "status", sessionId: f.sessionId }, true)).messages,
    ).toEqual([]);
  });

  it.each([{ configured: false }, { missingModel: true }])(
    "fails closed with missing configuration or model: %j",
    async (options) => {
      const f = await fixture(options);
      await expect(
        f.chat.handle(
          { action: "send", sessionId: f.sessionId, model: "q3-4b", text: "SYNTHETIC_PRIVATE" },
          true,
        ),
      ).rejects.toThrow();
      expect(f.requests.some((entry) => entry.url.endsWith("chat/completions"))).toBe(false);
      expect(f.onlineRequests()).toBe(0);
    },
  );

  it.each([{ redirect: true }, { redirectOnPost: true }, { status: 503 }, { wrongModel: true }])(
    "never retries or redirects private text online: %j",
    async (options) => {
      const f = await fixture(options);
      const operation = f.chat.handle(
        { action: "send", sessionId: f.sessionId, model: "q3-14b", text: "SYNTHETIC_PRIVATE" },
        true,
      );
      await expect(operation).rejects.toThrow();
      await expect(operation).rejects.not.toThrow("SYNTHETIC_PRIVATE");
      expect(f.onlineRequests()).toBe(0);
      expect(
        f.requests.filter((entry) => entry.url.endsWith("chat/completions")).length,
      ).toBeLessThanOrEqual(1);
      expect(
        (await f.chat.handle({ action: "cancel", sessionId: f.sessionId }, true)).messages,
      ).toEqual([]);
    },
  );

  it("does not allow online models, tools, rich inputs or disabled private mode", async () => {
    const f = await fixture();
    for (const extra of [
      { model: "gpt-6" },
      { model: "q3-4b", image: "private.png" },
      { model: "q3-4b", tools: [] },
    ]) {
      await expect(
        f.chat.handle(
          { action: "send", sessionId: f.sessionId, text: "SYNTHETIC_PRIVATE", ...extra },
          true,
        ),
      ).rejects.toThrow();
    }
    await expect(
      f.chat.handle(
        { action: "send", sessionId: f.sessionId, text: "SYNTHETIC_PRIVATE", model: "q3-4b" },
        false,
      ),
    ).rejects.toThrow("先启用");
    expect(f.requests).toEqual([]);
    expect(f.onlineRequests()).toBe(0);
  });

  it("aborts an in-flight response and discards history on reset", async () => {
    const f = await fixture({ hold: true });
    const operation = f.chat.handle(
      { action: "send", sessionId: f.sessionId, text: "SYNTHETIC_PRIVATE", model: "q3-4b" },
      true,
    );
    const rejected = expect(operation).rejects.toThrow("取消");
    await vi.waitFor(() => expect(f.requests).toHaveLength(2));
    await f.chat.handle({ action: "reset", sessionId: f.sessionId }, true);
    await rejected;
    expect(
      (await f.chat.handle({ action: "status", sessionId: f.sessionId }, true)).messages,
    ).toEqual([]);
    expect(f.onlineRequests()).toBe(0);
  });

  it("locally blocks explicit privacy labels without pretending to classify all content", () => {
    expect(explicitlyPrivate({ input: [{ text: "【隐私】SYNTHETIC_PRIVATE" }] })).toBe(true);
    expect(explicitlyPrivate({ input: [{ text: "/private SYNTHETIC_PRIVATE" }] })).toBe(true);
    expect(explicitlyPrivate({ input: [{ text: "实现隐私模式功能" }] })).toBe(false);
  });
});
