# Buddy engine 维护约定

本模块是 Host 的内部 Node.js 依赖，不是新增 CLI 或浏览器包。公共入口为 `index.mjs` 与 `index.d.mts`，暴露配置读取、意图评分、项目入口和原生命令旁路生命周期。

- `vendor/` 来自 README 指定的 codex-buddy 固定提交；不要局部重写或格式化上游文件。升级时更新来源并保留 MIT 许可证。
- fork 专有语义放在非 vendor 文件；夯/垃选模和规划线程属于 `host-runtime/src/buddy`。
- 不返回或打印认证头、API key，不把 Node 依赖导入 renderer。
- 旁路必须保持原生响应、退出码、失败和取消语义，不能虚构工具成功。
- 修改公共 API 同步更新类型声明；在仓库根目录运行 `npm run build:typescript`、`npm run typecheck` 和 `npx vitest run --config tests/vitest.config.js packages/buddy-engine/test packages/host-runtime/test/buddy`。
- 分发使用 Host Bundle，新增运行时依赖需要通过 `packages/host-runtime/scripts/build-release.mjs` 的边界审计。
