export interface ThreadContext {
  cwd?: string;
  provider?: string;
  model?: string;
  sandbox?: Record<string, unknown>;
  approvalPolicy?: unknown;
  environments?: { environmentId: string }[];
  mode?: string;
}
export interface Assessment {
  tier: "simple" | "standard" | "advanced";
  intent: string;
  reason: string;
}
export interface Project {
  root: string | null;
  stacks: string[];
  keywords: string[];
  commands: { command: string; cwd: string; source: string; action: string }[];
}
export interface Recipe {
  id: string;
  argv: string[];
  cwd: string;
  source: string;
  action: string;
}
export interface Dispatch {
  route: "tool" | "clarify" | "llm";
  reason?: string;
  recipe?: Recipe;
  choices?: unknown[];
}
export function homePath(value?: string): string;
export function readConnection(
  home: string,
  env?: NodeJS.ProcessEnv,
): Promise<{
  config: Record<string, unknown>;
  providerId: string;
  url: URL;
  headers: Headers;
  catalogPath?: string;
}>;
export function assess(input: unknown, cwd?: string, project?: Project): Promise<Assessment>;
export function inspectProject(cwd?: string): Promise<Project>;
export function resolveDispatch(
  text: string,
  cwd: string,
  options?: { project: Project },
): Promise<Dispatch>;
export function compatibleTurn(
  params: Record<string, unknown>,
  thread?: ThreadContext,
  platform?: string,
): boolean;
export function threadState(
  result: Record<string, unknown>,
  request?: Record<string, unknown>,
  previous?: ThreadContext,
): ThreadContext;
export function turnState(params: Record<string, unknown>, previous?: ThreadContext): ThreadContext;
export function dispatchLifecycle(callbacks: {
  send(value: unknown): void;
  warn(threadId: string, message: string): void;
  record(value: Record<string, unknown>): void;
  release(threadId: string): void;
}): {
  submit(
    id: string | number,
    threadId: string,
    plan: unknown,
  ): { id: string | number; method: string; params: Record<string, unknown> };
  handle(message: unknown): boolean;
  close(): void;
};
