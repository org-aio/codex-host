import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

// 复用网关认证头，隔离全局 Agent 和环境代理，不跟随重定向。
export async function privateJson(
  url: URL,
  headers: Headers,
  signal: AbortSignal,
  body?: unknown,
): Promise<unknown> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = send(
      url,
      {
        method: payload === undefined ? "GET" : "POST",
        agent: false,
        signal,
        headers: {
          ...Object.fromEntries(headers),
          Accept: "application/json",
          ...(payload
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
            : {}),
        },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`离线接口返回 HTTP ${response.statusCode ?? 0}；未重试或回退在线。`));
          return;
        }
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > 1_048_576) {
            response.destroy();
            reject(new Error("离线响应过大；未回退在线。"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", () => reject(new Error("离线响应读取失败；未回退在线。")));
        response.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(new Error("离线接口返回无效 JSON；未回退在线。"));
          }
        });
      },
    );
    request.on("error", () =>
      reject(
        new Error(signal.aborted ? "离线请求已取消或超时。" : "离线服务连接失败；未回退在线。"),
      ),
    );
    request.end(payload);
  });
}
