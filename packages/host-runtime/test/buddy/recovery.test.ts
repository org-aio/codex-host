import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomaticRecovery } from "../../src/buddy/recovery.js";

const services: AutomaticRecovery[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.close();
});
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture() {
  const resume = vi.fn(async () => {});
  const nextModel = vi.fn(
    async (_id: string, excluded: Set<string>) =>
      ["cheap-a", "cheap-b", "cheap-c"].find((model) => !excluded.has(model)) ?? null,
  );
  const report = vi.fn();
  const wait = vi.fn(async () => {});
  const service = new AutomaticRecovery({ resume, nextModel, report, wait });
  services.push(service);
  service.watch("thread", "cheap-a");
  const fail = async (turn: string) => {
    service.started("thread", turn);
    service.completed("thread", turn, "failed", { message: "connection reset" });
    await flush();
  };
  return { service, resume, nextModel, report, wait, fail };
}

describe("automatic recovery", () => {
  it("continues twice on the same model, switches on the third failure and stops at nine", async () => {
    const f = fixture();
    for (let i = 1; i <= 9; i++) await f.fail(`turn-${i}`);
    expect(f.resume.mock.calls.map((args: unknown[]) => args[2])).toEqual([
      "cheap-a",
      "cheap-a",
      "cheap-b",
      "cheap-b",
      "cheap-b",
      "cheap-c",
      "cheap-c",
      "cheap-c",
    ]);
    expect(f.nextModel).toHaveBeenCalledTimes(2);
    expect(f.report).toHaveBeenLastCalledWith(
      "thread",
      expect.stringContaining("失败 9 次"),
      "cheap-c",
      true,
    );
    expect(f.service.pending).toBe(false);
  });

  it.each(["completed", "interrupted", "cancelled"])("does not retry %s", async (status) => {
    const f = fixture();
    f.service.started("thread", "turn");
    f.service.completed("thread", "turn", status, null);
    await flush();
    expect(f.resume).not.toHaveBeenCalled();
  });

  it.each([
    "permission denied",
    "HTTP 401",
    "contextWindowExceeded",
    "safety policy",
    "Range of input length should be [1, 13000]",
  ])("does not bypass %s", async (message) => {
    const f = fixture();
    f.service.started("thread", "turn");
    f.service.completed("thread", "turn", "failed", { message });
    await flush();
    expect(f.resume).not.toHaveBeenCalled();
  });

  it("deduplicates final notifications and ignores unrelated turns", async () => {
    const f = fixture();
    await f.fail("turn");
    f.service.completed("thread", "turn", "failed", null);
    f.service.completed("thread", "other", "failed", null);
    await flush();
    expect(f.resume).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      message:
        "stream disconnected before completion: [StringParam] [input[9].name] [invalid_string] Invalid 'input[9].name': string does not match pattern. Expected a string that matches the pattern '^[a-zA-Z0-9_-]+$'.",
      codexErrorInfo: "other",
    },
    { message: "upstream error", code: "invalid_request_error" },
    { message: "invalid argument: tools" },
    { message: "Unknown parameter: input[9].namespace" },
    { message: "Missing required parameter: tools[0].name" },
    { message: "Unsupported parameter: tool_choice" },
    { message: "unexpected status 400 Bad Request" },
    { message: "HTTP 422 Unprocessable Entity" },
    { message: "stream disconnected", codexErrorInfo: { httpStatusCode: 400 } },
  ])("stops invalid requests before scheduling another turn: %j", async (error) => {
    const f = fixture();
    f.service.started("thread", "turn");
    f.service.completed("thread", "turn", "failed", error);
    await flush();
    expect(f.wait).not.toHaveBeenCalled();
    expect(f.resume).not.toHaveBeenCalled();
    expect(f.nextModel).not.toHaveBeenCalled();
    expect(f.report).toHaveBeenLastCalledWith(
      "thread",
      expect.stringContaining("请求参数或工具协议校验失败"),
      "cheap-a",
      true,
    );
    expect(f.service.pending).toBe(false);
    expect(f.service.started("thread", "next")).toBe(false);
  });

  it.each(["HTTP 429 Too Many Requests", "HTTP 500", "HTTP 503", "stream disconnected"])(
    "still retries transient failures: %s",
    async (message) => {
      const f = fixture();
      f.service.started("thread", "turn");
      f.service.completed("thread", "turn", "failed", { message });
      await flush();
      expect(f.resume).toHaveBeenCalledTimes(1);
    },
  );

  it("cancels during backoff and a new user request starts a fresh budget", async () => {
    const f = fixture();
    let release: () => void = () => {};
    f.wait.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await f.fail("old");
    f.service.watch("thread", "cheap-b");
    release();
    await flush();
    expect(f.resume).not.toHaveBeenCalled();
    await f.fail("new");
    expect(f.resume).toHaveBeenLastCalledWith("thread", "new", "cheap-b", expect.any(AbortSignal));
  });

  it("stops when no compatible replacement exists", async () => {
    const f = fixture();
    f.nextModel.mockResolvedValue(null);
    await f.fail("1");
    await f.fail("2");
    await f.fail("3");
    expect(f.resume).toHaveBeenCalledTimes(2);
    expect(f.report).toHaveBeenLastCalledWith(
      "thread",
      expect.stringContaining("没有其他"),
      "cheap-a",
      true,
    );
  });

  it("does not replay a continuation whose send result is unknown", async () => {
    const f = fixture();
    f.resume.mockRejectedValue(new Error("connection closed before response"));
    await f.fail("1");
    await f.fail("2");
    expect(f.resume).toHaveBeenCalledTimes(1);
    expect(f.report).toHaveBeenLastCalledWith(
      "thread",
      expect.stringContaining("connection closed"),
      "cheap-a",
      true,
    );
  });
});
