import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "smol-toml";
import { readConnection as readVendorConnection } from "./vendor/config/index.mjs";

// 跟随 Codex 的已登录凭据，避免终端继承的其他供应商 OPENAI_API_KEY 覆盖 requires_openai_auth。
export async function readConnection(home, environment = process.env) {
  const config = parse(await readFile(join(home, "config.toml"), "utf8"));
  const provider = config.model_providers?.[config.model_provider || "openai"];
  if (
    provider?.requires_openai_auth &&
    !provider.env_key &&
    !provider.auth?.command &&
    !provider.experimental_bearer_token
  ) {
    let auth;
    try {
      auth = JSON.parse(await readFile(join(home, "auth.json"), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw new Error("无法读取 Codex 登录凭据。");
      }
    }
    if (typeof auth?.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY) {
      return readVendorConnection(home, { ...environment, OPENAI_API_KEY: auth.OPENAI_API_KEY });
    }
  }
  return readVendorConnection(home, environment);
}
