# Issue #1014 方案设计（plan）

## 改动点

### S1 — `plugins/huaweicloud-core/src/telemetry/telemetry.mjs`

`flushEvents()` 在 `splice` 出 batch 前调用 `loadUserHash()` 重新解析磁盘上的 user-hash 文件；若解析到 hash，则对 batch 内 `userHash == null` 的事件回填。入队仍不依赖身份（保持匿名可用），回填发生在发送前最后一刻，最大化覆盖身份解析竞态窗口。

### S2 — `plugins/huaweicloud-core/src/setup-cli.mjs`

- 新增 `devkitTelemetryDir()`：`HUAWEICLOUD_DEVKIT_HOME || homedir()` + `.huaweicloud-devkit/telemetry`，与 telemetry.mjs 的 `GLOBAL_TELEMETRY_DIR` 根目录一致。
- 替换 WorkBuddy hooks 部署与 codebuddy 卸载清理中两处 `join(homedir(), '.huaweicloud-devkit', 'telemetry')` 硬编码。
- 核对结论：user-hash 唯一写入方是 telemetry.mjs 的 `cacheUserHash`（调用方 `hdkitservice-api.mjs`、`tools.mjs`），路径天然一致；各 agent hooks 只写 plugin 目录下的 hook-events.jsonl，不涉及 user-hash。

### 测试 — `test/telemetry.test.mjs`

新增用例 `flushEvents backfills userHash written after enqueue`：本地 HTTP server 接收上报，隔离 `HUAWEICLOUD_DEVKIT_HOME`；流程 = init → 初始 flush 排空 → 入队 5 个事件（无 user-hash 文件）→ 写入 user-hash 文件 → 补足 BATCH_SIZE 触发 flush → 断言 batch 内全部事件（含先入队的 5 个）`userHash === 写入值`。测试中临时清除代理环境变量避免 127.0.0.1 请求被代理劫持。

## 风险

- `loadUserHash` 仅在文件存在时覆盖内存值，不会把已解析身份清空；`clearUserHash` 显式登出语义不变。
- flush 增加 1 次文件存在性检查，开销可忽略。
