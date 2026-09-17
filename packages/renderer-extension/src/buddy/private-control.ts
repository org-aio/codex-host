import type { BuddyPrivateModel, BuddyPrivateSnapshot } from "@codexhost/shared-contracts";
import type { RendererModelClient } from "../renderer-model-client.js";

const messages = {
  "zh-CN": {
    title: "离线隐私对话",
    note: "仅使用网关中的自部署 q3。隐私模式已阻止在线模型发送，对话仅在内存保留。",
    placeholder: "敏感内容仅输入此处…（纯文本）",
    send: "发送至离线模型",
    cancel: "取消",
    clear: "清空隐私对话",
    missing: "Codex 网关配置或凭据不可用。",
    noModels: "网关目录中没有可用的 q3-4b 或 q3-14b，发送已禁用。",
    refresh: "刷新模型",
    disconnected: "隐私通道未连接；不会改用普通发送。",
    pending: "离线模型正在回复…",
    ready: "当前网关：",
    model: "离线模型",
    user: "你",
    assistant: "离线回复",
    error: "隐私请求失败；没有回退在线。",
  },
  en: {
    title: "Offline private chat",
    note: "Uses only self-hosted q3 models on your gateway. Online model requests are blocked. History stays in memory.",
    placeholder: "Sensitive text goes only here… (text only)",
    send: "Send offline",
    cancel: "Cancel",
    clear: "Clear private chat",
    missing: "Codex gateway configuration or credentials unavailable.",
    noModels: "No q3-4b or q3-14b in the gateway catalog. Sending is disabled.",
    refresh: "Refresh models",
    disconnected: "Private channel disconnected; normal sending is never used.",
    pending: "Offline model is replying…",
    ready: "Current gateway: ",
    model: "Offline model",
    user: "You",
    assistant: "Offline reply",
    error: "Private request failed; no online fallback.",
  },
};

// 独立 DOM 与 RPC，不读取或写入原生输入框、任务历史、剪贴板或本地存储。
export function createPrivateControl(getLocale: () => "zh-CN" | "en") {
  const element = document.createElement("section");
  element.dataset.buddyPrivate = "";
  element.hidden = true;
  const title = document.createElement("h3");
  const note = document.createElement("p");
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  const transcript = document.createElement("div");
  transcript.className = "buddy-private-transcript";
  const textarea = document.createElement("textarea");
  textarea.rows = 4;
  textarea.maxLength = 32_000;
  textarea.autocomplete = "off";
  textarea.spellcheck = false;
  textarea.setAttribute("data-gramm", "false");
  const model = document.createElement("select");
  const actions = document.createElement("div");
  actions.className = "buddy-settings";
  const send = document.createElement("button");
  const cancel = document.createElement("button");
  const clear = document.createElement("button");
  const reload = document.createElement("button");
  for (const button of [send, cancel, clear, reload]) {
    button.type = "button";
  }
  actions.append(model, reload, send, cancel, clear);
  const error = document.createElement("p");
  error.setAttribute("role", "alert");
  element.append(title, note, status, transcript, textarea, actions, error);
  // 阻止普通 composer 的冒泡处理器拿到隐私输入；发送始终由本控件的按钮触发。
  for (const name of ["input", "change", "keydown", "keyup", "click", "paste", "drop"]) {
    element.addEventListener(name, (event) => event.stopPropagation());
  }
  let client: RendererModelClient | null = null;
  let active = false;
  let pending = false;
  let generation = 0;
  let sessionId = crypto.randomUUID();
  let snapshot: BuddyPrivateSnapshot | null = null;
  const t = () => messages[getLocale()];
  const render = (): void => {
    const m = t();
    title.textContent = m.title;
    note.textContent = m.note;
    textarea.placeholder = m.placeholder;
    textarea.setAttribute("aria-label", m.placeholder);
    model.setAttribute("aria-label", m.model);
    const selected = model.value;
    model.replaceChildren();
    for (const id of snapshot?.models ?? []) {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = id;
      model.append(option);
    }
    if (snapshot?.models.includes(selected as BuddyPrivateModel)) {
      model.value = selected;
    }
    send.textContent = m.send;
    cancel.textContent = m.cancel;
    clear.textContent = m.clear;
    reload.textContent = m.refresh;
    reload.disabled = pending;
    send.disabled = pending || !snapshot?.configured || !model.value || !client?.buddyPrivate;
    cancel.disabled = !pending;
    model.disabled = pending;
    status.textContent = pending
      ? m.pending
      : snapshot?.configured
        ? snapshot.models.length
          ? m.ready + snapshot.endpoint
          : m.noModels
        : m.missing;
    transcript.replaceChildren();
    for (const message of snapshot?.messages ?? []) {
      const item = document.createElement("div");
      const label = document.createElement("b");
      label.textContent = message.role === "user" ? m.user : m.assistant;
      const text = document.createElement("pre");
      text.textContent = message.text;
      item.append(label, text);
      transcript.append(item);
    }
  };
  const report = (failure: unknown): void => {
    error.textContent = failure instanceof Error ? failure.message : t().error;
  };
  const refresh = async (): Promise<void> => {
    const version = generation;
    if (!active || !client?.buddyPrivate) {
      return;
    }
    try {
      const value = await client.buddyPrivate({ action: "status", sessionId });
      if (version !== generation || !active) {
        return;
      }
      snapshot = value;
      error.textContent = "";
      render();
    } catch (failure) {
      if (version === generation && active) {
        snapshot = null;
        render();
        report(failure);
      }
    }
  };
  reload.addEventListener("click", () => void refresh());
  send.addEventListener("click", () => {
    if (!active || pending || !textarea.value.trim() || !client?.buddyPrivate) {
      return;
    }
    const version = generation;
    pending = true;
    error.textContent = "";
    render();
    void client
      .buddyPrivate({
        action: "send",
        sessionId,
        text: textarea.value,
        model: model.value as BuddyPrivateModel,
      })
      .then((value) => {
        if (version !== generation || !active) {
          return;
        }
        snapshot = value;
        textarea.value = "";
      })
      .catch((failure) => {
        if (version === generation && active) {
          report(failure);
        }
      })
      .finally(() => {
        if (version === generation && active) {
          pending = false;
          render();
        }
      });
  });
  cancel.addEventListener("click", () => {
    void client?.buddyPrivate?.({ action: "cancel", sessionId }).catch(report);
  });
  clear.addEventListener("click", () => {
    generation += 1;
    const oldId = sessionId;
    sessionId = crypto.randomUUID();
    pending = false;
    snapshot = null;
    textarea.value = "";
    render();
    void client?.buddyPrivate?.({ action: "reset", sessionId: oldId }).then(refresh).catch(report);
  });
  return {
    element,
    update(enabled: boolean, next: RendererModelClient | null): void {
      if (active === enabled && client === next) {
        return;
      }
      generation += 1;
      const previous = client;
      const oldId = sessionId;
      client = next;
      active = enabled;
      element.hidden = !enabled;
      snapshot = null;
      pending = false;
      textarea.value = "";
      error.textContent = "";
      sessionId = crypto.randomUUID();
      if (previous?.buddyPrivate) {
        void previous.buddyPrivate({ action: "reset", sessionId: oldId }).catch(() => {
          if (active) {
            error.textContent = t().error;
          }
        });
      }
      render();
      if (enabled) {
        if (!client?.buddyPrivate) {
          error.textContent = t().disconnected;
        }
        void refresh();
      }
    },
    dispose(): void {
      generation += 1;
      active = false;
      textarea.value = "";
      snapshot = null;
      transcript.replaceChildren();
      void client?.buddyPrivate?.({ action: "reset", sessionId }).catch(() => {
        /* Host 断开会清空内存会话。 */
      });
      element.remove();
    },
  };
}
