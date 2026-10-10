# open-mcp 授权委托重设计

- 状态: 已决策, 待实施
- 决策日期: 2026-10-10
- 评审基础: 三模型对抗评审 (interrogate)。两处共识级安全发现由维护者决策接受, 记录于第 8 节。

## 1. 决策记录

| # | 决策 | 状态 |
| --- | --- | --- |
| D1 | gateway 面四个路由工具 (execute_api, manage_policy, query_data, transform_data) 的授权全部委托网关 policy engine | 已决 |
| D2 | manage_policy 放行委托。不退回 operator 手势, 不保留 token | 已决, 否决主审 1a 建议 |
| D3 | data tools 放行委托。不加目标路径白名单, 不保留 token | 已决, 否决主审白名单建议 |
| D4 | devkit/native 模式二分删除。HUAWEICLOUD_OPENMCP_APPROVAL 退役 | 已决 |
| D5 | 三个 devkit 地板保留: 秘密操作拒绝、受保护树、永久 scope 不可由 agent 购买 | 已决 |
| D6 | src/lib/approval-tokens.ts 的 token 机制保持为 CLI 面机制, 不动 | 已决 |

D2 与 D3 的后果是评审共识级安全发现。处置是接受并记录 (第 8 节), 不以补丁回填。

## 2. 终态

classify() 的裁决词表坍缩为 `{deny, forward}`。委托后 passthrough 与 delegate 行为相同, 三词表无承载。

| 调用 | devkit 侧 | 授权权威 |
| --- | --- | --- |
| 六个只读发现工具 (GATEWAY_TOOL_VOCABULARY.readonly) | forward | 无需授权 |
| execute_api | 秘密地板, 其余 forward | gateway policy engine |
| manage_policy | 形状地板 (第 4 节), 其余 forward | engine 自身。网关不自守此工具, 见 AR1 |
| query_data, transform_data | 受保护树与凭证地板, 其余 forward | engine 无文件路径词汇, 地板即全部门, 见 AR2 |
| 未知工具名 | deny, 按静态 GATEWAY_TOOL_VOCABULARY 判定 | fail-closed |

原开放问题 (a) 过山车语义在纯委托下消解。地板拒绝发生在转发前, 引擎拒绝发生在执行前, 两者都是执行前拒绝, 不存在事后状态翻转。

## 3. 删除清单

锚点来自 2026-10-10 会话实测, 行号会随实施漂移, 以现场代码为准。

`src/packs/huaweicloud-open-mcp/approval.ts`:

- resolveApprovalMode 的模式解析逻辑与 ApprovalMode 类型 (~34-41)。保留一个 release 的退役报错壳 (第 10 节)
- classify() 的 token 裁决、mode 分支、drift gate (~84-89)
- matchingDenyRule, operatorPolicyPath, DenialMatch (~226-303)

`src/packs/huaweicloud-open-mcp/tools.ts`:

- 仪式段: mint 与脱敏 echo (~222-232), devkit 模式 pre-spend 守卫 (~239-283), consume 与 args 验证 (~285-299)
- boundArgs 规范化 (~201-220), 由 F1 地板替代
- once-grant 桥全套: bridgeLocks, bridgeExecuteApi, forwardWithOnceGrant (~372-433)
- gatewayCallSchema 的 approvalToken 与 approvedByUser 字段 (~86)
- GATEWAY_CALL_APPROVAL_NOTE (~154-155) 与工具描述 (~488) 重写

`src/packs/huaweicloud-open-mcp/sidecar.ts`:

- surface cache 集群: gatewaySurface, fetchGatewaySurface, refreshSurfaceOnUnknownTool, `_gatewaySurface` 钩子 (~190-209, ~486-493)。drift gate 死则全链死
- elicitation 注释理由更新 (~241-245), 不再指向 devkit approval face

其他:

- `src/tools.ts` 目录描述副本 (~295)
- `src/lib/policy-grammar.ts` 整文件。零生产消费者, 夹具自带文法镜像, lockstep 测试同删
- `src/lib/approval-tokens.ts` (~17-26) 与 `src/lib/pack-state.ts` (~12-15) 的面中立注释改为 CLI 面表述
- `scripts/eval-generic-face.mjs` (~79-83) 的 token 分支

保留:

- GATEWAY_TOOL_VOCABULARY。unknown-deny 的静态词表, 加 gateway_list_tools 投影
- localFileTargetViolation 及其依赖 (pack-state.ts, safety-policy.ts)
- EPHEMERAL_SCOPES。F1 地板的词汇
- src/lib/approval-tokens.ts 全部

## 4. 地板规格

既有地板, 保留:

- execute_api。classifyTextCommand 判 risk 为 secret 则 deny。
- data tools。localFileTargetViolation 命中则 deny, 覆盖受保护树与凭证路径模式。
- manage_policy。action 限 list, add, remove。add 的 scope 限 once, session, temporary。remove 不带 scope。

新增形状地板。D2 与 D3 的直接后果, 不是新授权层:

- **F1 拼写严格**。scope 或 action 的原值不等于 `trim().toLowerCase()` 的结果则 deny。理由: boundArgs 规范化随仪式删除, round-5 实测 verbatim `' ONCE '` 授权在网关侧永不燃烧, 门必须自守拼写。
- **F2 ttl 拒绝**。manage_policy add 携带 ttl_seconds 则 deny。理由: remove 的拒绝信息暴露 add 可能存在独立时长旋钮, temporary 配 ttl 可掏空 ephemeral 线。探针 (第 5 节) 证明 ttl_seconds 受 scope 寿命约束前, 默认拒绝。

## 5. 探针协议 (实施前置)

对象是真实网关, pip 包 huaweicloud-open-mcp, 不是测试夹具。夹具的 deny-by-default 只是被钉的假设, 探针验证真实网关是否同判。

1. execute_api 空 policy 文件下的默认裁决。
2. query_data 与 transform_data 空 policy 下的行为。
3. manage_policy add 的参数签名: scope 词汇全集, ttl_seconds 语义。

判读:

- 默认 deny。委托开箱 fail-closed, 按本设计继续。
- 默认 allow。ensurePackState 预置的初始 policy 文件写入一条 `*=deny` 兜底, 或终止设计。二选一由实施者带证据回报。

结果连同日期、网关版本、裁决写入 docs/safety-model.md, 作为夹具 deny-by-default 站立的钉子。

## 6. 教学面清扫

以下面在教学或描述已删除的仪式, 全部更新:

- `src/packs/huaweicloud-open-mcp/skills/huawei-openapi/SKILL.md` (~27-37) 与生成副本。改源后执行 `npm run skills:sync`
- tools.ts 工具描述 (~488) 与 src/tools.ts 目录副本 (~295)
- pack.ts pack 描述 (~16)
- tools.ts 头注与提示 (~31-35, ~141-147, ~154-155)
- scripts/eval-generic-face.mjs (~79-83)
- approval-tokens.ts 与 pack-state.ts 的过期注释
- sidecar.ts elicitation 注释理由

注意 gatewayCallSchema 是 z.looseObject。过期的 approvalToken 字段会被静默接受并忽略, agent 以为自己在同意流里, 实际调用直接执行。所以加 schema 形状断言钉住字段缺席 (第 7 节)。

## 7. 验证矩阵

删除的测试 (`test/open-mcp-pack.test.ts`):

- token 回路 (~864-914), replay mismatch, same-line 与 redaction-mangled 与 semantic-key 与 file-layer conflict, listing-failure, canonical binding
- operator-deny refusal (~1256-1285)
- drift degrade
- `test/structure.test.ts` 语法 lockstep (~260-275), 随 lib 删除

改写:

- native-mode delegation 测试 (~1339-1351) 作为模板。每个 forward 工具断言首调用委托。
- trimmed posture (~1353-1365) 反转。新断言: DEVKIT_PACKS=core,huaweicloud-open-mcp 下写路径经委托存在, operator policy 文件是控制面。这是显式决定的姿态反转, 不是实现中途的发现。

新增不变量:

- 地板矩阵端到端。秘密、受保护树、凭证路径、永久 add、F1 拼写、F2 ttl、remove 带 scope、unknown 工具名, 每条一个 deny 断言。
- unknown-deny 按静态词表判定。
- 引擎拒绝以 `{ok:false}` 信封返回且 reason 保留。
- schema 形状断言: approvalToken 与 approvedByUser 缺席。
- structure 守卫: skill 不再出现 approvalToken 与 approvedByUser, 且教委托契约。

快照注意: huaweicloud_gateway_call 在 scripts/registry-snapshot-diff.mjs 的 EXEMPT_TOOLS 里, 快照不含 gateway 条目, 无再生步骤。

## 8. 已接受风险 (记录进 docs/safety-model.md)

- **AR1** manage_policy 委托。agent 可用 overlay add 遮蔽 operator 文件级 deny, 可用跨层 remove 删 operator 规则并回写 policy 文件。三模型共识发现, D2 接受。
- **AR2** data tools 委托。受保护树与凭证模式之外的本机路径, 读与写均无门。`read_csv('/etc/passwd')` 与 out.path 写 `~/.bashrc` 均可直达。三模型共识发现, D3 接受。
- **AR3** session 与 temporary 常驻授权, agent 免同意可购。B5 发现, D2 的从属后果。
- **AR4** matchingDenyRule 删除后, 坏 policy 文件静默惰性。网关保留最后有效版本, operator 打错字的 deny 行失效无信号。C4 发现。可选缓解: doctor 加一次解析检查。

## 9. 实施顺序

0. 探针 (第 5 节), 结果钉入文档。
1. classify() 重写为地板表, 词表坍缩为 `{deny, forward}`。检查: 地板矩阵单测。
2. 桥、pre-spend、matchingDenyRule 删除。检查: typecheck。
3. env 退役报错。检查: 单测。
4. schema 字段删除与形状断言。检查: 快照 diff 输出不变 (gateway 在豁免表)。
5. surface cache 集群删除。检查: grep 无孤儿引用。
6. policy-grammar 删除与 lockstep 测试删除。检查: 全测试。
7. 测试改写与新增 (第 7 节)。检查: 全测试。
8. 教学面清扫 (第 6 节)。检查: structure 的 skill 守卫。
9. 文档: safety-model 接受风险与探针记录, AGENTS.md 的 fail-closed 表述与工具计数 51/41, enable.ts 注释, plan-run-approval-contract.md, CHANGELOG.md。
10. 全门: `npm run lint`, `npm test`, `npm run validate`, `npm run format`, `npm run pack:verify`。

## 10. 迁移

HUAWEICLOUD_OPENMCP_APPROVAL 设值的 operator 升级后不得静默无操作。resolveApprovalMode 的原位置改为退役报错, 指向 operator policy 文件路径与 docs/safety-model.md, 至少保留一个 release。这与仓库先例一致: DEVKIT_PACKS 对未知 id 启动失败, 原resolveApprovalMode 对坏值抛错。
