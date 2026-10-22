# Issue #1014 任务拆解（task）

- [x] S1：`flushEvents` 发送前 `loadUserHash()` + batch 内 null `userHash` 回填（telemetry.mjs）
- [x] S2：`setup-cli.mjs` 两处 telemetry 目录硬编码改为 `devkitTelemetryDir()`（尊重 `HUAWEICLOUD_DEVKIT_HOME`）
- [x] S2 核对：user-hash 写入方仅 `cacheUserHash`，路径与 telemetry 一致；hooks 仅写 plugin 目录 hook-events
- [x] 测试：`flushEvents backfills userHash written after enqueue`（入队时无文件、flush 前写入、断言携带 hash）
- [x] 验证：`node --test test/telemetry.test.mjs` 18/18 通过；`npm test`、`npm run lint`、`npm run validate`、`npm run format:check`
- [x] 建 PR 并关联 `fixes #1014`
