import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readConnection } from "@codexhost/buddy-engine";
import type { BuddyModel, BuddySettings } from "@codexhost/shared-contracts";

export interface ModelInventory {
  models: BuddyModel[];
  provider: string;
  planner: string | null;
  executor: string | null;
}

export function modelTier(id: string): "夯" | "垃" {
  return /(?:^|[/:])(?:gpt|claude)(?=[\d._-]|$)/iu.test(id) ? "夯" : "垃";
}

export function chooseModels(
  ids: string[],
  nativeIds: Set<string>,
  preferred: { planner?: string | null; executor?: string | null },
): Pick<ModelInventory, "models" | "planner" | "executor"> {
  const models: BuddyModel[] = [...new Set(ids)].map((id) => ({
    id,
    tier: modelTier(id),
    eligible:
      nativeIds.has(id) &&
      !/(?:embedding|rerank|moderation|whisper|tts|image|audio|vision-only)/iu.test(id),
  }));
  const strong = models.filter((m) => m.eligible && m.tier === "夯");
  const weak = models.filter((m) => m.eligible && m.tier === "垃");
  const planner =
    strong.find((m) => m.id === preferred.planner) ??
    strong.sort((a, b) => {
      const gpt = (m: BuddyModel): number => (/(?:^|[/:])gpt/iu.test(m.id) ? 1 : 0);
      return gpt(b) - gpt(a) || b.id.localeCompare(a.id, "en", { numeric: true });
    })[0];
  const executor =
    weak.find((m) => m.id === preferred.executor) ??
    weak.sort((a, b) => {
      const economyHint = (m: BuddyModel): number =>
        /flash|mini|nano|small|lite/iu.test(m.id) ? 1 : 0;
      return economyHint(b) - economyHint(a) || b.id.localeCompare(a.id, "en", { numeric: true });
    })[0];
  return { models, planner: planner?.id ?? null, executor: executor?.id ?? null };
}

export async function discoverModels(input: {
  home: string;
  environment: NodeJS.ProcessEnv;
  settings: BuddySettings;
  nativeIds: Set<string>;
  signal: AbortSignal;
}): Promise<ModelInventory> {
  const connection = await readConnection(input.home, input.environment);
  const response = await fetch(connection.url, {
    headers: connection.headers,
    redirect: "error",
    signal: AbortSignal.any([input.signal, AbortSignal.timeout(8000)]),
  });
  if (!response.ok) {
    throw new Error(`供应商 /models 请求失败 HTTP ${response.status}，未启动模型。`);
  }
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || !("data" in body) || !Array.isArray(body.data)) {
    throw new Error("供应商 /models 返回格式无效。");
  }
  const ids = body.data.flatMap((item: unknown) => {
    if (item && typeof item === "object" && "id" in item && typeof item.id === "string") {
      return [item.id];
    }
    return [];
  });
  let previous: { planning?: { plannerModel?: string; executorModel?: string } } = {};
  try {
    previous = JSON.parse(await readFile(join(input.home, "model-router", "policy.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error("无法读取现有 Buddy 规划策略。");
    }
  }
  const configModel = typeof connection.config.model === "string" ? connection.config.model : null;
  const chosen = chooseModels(ids, input.nativeIds, {
    planner: input.settings.plannerModel ?? previous.planning?.plannerModel ?? configModel,
    executor: input.settings.executorModel ?? previous.planning?.executorModel ?? null,
  });
  return { ...chosen, provider: connection.providerId };
}
