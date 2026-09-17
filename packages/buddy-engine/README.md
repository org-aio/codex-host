# Buddy engine

从 org-aio/aio-plugin-cli-codex-buddy 的 d388432511e96e4648f54aa522332f90d0f1a86e（0.7.1，MIT）引入最小依赖闭包，保留原始来源与许可证。只复用供应商配置读取、确定性意图、项目入口发现、命令旁路与原生执行状态；不调用旧 CLI、不安装旧启动器或修改用户配置。

Host 的夯/垃策略与规划阶段位于 host-runtime/src/buddy，浏览器不能导入本包。原始 vendor 文件保留上游内容；更新时从固定版本重取并运行 Buddy 路由与旁路测试。
