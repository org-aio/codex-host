# Buddy 控件

`installBuddyControl` 从现有 renderer 绑定获取当前 Codex 任务、输入框锚点和 Host 客户端，在输入框前放置 Auto Router。仅通过共享浏览器安全契约调用 Host；不读取 Node、文件或供应商凭据。

提供双语、键盘可操作的开关、角色和两档模型设置，展示规则评分、阶段、任务包、原生接受的模型和旁路退出码。状态每 1.2 秒读取一次，只有手动刷新或真实路由访问模型目录。`dispose()` 释放轮询和 DOM。

通过 `node tools/buddy/preview.mjs` 验证真实组件的模拟场景；执行 `npm run build:renderer` 后由主 renderer 扩展安装。夹具不能替代完整桌面绑定验收。参见 [功能说明](../../../../docs/product/buddy-auto-router.md)。

`private-control.ts` 是独立隐私输入区，不读写原生 composer，不持久化草稿，不渲染会请求远端资源的 HTML/Markdown。启用隐私时原生输入框 hidden + inert；退出、连接切换及 dispose 清空私密 DOM。敏感内容只经 `buddyPrivate`，不得回退到 `turn/start` 或在线模型。
