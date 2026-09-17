# Buddy Auto Router

本功能属于 `org-aio/codex-host` fork。通过源码根目录的 `npm ci`、`npm start` 启动；启动命令会重新打开桌面端。输入框上方的 Auto Router 是功能入口，仅对 Codex Harness 生效。

## 隐私优先

[离线隐私模式](buddy-private-chat.md) 优先于普通 Auto Router。开启后不走本文的夯规划、垃执行或命令旁路，只允许独立隐私输入区直连自部署 q3。关闭 Auto Router 不会关闭隐私保护；退出隐私模式会清空私密对话。

## 默认策略

1. 先做确定性意图识别：短语、完整命令和项目入口匹配不调用 AI。这一层是规则路由（rule-based routing）与命令分发（intent dispatch），不是训练过的 RouterLLM 分类器。
2. 符合旁路条件的明确命令直接执行。其余简单或常规任务由垃模型处理，按意图应用 Git、IO 或编码执行角色。
3. 复杂任务先启动独立的临时规划线程：夯模型只读调查，输出目标、步骤、验收条件和需要补充的问题。成功完成且任务包有效后，在原线程的下一次 `turn/start` 显式选择垃模型执行。

GPT、Claude 模型 ID（含供应商前缀）归为“夯”；所有其他系列归为“垃”。这是用户定义的分档。图像生成、音频、embedding、rerank 等明显非编码模型保留分档但不进入执行候选。

不把成功率当作能力分档依据。当前 fork 尚未接入 Sub2API 的健康统计辅助排序，也没有实时价格计算；名称中的 flash、mini 等只用于默认偏好。目标是减少高价模型执行流量，不能据此保证任意任务的绝对最低账单。

## 动态模型与切换

Host 读取 `CODEX_HOME` 下的 `config.toml`（默认 `~/.codex`），使用当前供应商的 `base_url`、请求头与认证设置请求 `/models`；典型地址为 `/v1/models`。`requires_openai_auth` 使用 Codex 已登录的 API key，不让无关的继承环境变量覆盖它。凭据只在 Host 使用，不返回浏览器。

有效候选必须同时存在于供应商实时列表与 App Server `model/list` 中。每轮需要推理时重新读取；纯工具旁路不访问模型目录。面板“刷新模型”用于手动查询，状态轮询只读本地快照。

模型偏好依次采用面板设置、现有 `model-router/policy.json` 的规划设置、默认分档排序；配置中的默认模型还可作为规划偏好。候选失效时只在同档中重新选择。缺少垃模型会报错；复杂任务缺少夯模型也会报错。不会静默把高价模型拿去执行。需要先将供应商目录同步给 Codex 时，使用 `npx -y codex-buddy sync`。

切换发生在回合开始前，不能在同一个正在生成的模型响应中途更换模型。复杂任务的顺序是“夯规划完成 → 垃开始执行”。用户显式开启 Codex Plan Mode 时，只使用夯进行规划，不自动执行。

## Git、IO 与模型旁路

Git 和 IO 是 Codex Harness 内的执行角色：Git 处理提交、推送、合并、冲突；IO 处理文件操作、日志、项目启动、构建和测试。它们使用实际选中的垃模型，不额外伪造一个外部 Harness 或子代理事件。

“开发 Git 智能体功能”等产品开发请求不会仅因包含 git 就当作一次 Git 操作。项目命令根据现有 Buddy 的入口检测，识别 package.json、Cargo、Gradle 等技术栈；多入口不确定时交给模型处理，不猜一个命令执行。

旁路使用原生 `thread/shellCommand`。仅在服务端已确认的本地 POSIX 环境、完整文件访问权限、无需审批、单条纯文本输入、未运行其他回合时启用；缺少权限证据、附件、Plan Mode 或不兼容参数均交回模型。不会为了旁路自动提高权限。

可尝试“当前目录”“查看当前目录文件”“查看 git 状态”；“跑起来”只有在命令入口唯一等规则满足时才旁路。提交、推送、合并等 Git 写操作由 Git 角色处理；不会仅凭关键词直接执行。命令参数逐个引用，任意 shell 表达式不会进入精确旁路。

旁路显示原生输出、进程退出码和错误。启动命令仍在运行时，不能据此宣称应用已经就绪。

## 可观测性与设置

展开输入框上方的 Auto Router，可以修改开关、角色、夯/垃模型偏好，查看：

- 规则难度分：旁路 0、简单 15、常规 45、复杂 85。它是规则结果的展示，不是模型自评分或概率。
- 路由依据、规划与执行阶段、规划模型、执行候选、执行任务包。
- “服务端已接受”：仅在 App Server 成功接受执行回合后填入。它不代表对供应商内部隐藏转发模型的证明。
- 无模型旁路、实际命令、原生退出码；规划阶段可点击取消。

设置保存在 `~/.codex/buddy-router.json`（遵从 `CODEX_HOME`），默认启用。关闭后走原生手动选模；正在规划的任务会取消。已经开始执行的回合需通过原生停止按钮取消。最新每任务状态只保留在 Host 内存中，最多 100 项，重启后不保留；原生任务记录仍由 Codex 管理。

规划只带入项目入口和最近最多 16 条项目消息的有界上下文，不传完整历史。执行阶段留在原任务中，保留原任务的权限和上下文。独立规划线程只读，不实施文件修改。执行失败会停止并保留错误，要求执行者遇到未定设计或重复失败时返回证据；当前没有自动重新规划和重放副作用的循环。

## 验证与维护

```bash
npm run build:typescript
npm run build:renderer
npm run typecheck
npm run lint
npx vitest run --config tests/vitest.config.js packages/host-runtime/test/buddy packages/buddy-engine/test
node tools/buddy/preview.mjs
```

最后一条启动独立 UI 验收夹具 `http://127.0.0.1:43871`，数据明确标记为模拟，不等于官方桌面集成验收。

`node tools/buddy/verify-live.mjs --planning` 会使用本机配置发起真实规划和执行请求并产生模型费用；任务仅在新建临时目录内只读验证，结束后删除目录。省略 `--planning` 只验证零模型的“当前目录”。可通过 `CODEXHOST_STOCK_CODEX_PATH` 指定原生可执行文件。

源码布局：`buddy-engine` 保留原 CLI 的最小 MIT 依赖闭包；`host-runtime/src/buddy` 实现分档、规划、原生请求与状态；`renderer-extension/src/buddy` 只负责浏览器控件；共享 Zod 契约位于 `shared-contracts/src/buddy-router.ts`。

更新源指向本 fork，避免安装上游发布包后丢失 Buddy 功能。当前分发方式是源码启动；未配置 fork 的 npm 发布，不要用上游 npm 包验证本功能。官方 Desktop 更新可能影响 renderer 绑定，需要按桌面升级诊断文档重新验证。
