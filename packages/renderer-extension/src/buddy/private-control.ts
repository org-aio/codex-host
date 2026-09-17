import type { BuddyPrivateModel, BuddyPrivateSnapshot } from "@codexhost/shared-contracts";
import type { RendererModelClient } from "../renderer-model-client.js";

const messages = {
  "zh-CN": {
    title: "离线隐私对话",
    note: "仅直连你确认的自部署端点；不使用在线规划、工具、标题或摘要。对话仅在内存保留，退出隐私模式会清空。请只在此输入区粘贴敏感文本。",
    placeholder: "敏感内容仅输入此处…（纯文本）",
    send: "发送至离线模型",
    cancel: "取消",
    clear: "清空隐私对话",
    missing: "尚未配置专用离线端点，禁止发送。请配置 CODEX_HOME/buddy-private.json。",
    disconnected: "隐私通道未连接；不会改用普通发送。",
    pending: "离线模型正在回复…",
    ready: "离线专用端点：",
    model: "离线模型",
    user: "你",
    assistant: "离线回复",
    error: "隐私请求失败；没有回退在线。",
  },
  en: {
    title: "Offline private chat",
    note: "Connects only to your confirmed self-hosted endpoint. No online planning, tools, titles or summaries. History stays in memory and is cleared when leaving private mode. Paste sensitive text only here.",
    placeholder: "Sensitive text goes only here… (text only)",
    send: "Send offline",
    cancel: "Cancel",
    clear: "Clear private chat",
    missing:
      "No dedicated offline endpoint configured. Sending is blocked. Configure CODEX_HOME/buddy-private.json.",
    disconnected: "Private channel disconnected; normal sending is never used.",
    pending: "Offline model is replying…",
    ready: "Dedicated offline endpoint: ",
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
  for (const id of ["q3-4b", "q3-14b"]) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = id;
    model.append(option);
  }
  const actions = document.createElement("div");
  actions.className = "buddy-settings";
  const send = document.createElement("button");
  const cancel = document.createElement("button");
  const clear = document.createElement("button");
  for (const button of [send, cancel, clear]) {
    button.type = "button";
  }
  actions.append(model, send, cancel, clear);
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
    send.textContent = m.send;
    cancel.textContent = m.cancel;
    clear.textContent = m.clear;
    send.disabled = pending || !snapshot?.configured || !client?.buddyPrivate;
    cancel.disabled = !pending;
    model.disabled = pending;
    status.textContent = pending
      ? m.pending
      : snapshot?.configured
        ? m.ready + snapshot.endpoint
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
      render();
    } catch (failure) {
      if (version === generation && active) {
        report(failure);
      }
    }
  };
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
