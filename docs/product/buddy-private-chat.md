# 离线隐私对话

隐私模式复用 Codex 当前供应商的网关地址和凭据，从 `/v1/models` 动态获取 `q3-4b`、`q3-14b`。用户已将这两个 ID 配置为自部署模型。即使任务复杂，也不经过 GPT/Claude 规划、在线分类、标题生成、摘要、压缩或工具执行。

## 使用

1. 从本 fork 启动桌面端，展开输入框上方的 Auto Router。
2. 启用“离线隐私模式”。普通输入框会隐藏并禁用，Host 同时阻止普通原生和外部 Harness 任务发送。
3. 在“离线隐私对话”的独立输入区输入纯文本，从实时目录中选择 q3，点击“发送至离线模型”。界面显示当前网关地址，“刷新模型”重新获取目录。只出现一个 q3 时只显示该项；两个都缺失时禁止发送。
4. 退出隐私模式会清空私密历史与草稿，普通对话不会继承它们。若无需退出，可使用“清空隐私对话”。

**不能将尚未启用隐私模式的普通对话框视为隐私入口。** `【隐私】`、`/private`、`隐私：` 等明确前缀及私钥标记会在 Host 本地拦截，但规则无法识别所有敏感信息。这不是依赖 AI 判断的自动 DLP；敏感内容必须使用独立隐私输入区。仅更新源码或安装普通 `codex-buddy` CLI 不会改造已经运行的官方客户端。

## 复用网关配置

无需额外配置文件，旧的 `buddy-private.json` 不再读取。使用 `CODEX_HOME/config.toml` 中当前 `model_provider` 的配置，复用 Buddy 的 `readConnection` 解析 `base_url`、认证头、查询参数、`env_key`、认证命令和 `auth.json`。`requires_openai_auth` 优先使用 Codex 已登录的 API key，避免终端里其他供应商的 `OPENAI_API_KEY` 覆盖。凭据不返回界面、不写入诊断日志或请求正文。

网关应提供 `GET /v1/models` 和非流式纯文本的 `POST /v1/chat/completions`。每次发送前重新验证所选 q3 存在；缺失或不可用时停止，不改选在线模型。只有完整匹配的两个 q3 ID 可用，类似 `q3-4b-online` 的名称不会自动获得隐私资格。

这里信任用户在网关中的 q3 自部署映射。客户端保证自己不选择在线模型；网关服务端也须保持这些映射没有在线回退。模型名称本身不是服务端执行位置的证明。网关地址、查询参数或凭据改变时，需要清空会话才能继续，已有历史不会自动转移。

开关仍是 `buddy-router.json` 的 `privateMode`，与 Auto Router 的 `enabled` 独立。可设置 `"privateMode": true` 默认进入隐私模式。启动配置、功能目录、只读列表查询不应触发“普通发送被阻止”；无需关闭隐私保护来加载界面。

## 发送边界

- 独立 DOM 输入与 `codexhost/buddy/private` RPC；敏感文本不会写入原生 composer、`turn/start` 或 `thread/steer`。
- Host 隐私开关先于原生请求、外部 Harness 和夯规划执行。打开时也阻止后台新模型任务与普通问答回复。保留启动、只读元数据查询及无提示、历史注入的空任务预热和原生任务恢复，它们不携带隐私输入区正文；这不是完全断网模式。已经在开启前提交的在线内容无法撤回。
- 私密内容只存于专用内存会话，不写入本功能的日志、原生任务历史、mapping store 或持久化文件。最多 16 个会话、每次输入 32,000 字符、上下文 96,000 字符；超限直接报错，不调用在线压缩。
- 网关 HTTP(S) 请求不继承环境代理，不跟随 3xx 重定向。超时、断网、认证错误、响应错误、模型不匹配均停止，不重试到其他端点。错误信息不回显请求正文或服务端错误正文。
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

测试使用混合网关目录、虚构 canary 文本和在线哨兵服务，后者必须收到零请求。覆盖无额外配置、网关凭据、q3 白名单、启动查询放行、普通发送入口阻断、环境代理、重定向、失败、模型不匹配、取消与清空。浏览器夹具标明模拟数据；真实网关验证也只使用虚构文本。

实现入口：`host-runtime/src/buddy/private-chat.ts` 管理内存和协议，`private-transport.ts` 管理专用 HTTP；`renderer-extension/src/buddy/private-control.ts` 管理独立输入区；共享契约为 `shared-contracts/src/buddy-private.ts`。
