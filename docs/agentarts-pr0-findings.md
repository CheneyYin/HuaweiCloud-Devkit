# AgentArts PR0 实测裁决记录

日期: 2026-10-19。环境: Python 3.12.3, agentarts-sdk 0.1.7 (pip, 华为云镜像), aarch64 Linux。
所有结论均为实测，非文档推断。fixture 位于 `test/fixtures/agentarts/help-tree/`。
后续 PR 以本文为单一事实源；与本文件冲突的早期规划段落以本文件为准。

## 裁决汇总（映射计划 v3 决策号）

| 决策 | 裁决 | 依据 |
| --- | --- | --- |
| D10 config 档位 | approved（终裁，不降级） | `config set` 写项目本地 yaml；`config set-env` 官方 help 示例即持久化 `HUAWEICLOUD_SDK_AK`，降级标准"无凭证持久化"不满足 |
| D11 非交互旗标 | `destroy --yes/-y`、`memory install --yes` 存在；`init` 必须传 `-r` 跳过区域交互提示 | help 树 + init 实测（无 -r 时提示并在 EOF 中止） |
| D11 退出码陷阱 | wrapper 不得信任退出码，必须解析输出 | 凭证缺失时 `memory list` 报错但 exit code = 0（实测） |
| D11 超时基线 | `invoke` 默认 900s；approved 档命令注册表逐命令配置 | help 树 |
| D17 版本钉版 | `agentarts --version` 存在，输出 `agentarts version: 0.1.7`。钉 0.1.7，doctor 软警告比对，skill 教 `pip install agentarts-sdk==0.1.7` | 实测 |
| 凭证 env 契约 | `HUAWEICLOUD_SDK_AK/SK` 生效。认证链: metadata → env AK/SK → OIDC。E2E 账号实测通过（memory list 0 spaces、gateway list 0，均为控制面 AK/SK，无需数据面 key） | 实测 |
| 模型凭证风险 | 消除。basic 模板 agent.py 明示 "None required for basic template"，回显式 handler | init 实测产物 |
| 别名方向修正 | `launch` 是主命令、`deploy` 是别名（与 README 相反）。`config` 主、`configure` 别名（与 README 一致）。registry 以 `launch`/`config` 为键 | help 树 |

## 权威命令面（fixture 为准，README 有出入）

顶层: `init` `config` `dev` `launch`(alias deploy) `invoke` `runtime` `destroy` `gateway` `memory`；全局旗标 `--version/-v` `--verbose` `--install-completion` `--show-completion` `--help`。

- `config`(8): `list` `set-default` `get` `set` `remove` `set-env` `remove-env` `list-env`
- `memory`(8): `create` `get` `list` `update` `delete` `status` `install` `uninstall`
- `gateway`(10): `create` `update` `delete` `get` `list` `create-target` `update-target` `delete-target` `get-target` `list-targets`（扁平命名，README 的 `create-gateway` 形式不存在）
- `runtime`(6): `invoke` `exec-command` `upload-files` `download-files` `start-session` `stop-session`

## 分类表修正（fixture 驱动）

- registry 键: `launch`(含 deploy 别名)、`config`(含 configure 别名)。
- `config` 族全部 approved（D10 终裁）。
- `memory install` 目标平台: hermes, claude, codex, opencode, openclaw（无 workbuddy/atomcode/dsh）；含 `--global` 与 `--yes`。
- `launch -m local|cloud`（默认 cloud）。local 模式为本地 Docker 构建+运行，档位仍 approved（构建镜像+拉起容器执行项目代码，fail-safe 不放行）。

## 实测陷阱清单（写入 references 的素材）

1. **首跑写真实 HOME 三处**: `~/.bashrc`（追加 tab 补全 source 行）、`~/.bash_completions/agentarts.sh`、`~/.agentarts/.completion_shown`。doctor 与 skill 必须警示；E2E 用 HOME 覆盖隔离。
2. **写 `~/.huaweicloud/application_id`**（空文件）。侵入 devkit 凭证命名空间；`credentialFilePatterns` 的 `\.huaweicloud` 模式会命中该目录下的读取——wrapper/hook 层需注意误伤判定。
3. **`config set-env` 在 0.1.7 崩溃**: `TypeError: 'NoneType' object is not iterable`（空 `environment_variables` 时）。golden path 不受影响（basic 模板零 env 需求）；memory 版发布时复查。SDK 侧 bug。
4. **失败仍 exit 0**: 凭证错误时 `memory list` 完整栈回溯但退出码 0。wrapper 成功判定必须解析输出。
5. **`init` 交互**: 无 `-r` 时提示 Region 并在 EOF 中止。E2E/工作流必须传全 `-n -t -r`。
6. **`invoke -bt/--bearer-token` 存在**: wrapper 按 D13 拒绝。
7. **yaml 默认值陷阱**: `file_transfer_config.enabled: false`、`url_match_type: ACCURATE_MATCH`（自定义路径需 PREFIX_MATCH）均须部署前改，部署后不可改（SDK 文档）。
8. **SWR org 自动生成**: init 生成本地名（如 `agentarts-cnso2-9qox3klw-org`），`organization_auto_create: true`。
9. **`dev --env KEY=VALUE`** 可重复传参，优先于 yaml。
10. **认证链含 metadata 探测**: 本机先发 metadata 请求（404）再走 env。wrapper 输出的 404 warning 是噪音，不是错误。

## 真实 yaml 形状

`agentarts init -n <name> -t basic -r cn-southwest-2` 产物 `.agentarts_config.yaml`（75 行）已随 scratch 保留；关键字段: `default_agent`、`agents.<name>.base`、`swr_config`、`runtime.invoke_config{protocol,port,file_transfer_config,url_match_type}`、`network_config{PUBLIC/vpc_config}`、`identity_configuration{authorizer_type IAM, custom_jwt, key_auth.api_keys}`、`observability`、`artifact_source`、`storage_config{sfs_turbo,session_storage}`、`environment_variables`、`tags`。`platform: linux/arm64` 按宿主架构生成（aarch64 实测）。

## E2E 凭证交付

`.env`（变量名 `AK`/`SK`，harness 需映射为 `HUAWEICLOUD_SDK_AK/SK`）已迁移至 `~/.config/agentarts-e2e/creds`（0600，工作树外，防 dotenv 自动加载）。S0 落地时该文件增补 `E2E_FORBIDDEN_ACCOUNT_ID`（用户提供日常账号 ID，harness 断言不等，fail-closed）。

## 遗留到 S0（账号侧实测项）

- `launch`/`destroy` 的真实交互提示行为（destroy 有 `--yes`，预期无交互）。
- deploy → invoke → destroy 全链路与计时。
- 审批计数基线核验（config/deploy/invoke/destroy = 4）。
