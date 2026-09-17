import type { BuddyDecision, BuddySettings, BuddySnapshot } from "@codexhost/shared-contracts";
import type { RendererModelClient } from "../renderer-model-client.js";

const messages = {
  "zh-CN": {
    waiting: "夯规划 → 垃执行",
    disabled: "已关闭",
    disconnected: "未连接路由",
    enabled: "自动路由",
    bypass: "精确命令旁路",
    auto: "自动选择角色",
    git: "Git 智能体",
    io: "IO 操作智能体",
    executor: "编码执行者",
    planner: "夯 · 规划模型",
    worker: "垃 · 执行模型",
    choose: "动态选择",
    refresh: "刷新模型",
    cancel: "取消规划",
    roleLabel: "执行角色",
    reason: "路由依据",
    score: "规则难度分",
    simple: "简单",
    standard: "常规",
    advanced: "复杂",
    steps: "执行步骤",
    checks: "验收条件",
    accepted: "服务端已接受",
    plan: "执行任务包",
    command: "旁路命令",
    exit: "退出码",
    note: "GPT / Claude 归夯，其余归垃。名称排序仅作偏好，不代表实时价格。仅 Codex 执行链启用。",
    idle: "下一轮自动选择；简单操作直接由垃处理。",
    unknown: "未确认",
    noModel: "无模型 · 零推理请求",
    discovering: "读取实时候选",
    planning: "夯正在规划",
    executing: "垃正在执行",
    bypassPhase: "命令旁路",
    completed: "已结束",
    failed: "失败",
    cancelled: "已取消",
  },
  en: {
    waiting: "夯 plans → 垃 executes",
    disabled: "Off",
    disconnected: "Router disconnected",
    enabled: "Auto Router",
    bypass: "Exact command bypass",
    auto: "Automatic role",
    git: "Git agent",
    io: "IO agent",
    executor: "Code executor",
    planner: "夯 · Planner",
    worker: "垃 · Executor",
    choose: "Dynamic selection",
    refresh: "Refresh models",
    cancel: "Cancel planning",
    roleLabel: "Execution role",
    reason: "Routing reason",
    score: "Rule difficulty score",
    simple: "Simple",
    standard: "Standard",
    advanced: "Complex",
    steps: "Steps",
    checks: "Checks",
    accepted: "Accepted by server",
    plan: "Task packet",
    command: "Bypass command",
    exit: "Exit code",
    note: "GPT / Claude = 夯; other models = 垃. Name ordering is a preference, not live pricing. Applies to Codex execution only.",
    idle: "The next turn is routed automatically; simple operations use 垃 directly.",
    unknown: "Unconfirmed",
    noModel: "No model · Zero inference requests",
    discovering: "Discovering models",
    planning: "夯 planning",
    executing: "垃 executing",
    bypassPhase: "Command bypass",
    completed: "Finished",
    failed: "Failed",
    cancelled: "Cancelled",
  },
};

const style = `
[data-buddy-router]{position:relative;font:12px/1.5 system-ui;color:inherit;margin:6px 0;max-width:100%;z-index:20}
[data-buddy-router] summary{cursor:pointer;display:flex;align-items:center;gap:8px;padding:6px 10px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:9px;list-style:none;background:color-mix(in srgb,#4385ff 8%,transparent)}
[data-buddy-router] summary:focus-visible,[data-buddy-router] button:focus-visible,[data-buddy-router] select:focus-visible{outline:2px solid #4385ff;outline-offset:2px}
[data-buddy-router] summary b{color:#508df2;white-space:nowrap}[data-buddy-router] summary span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
[data-buddy-router] .buddy-panel{padding:12px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:9px;margin-top:5px;background:var(--color-token-bg-primary,Canvas);color:var(--color-token-text-primary,CanvasText);max-height:380px;overflow:auto;color-scheme:light dark}
[data-buddy-router] .buddy-settings{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:10px}
[data-buddy-router] label{display:flex;gap:6px;align-items:center;max-width:100%}[data-buddy-router] select{max-width:250px;min-width:90px;flex-shrink:1}
[data-buddy-router] select,[data-buddy-router] button{font:inherit;background:transparent;color:inherit;border:1px solid color-mix(in srgb,currentColor 25%,transparent);border-radius:6px;padding:4px 8px}
[data-buddy-router] option{background:Canvas;color:CanvasText}[data-buddy-router] button{cursor:pointer}
[data-buddy-router] dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 12px;margin:10px 0}
[data-buddy-router] dd{margin:0;overflow-wrap:anywhere;white-space:pre-wrap}[data-buddy-router] dt{opacity:.65}
[data-buddy-router] .buddy-note{opacity:.65;margin:6px 0 0}[data-buddy-router] [role=alert]{color:#d65f55;white-space:pre-wrap}
@media(max-width:500px){[data-buddy-router] label{flex-wrap:wrap}[data-buddy-router] dl{grid-template-columns:minmax(0,1fr);gap:2px}[data-buddy-router] dd{margin-bottom:8px}}
`;

export interface BuddyControlContext {
  anchor: Element;
  threadId: string | null;
  client: RendererModelClient;
}

export function installBuddyControl(
  getContext: () => BuddyControlContext | null,
  getLocale: () => "zh-CN" | "en",
): { dispose(): void; refresh(): Promise<void> } {
  const root = document.createElement("details");
  root.dataset.buddyRouter = "";
  const styles = document.createElement("style");
  styles.textContent = style;
  const summary = document.createElement("summary");
  const title = document.createElement("b");
  title.textContent = "Auto Router";
  const status = document.createElement("span");
  summary.append(title, status);
  const panel = document.createElement("div");
  panel.className = "buddy-panel";
  const controls = document.createElement("div");
  controls.className = "buddy-settings";
  const fields = document.createElement("dl");
  const error = document.createElement("p");
  error.setAttribute("role", "alert");
  const note = document.createElement("p");
  note.className = "buddy-note";
  panel.append(controls, fields, error, note);
  root.append(styles, summary, panel);
  let disposed = false;
  let busy = false;
  let snapshot: BuddySnapshot | null = null;
  let context: BuddyControlContext | null = null;
  let fingerprint = "";
  const t = () => messages[getLocale()];
  const report = (failure: unknown): void => {
    error.textContent = failure instanceof Error ? failure.message : String(failure);
  };
  const setting = async (patch: Partial<BuddySettings>): Promise<void> => {
    const client = context?.client;
    if (!snapshot || !client?.buddyConfigure) {
      return;
    }
    try {
      snapshot = await client.buddyConfigure({ ...snapshot.settings, ...patch });
      render();
    } catch (failure) {
      report(failure);
    }
  };
  const row = (label: string, value: string): void => {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    fields.append(dt, dd);
  };
  const check = (label: string, key: "enabled" | "bypass"): void => {
    const wrapper = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = snapshot?.settings[key] ?? false;
    input.addEventListener("change", () => {
      void setting({ [key]: input.checked });
    });
    wrapper.append(input, document.createTextNode(label));
    controls.append(wrapper);
  };
  const select = (
    label: string,
    entries: [string, string][],
    selected: string,
    change: (id: string) => void,
  ): void => {
    const wrapper = document.createElement("label");
    wrapper.append(document.createTextNode(label));
    const input = document.createElement("select");
    input.setAttribute("aria-label", label || t().roleLabel);
    for (const [id, text] of entries) {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = text;
      input.append(option);
    }
    input.value = selected;
    input.addEventListener("change", () => change(input.value));
    wrapper.append(input);
    controls.append(wrapper);
  };
  const button = (label: string, action: () => Promise<void>): void => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => {
      void action().catch(report);
    });
    controls.append(button);
  };
  const render = (): void => {
    const m = t();
    if (!snapshot) {
      status.textContent = m.disconnected;
      return;
    }
    const decision = snapshot.decisions.find((d) => d.threadId === context?.threadId);
    const phase = (d: BuddyDecision): string => (d.phase === "bypass" ? m.bypassPhase : m[d.phase]);
    status.textContent = !snapshot.settings.enabled
      ? m.disabled
      : decision
        ? `${phase(decision)} · ${decision.command ? m.noModel : decision.phase === "planning" ? (decision.plannerModel ?? m.waiting) : (decision.acceptedModel ?? decision.executorModel ?? m.waiting)}`
        : m.waiting;
    const signature = JSON.stringify([snapshot, context?.threadId, getLocale()]);
    if (signature === fingerprint) {
      return;
    }
    fingerprint = signature;
    controls.replaceChildren();
    fields.replaceChildren();
    error.textContent = "";
    check(m.enabled, "enabled");
    check(m.bypass, "bypass");
    select(
      "",
      ["auto", "git", "io", "executor"].map((role) => [
        role,
        m[role as "auto" | "git" | "io" | "executor"],
      ]),
      snapshot.settings.role,
      (role) => {
        void setting({ role: role as BuddySettings["role"] });
      },
    );
    for (const [key, tier, label] of [
      ["plannerModel", "夯", m.planner],
      ["executorModel", "垃", m.worker],
    ] as const) {
      const options: [string, string][] = [
        ["", m.choose],
        ...snapshot.models
          .filter((model) => model.eligible && model.tier === tier)
          .map((model): [string, string] => [model.id, model.id]),
      ];
      const configured = snapshot.settings[key];
      if (configured && !options.some(([id]) => id === configured)) {
        options.push([configured, `${configured} (${m.unknown})`]);
      }
      select(label, options, configured ?? "", (id) => {
        void setting({ [key]: id || null });
      });
    }
    button(m.refresh, async () => {
      const client = context?.client;
      if (!client?.buddyModels) {
        return;
      }
      snapshot = await client.buddyModels();
      render();
    });
    if (decision) {
      row(m.score, `${decision.score}/100 · ${m[decision.difficulty]}`);
      row(m.reason, decision.reason);
      row(m.planner, decision.plannerModel ?? "—");
      row(m.worker, decision.command ? m.noModel : (decision.executorModel ?? "—"));
      row(m.accepted, decision.acceptedModel ?? (decision.command ? m.noModel : m.unknown));
      if (decision.command) {
        row(m.command, decision.command);
        row(m.exit, decision.exitCode === null ? m.unknown : String(decision.exitCode));
      }
      if (decision.plan) {
        let packet: string = decision.plan;
        try {
          const parsed: unknown = JSON.parse(packet);
          if (
            parsed &&
            typeof parsed === "object" &&
            "goal" in parsed &&
            "steps" in parsed &&
            "checks" in parsed &&
            Array.isArray(parsed.steps) &&
            Array.isArray(parsed.checks)
          ) {
            packet = `${String(parsed.goal)}\n\n${m.steps}\n${parsed.steps.map((step, index) => `${index + 1}. ${String(step)}`).join("\n")}\n\n${m.checks}\n${parsed.checks.map((check) => `• ${String(check)}`).join("\n")}`;
          }
        } catch {
          // 旧版本保存的文本任务包直接展示。
        }
        row(m.plan, packet);
      }
      if (["planning", "discovering"].includes(decision.phase)) {
        button(m.cancel, async () => {
          await context?.client.buddyCancel?.(decision.threadId);
          await refresh();
        });
      }
    } else {
      row("", m.idle);
    }
    note.textContent = m.note;
  };
  const refresh = async (): Promise<void> => {
    if (disposed || busy) {
      return;
    }
    const next = getContext();
    if (!next) {
      root.remove();
      context = null;
      return;
    }
    context = next;
    if (root.parentElement !== next.anchor.parentElement) {
      next.anchor.before(root);
    }
    if (!next.client.buddyStatus) {
      status.textContent = t().disconnected;
      return;
    }
    busy = true;
    try {
      const value = await next.client.buddyStatus();
      if (disposed || context?.client !== next.client || context.threadId !== next.threadId) {
        return;
      }
      snapshot = value;
      render();
    } catch (failure) {
      status.textContent = t().disconnected;
      report(failure);
    } finally {
      busy = false;
    }
  };
  const timer = window.setInterval(() => {
    void refresh();
  }, 1200);
  void refresh();
  return {
    refresh,
    dispose() {
      disposed = true;
      window.clearInterval(timer);
      root.remove();
    },
  };
}
