// A tool recipe is data: no provider, shell, UI or framework dependency.
export const defaultDispatch = { enabled: true, timeoutMs: 3600000 };
export function normalizeDispatch(value = {}) {
  return { enabled: value?.enabled !== false,
    timeoutMs: Number.isSafeInteger(value?.timeoutMs) && value.timeoutMs >= 1000 && value.timeoutMs <= 3600000 ? value.timeoutMs : defaultDispatch.timeoutMs };
}
export const fallback = reason => ({ route: 'llm', reason, providerRequests: 0 });
export const recipe = (id, argv, cwd, source, action) => ({ id, argv, cwd, source, action });
export const matched = command => ({ route: 'tool', model: null, providerRequests: 0, recipe: command });
