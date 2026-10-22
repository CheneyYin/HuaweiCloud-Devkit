# Issue #1014 需求文档（spec）：遥测 user_hash 遗漏修复

## 背景

`telemetry_event` 约 49%（59653/122354）记录 `user_hash` 为 null。根因：`telemetry.mjs` 的 `userHash` 仅在 `initTelemetry` 时读取一次，`buildEvent` 在入队时固化 `userHash`；登录/身份解析（`cacheUserHash` 写 `~/.huaweicloud-devkit/telemetry/user-hash`）之前入队的事件永久携带 null。

## 目标（S1+S2，S3 需产品确认不在本次范围）

1. **S1 核心修复**：`flushEvents` 发送前重新 `loadUserHash()`，对 batch 内 `userHash` 为 null 的事件回填。
2. **S2 一致性**：核对所有 user-hash 相关写入方与 telemetry 使用相同的 `HUAWEICLOUD_DEVKIT_HOME || homedir()` 根目录。
3. **测试**：单测覆盖「入队时无 user-hash 文件、flush 前写入文件，断言上报事件携带 hash」。

## 验收

- 修复后 `user_hash` null 占比显著降低（仅剩真正匿名会话）。
- `npm test` / `npm run lint` / `npm run validate` 全部通过。
