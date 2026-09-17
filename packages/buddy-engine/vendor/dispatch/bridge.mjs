import { join, resolve } from 'node:path';
import { readJson } from '../runtime/index.mjs';
import { normalizeDispatch } from './model.mjs';
import { resolveDispatch } from './resolve.mjs';
import { shellCommand } from './command.mjs';

// Only server-confirmed permissions count. turn/start overrides are not applied by shellCommand.
export function compatibleTurn(params, thread, platform = process.platform) {
  if (platform === 'win32' || !thread?.cwd || thread.sandbox?.type !== 'dangerFullAccess' || thread.approvalPolicy !== 'never') return false;
  if (thread.mode === 'plan' || params.collaborationMode?.mode === 'plan') return false;
  if (params.collaborationMode?.settings?.developer_instructions) return false;
  if (!thread.environments?.length || thread.environments.some(item => item.environmentId !== 'local')) return false;
  if (params.input?.length !== 1 || params.input[0].type !== 'text' || params.input[0].text_elements?.length) return false;
  if (params.cwd && resolve(params.cwd) !== resolve(thread.cwd)) return false;
  if (params.approvalPolicy != null && params.approvalPolicy !== thread.approvalPolicy) return false;
  if (params.sandboxPolicy != null && params.sandboxPolicy.type !== 'dangerFullAccess') return false;
  // These request semantics cannot be preserved by a shell-only native turn.
  if (['permissions', 'environments', 'runtimeWorkspaceRoots', 'outputSchema', 'additionalContext', 'toolOutput', 'approvalsReviewer'].some(key => params[key] != null)) return false;
  return true;
}
export function threadState(result, request = {}, previous = {}) {
  return { ...previous, cwd: result.cwd || result.thread?.cwd || previous.cwd,
    provider: result.modelProvider || previous.provider, model: result.model || previous.model,
    sandbox: result.sandbox || previous.sandbox, approvalPolicy: result.approvalPolicy || previous.approvalPolicy,
    environments: result.thread?.environments || previous.environments,
    mode: request.collaborationMode?.mode || request.config?.collaboration_mode || previous.mode || 'default' };
}
export function turnState(params, previous = {}) {
  // Native turns apply these settings persistently; track restrictions even after a routed turn.
  return { ...previous, cwd: params.cwd || previous.cwd, sandbox: params.permissions ? null : params.sandboxPolicy || previous.sandbox,
    approvalPolicy: params.approvalPolicy || previous.approvalPolicy, environments: params.environments || previous.environments,
    mode: params.collaborationMode?.mode || previous.mode };
}
export async function prepareDispatch(home, params, thread) {
  if (!compatibleTurn(params, thread)) return null;
  const policy = await readJson(join(home, 'model-router', 'policy.json'), {});
  const settings = normalizeDispatch(policy.dispatch);
  if (policy.enabled === false || !settings.enabled) return null;
  const plan = await resolveDispatch(params.input[0].text, thread.cwd);
  if (plan.route !== 'tool') return null;
  return { ...plan, timeoutMs: settings.timeoutMs, command: shellCommand(plan.recipe, params.input[0].text, process.argv[1]) };
}

export function dispatchLifecycle({ send, warn, record, release }) {
  const requests = new Map(), threads = new Map();
  const state = (entry, extra = {}) => ({ at: new Date().toISOString(), threadId: entry.threadId, turnId: entry.turn?.id || null,
    routed: true, route: 'tool', model: null, providerRequests: 0, rule: entry.plan.recipe.id, ...extra });
  const reject = (entry, failure) => {
    clearTimeout(entry.timer); requests.delete(entry.id); threads.delete(entry.threadId);
    if (!entry.turn) release?.(entry.threadId);
    send({ id: entry.id, error: failure });
    record(state(entry, { accepted: false, status: 'failed' }));
  };
  const acknowledge = entry => {
    if (!entry.acked || !entry.turn || entry.responded) return;
    entry.responded = true; clearTimeout(entry.timer); requests.delete(entry.id);
    send({ id: entry.id, result: { turn: entry.turn } });
    warn(entry.threadId, `Auto 规则直达：${entry.plan.recipe.id}；模型：无；未请求模型目录或推理。命令结果见原生执行记录。`);
    if (!entry.completed) record(state(entry, { accepted: true, status: 'inProgress' }));
  };
  return {
    submit(id, threadId, plan) {
      const entry = { id, threadId, plan };
      entry.timer = setTimeout(() => {
        reject(entry, { code: -32000, message: 'Native command acknowledgement timed out; execution may have started. Inspect the thread before retrying.' });
      }, 15000);
      requests.set(id, entry); threads.set(threadId, entry);
      return { id, method: 'thread/shellCommand', params: { threadId, command: plan.command, timeoutMs: plan.timeoutMs } };
    },
    handle(message) {
      if (!message.method && requests.has(message.id)) {
        const entry = requests.get(message.id);
        if (message.error) reject(entry, message.error);
        else { entry.acked = true; acknowledge(entry); }
        return true;
      }
      const entry = threads.get(message.params?.threadId);
      if (!entry) return false;
      if (message.method === 'turn/started' && !entry.turn) { entry.turn = message.params.turn; acknowledge(entry); }
      if (message.method === 'item/completed' && message.params.turnId === entry.turn?.id && message.params.item?.type === 'commandExecution') {
        entry.exitCode = message.params.item.exitCode;
        entry.commandStatus = message.params.item.status;
      }
      if (message.method === 'turn/completed' && message.params.turn.id === entry.turn?.id) {
        entry.completed = true;
        const success = entry.exitCode === 0 && entry.commandStatus === 'completed';
        record(state(entry, { accepted: true, status: message.params.turn.status, exitCode: entry.exitCode ?? null, success }));
        if (!success) warn(entry.threadId, 'Auto 规则直达：命令未成功完成；保留真实结果，没有自动重放或调用模型修复。');
        clearTimeout(entry.timer); threads.delete(entry.threadId);
      }
      return false;
    },
    close() { for (const entry of [...threads.values(), ...requests.values()]) clearTimeout(entry.timer); requests.clear(); threads.clear(); },
  };
}
