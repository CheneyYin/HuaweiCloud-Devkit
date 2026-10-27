# AgentArts 上游诉求清单

日期: 2026-10-22。依据: agentarts-sdk 0.1.7 钉版源码 + 43 个 CLI fixture + 本仓对抗评审循环（引证见 `docs/agentarts-pr0-findings.md` 陷阱编号与 `docs/agentarts-scenario-plan.md`）。每项标注证据等级与解锁影响。devkit 侧已用 MCP 桥（`src/agentarts-memory.mjs`，工具 `huaweicloud_agentarts_memory_*`）补全数据面可达性——上游修复后 CLI 路径自动流经既有 wrapper 机制，桥降级为冗余纵深。

## Tier 1 — 解锁核心回路（记录 + 召回）

| #   | 诉求                                                                                   | 证据                                                                                                                         | 解锁影响                                                                          |
| --- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 1   | memory 数据面子命令族（12 个 MemoryClient 方法镜像: 会话/消息/记忆的 CRUD + 语义检索） | 【源码】client.py 12 方法 vs memory 组 8 个空间级子命令（fixture 全量）；SDK 自带 MCP server 暴露其中 4 个但吞异常、绕过治理 | CLI 路径自动获得 devkit 三层安全模型（分档/审批/凭证注入/脱敏）；桥成为纵深冗余   |
| 2   | 全族诚实退出码（memory + gateway + config；失败落穿 exit 0）                           | 【实测】陷阱 4/23: 凭证错误全栈回溯但 exit 0; `memory status -o json` 失败输出全 null 合法 JSON                              | 退出码可信后 wrapper 输出解析降级为二线防御；直用 CLI 的 agent 不再把失败读成成功 |
| 3   | api_key 找回命令（`create_api_key` 端点已存在未被 CLI 包装）                           | 【实测】key 只在 create --output json 打一次; 无 re-issue 命令; 丢 key = 删空间重建                                          | 长期记忆空间的密钥可恢复; devkit 0600 文件不再是唯一副本                          |
| 4   | `memory create` 默认输出一次性 api_key（table 分支永久丢失）                           | 【实测】陷阱 24/PR11: commands.py json 分支独占 key; create 失败残留孤儿 key                                                 | 用户不依赖 wrapper 的 canonicalize 补偿即可拿到 key                               |

## Tier 2 — 静默错误（wrapper plan 层不可检测，只能上游修）

| #   | 诉求                                                                                                                       | 证据                                                                                                                                  | 解锁影响                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 5   | `memory update` 四旗标（public/vpc/subnet）要么实现要么移除——现在是验证、广告、报成功后静默丢弃                            | 【源码】commands.py:302-316 传入 operations/space.py:217-231 的 `**kwargs`（自注 ignored）; CLI 打印 "Updates: Public access enabled" | 安全相关写操作不再静默 no-op（对抗评审两轮独立复现） |
| 6   | `memory status` 读 `enable_memory_extract`，序列化写 `memory_extract_enabled`——extract 状态永远 null，健康警告分支是死代码 | 【源码】space.py:48 vs commands.py:443,452,499                                                                                        | 空间诊断字段可用                                     |
| 7   | region help 文案修正（cn-north-4 → 实际默认 cn-southwest-2）+ `MemorySession` 硬编码忽略 env 链                            | 【实测+源码】陷阱 15 + 2026-10-22 补录                                                                                                | 照 help 传值的 agent 不再发错 region                 |
| 8   | `--strategies` 标必填并列合法值                                                                                            | 【实测】陷阱 24: 缺省 = 服务端 400 + 孤儿 API key                                                                                     | create 不再先建 key 后失败                           |

## Tier 3 — 加固

| #   | 诉求                                                                                                                                                                                                                                                 | 证据                                                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 9   | create/list 读模型一致（create/get 回 `memory_extract_enabled: true`，list 读回 `false` + null）                                                                                                                                                     | 【实测】陷阱 25 + 28（2026-10-27: get 侧与 create 一致——list 序列化是错误侧） |
| 10  | TTL 默认 168h 进 help（消息 7 天过期，记忆独立长存）                                                                                                                                                                                                 | 【源码】config.py:190                                                         |
| 10b | min_score 生效默认值显式化 + 分数量级文档化（文档 0.5 属 `MemorySearchRequest`，`MemorySearchFilter` 路径默认 None 且序列化丢弃——实测不设阈值返回 score 0.00001 条目，整空间按分排序；分数量级 ~0.01-0.06，与 hook 0.3 / 插件 MCP 0.7 常量完全脱节） | 【实测+源码】陷阱 29（config.py:122-132 vs 506-507）                          |
| 11  | 插件 /recall /remember 指向不存在的 HTTP server（`AGENTARTS_MEMORY_SERVER_URL` 全仓零处设置; 0.1.7 无任何 HTTP memory server）                                                                                                                       | 【实测】recall.md:15 curl 指令开箱即坏                                        |
| 12  | 插件 MCP server 不吞异常（`{"error": ..., "total": 0}` 形似空成功）+ 真实 actor 身份（硬编码 "opencode-user" 等假名）                                                                                                                                | 【源码】server.py:127-233                                                     |
| 13  | `install openclaw` 移除或实现（exit-0 no-op）; `install --yes` 凭证缺失时拒装而非装出坏配置                                                                                                                                                          | 【源码/实测】installer/cli.py:95-97; utils.py:1107-1112                       |
| 14  | 官方插件支持 workbuddy/atomcode/dsh 宿主（当前仅 5 平台）                                                                                                                                                                                            | 【源码】installer/cli.py:37                                                   |

## S0 待真机裁决（bridge 落地后新增）

- `memory get -o json` 首查是否回传 api_key（`_space_info_to_dict` 无条件含该键，服务端行为未知）——若回传，wrapper 的 readonly get 成为 key 找回路径。
- bridge 工具族真机 e2e（12 方法信封/分页/序列化实测）。【部分裁决 2026-10-27: 8 读 + 4 写全族已在真实 space 上使用（U2-U5 会话），信封/分页/检索行为实测——剩余: 显式 min_score 传 0.5 时的过滤行为是否符合文档】
- 检索阈值三分叉（0.3 hook / 0.7 插件 MCP / 0.5 SDK 默认）的召回行为差异。【部分裁决 2026-10-27: 桥路径（MemorySearchFilter）默认**无过滤**——min_score None 被序列化丢弃（陷阱 29），三分叉第四叉; 0.3/0.7 常量在实测分数量级（~0.01-0.06）上会滤空一切, 不可移植】
- `add_messages` 抽取管道延迟量级（多快可检索）。
