# Buddy Host 路由

`models.ts` 从当前 Codex 供应商动态获取模型、与 App Server 目录取交集，并按 GPT/Claude 为夯、其他为垃选择。`planner.ts` 管理独立只读规划线程、结构化任务包、取消及交互失败。`router.ts` 在回合开始前应用策略、复用 Buddy 精确命令旁路、保留原生事件和执行权限。

公共边界是 `BuddyRouter`；Host 注入原生请求、回复、向客户端发送、转发与诊断函数。生产入口默认启用，库调用者需显式传入 `buddyRouting: true`。`hasActiveWork` 参与 Host 的退出等待；关闭时取消规划并释放旁路状态。

状态只在内存保留最近 100 个任务。模型请求失败、规划失败、交互需求、超时、取消均停止当前启动，不重放用户任务。执行模型只有收到原生成功响应后才能记为已接受。

详见 [功能契约与验证](../../../../docs/product/buddy-auto-router.md)。测试位于 `../../test/buddy/router.test.ts`，修改协议后同时执行 Host 现有测试和显式真实验证脚本。
