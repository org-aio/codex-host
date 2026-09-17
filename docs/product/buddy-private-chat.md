# 离线隐私对话

隐私模式是独立发送通道，不是给普通在线会话换一个模型名。它只允许用户自部署的 `q3-4b`、`q3-14b`。即使任务复杂，也不经过 GPT/Claude 规划、在线分类、标题生成、摘要、压缩或工具执行。

## 使用

1. 从本 fork 启动桌面端，展开输入框上方的 Auto Router。
2. 启用“离线隐私模式”。普通输入框会隐藏并禁用，Host 同时阻止普通原生和外部 Harness 任务发送。
3. 确认界面显示的“离线专用端点”是自己的服务，再在“离线隐私对话”的独立输入区输入纯文本，选择 `q3-4b` 或 `q3-14b`，点击“发送至离线模型”。
4. 退出隐私模式会清空私密历史与草稿，普通对话不会继承它们。若无需退出，可使用“清空隐私对话”。

**不能将尚未启用隐私模式的普通对话框视为隐私入口。** `【隐私】`、`/private`、`隐私：` 等明确前缀及私钥标记会在 Host 本地拦截，但规则无法识别所有敏感信息。这不是依赖 AI 判断的自动 DLP；敏感内容必须使用独立隐私输入区。仅更新源码或安装普通 `codex-buddy` CLI 不会改造已经运行的官方客户端。

## 专用端点配置

在 `CODEX_HOME/buddy-private.json`（默认 `~/.codex/buddy-private.json`）写入配置。以下是格式示例，地址需替换成已验证的真实离线服务：

```json
{
  "baseUrl": "http://127.0.0.1:1234/v1",
  "offlineOnly": true,
  "apiKeyFile": "/absolute/path/to/offline-api-key"
}
```

`offlineOnly: true` 是管理员对部署的确认，不是程序从模型名称推断的事实。**不要未经验证就对混合网关设置此项。** 需要核对两个模型只连接自部署后端，服务器没有在线失败回退、视觉转发或其他在线调用。模型接口返回 `q3-4b` 不能独立证明实际运行位置。

服务应提供 `GET /v1/models` 和 `POST /v1/chat/completions`，支持非流式纯文本。每次发送前从这个专用端点检查所选 q3 是否存在；不存在时不发送对话。API 根路径必须写完整。

凭据可使用 `apiKeyFile` 或 `apiKeyEnv`（环境变量名），二选一；无认证的本机端点可都省略。不会借用 Codex 的 `auth.json`、普通 `OPENAI_API_KEY` 或普通供应商请求头。配置中不允许 URL 用户名、密码、查询参数和片段；建议文件权限为 `0600`。改变端点或凭据后，需要清空会话才能继续，已有历史不会自动转移。

开关位于原 `buddy-router.json` 的 `privateMode` 字段，与 Auto Router 的 `enabled` 独立。原有普通路由配置兼容；要默认进入隐私模式可设置 `"privateMode": true`。离线端点未配置时，模式仍可开启并阻断普通发送，但隐私输入区禁止发送。

## 发送边界

- 独立 DOM 输入与 `codexhost/buddy/private` RPC；敏感文本不会写入原生 composer、`turn/start` 或 `thread/steer`。
- Host 隐私开关先于原生请求、外部 Harness 和夯规划执行。打开时也阻止后台新模型任务与普通问答回复。为使界面可初始化，保留空任务预热、目录和只读元数据查询，它们不携带隐私输入区正文；这不是完全断网模式。已经在开启前提交的在线内容无法撤回。
- 私密内容只存于专用内存会话，不写入本功能的日志、原生任务历史、mapping store 或持久化文件。最多 16 个会话、每次输入 32,000 字符、上下文 96,000 字符；超限直接报错，不调用在线压缩。
- 专用 HTTP(S) 直连不继承环境代理，不跟随 3xx 重定向。超时、断网、认证错误、响应错误、模型不匹配均停止，不重试到其他端点。错误信息不回显请求正文或服务端错误正文。
- 不提供工具、附件、上传、语音或远程图片入口。模型返回的内容只显示为文本，不执行工具或加载 Markdown 里的图片/链接。
- 取消、清空、关闭 Host 会取消正在执行的请求。未成功的请求不加入会话历史；取消不能撤回已经到达自部署端点的内容。

保护范围是本 fork 的模型发送链路。离线后端是否真正独立运行由部署负责；操作系统输入法/剪贴板同步、其他应用、浏览器扩展、屏幕录制，以及手动把文本复制到在线任务不受此功能控制。本功能不是操作系统级数据隔离或物理断网沙箱。

## 验证

```bash
npm run build:typescript
npm run typecheck
npm run lint
npx vitest run --config tests/vitest.config.js packages/host-runtime/test/buddy/private-chat.test.ts packages/host-runtime/test/app-server-host.test.ts
node tools/buddy/preview.mjs
```

测试使用虚构 canary 文本和两个本地服务：离线服务接收 q3 请求，在线服务必须收到零请求。覆盖普通发送入口阻断、原生/外部任务、模型白名单、专用凭据、环境代理、重定向、服务失败、模型不匹配、取消与清空。浏览器夹具清楚标明模拟数据，不代表真实自部署端点已通过验收。

实现入口：`host-runtime/src/buddy/private-chat.ts` 管理内存和协议，`private-transport.ts` 管理专用 HTTP；`renderer-extension/src/buddy/private-control.ts` 管理独立输入区；共享契约为 `shared-contracts/src/buddy-private.ts`。
