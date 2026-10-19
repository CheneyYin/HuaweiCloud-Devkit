# AgentArts PR0 实测裁决记录

日期: 2026-10-19（第三轮 interrogate 修订版）。环境: Python 3.12.3, agentarts-sdk 0.1.7 (pip, 华为云镜像), aarch64 Linux, typer 0.27.3 / rich 15.0.0。
fixture 捕获环境: `COLUMNS=80 NO_COLOR=1` 非 TTY 重定向，共 43 个文件（`_root`、`_version` + 9 个一级 + 32 个二级 help），位于 `test/fixtures/agentarts/help-tree/`。
标注纪律: 【实测】= 本机运行观测；【源码】= 钉版 venv 内源码验证；【文档】= SDK 文档转述（不作裁决依据）；【预测】= 待 S0 裁决。
后续 PR 以本文为单一事实源；与本文件冲突的早期规划段落以本文件为准。

## 裁决汇总（映射计划 v3 决策号）

| 决策            | 裁决                                                                                                                                                                                                                                                                                                                 | 依据                                                                                                                                                                                                               |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D10 config 档位 | approved（终裁，不降级）                                                                                                                                                                                                                                                                                             | 【实测】`config set` 写 cwd 本地 yaml；【源码】set-env 持久化路径存在且官方 help 示例即 `config set-env HUAWEICLOUD_SDK_AK your-ak`（0.1.7 该路径在 fresh basic 项目上崩溃，见陷阱 3，故为源码证实而非端到端实测） |
| D11 非交互旗标  | `destroy --yes/-y`、`memory install --yes`、`memory delete --force/-f`【实测】；`init` 必须传 `-r`【实测】；`gateway delete/delete-target` **无任何跳过旗标**【源码 gateway.py:159,358 typer.confirm】→ 按 D11 规则 wrapper 硬停指向用户终端；裸 `config`（无子命令）是交互向导【源码】→ wrapper 必须强制带子命令    | fixture + 源码                                                                                                                                                                                                     |
| D11 退出码陷阱  | wrapper 不得信任退出码，必须解析输出                                                                                                                                                                                                                                                                                 | 【实测】凭证缺失时 `memory list` 全栈回溯但 exit 0；【源码】失败路径 echo_error 后正常 return，无 typer.Exit                                                                                                       |
| D11 超时基线    | `invoke`/`runtime invoke` 默认 900s；`exec-command` 60s（max 3600）；`upload-files`/`download-files` 默认 900s【源码】。approved 档注册表逐命令配置                                                                                                                                                                  | fixture + 源码                                                                                                                                                                                                     |
| D17 版本钉版    | `agentarts --version` 输出 `agentarts version: 0.1.7`【实测，fixture `_version.txt` 钉住】。钉 0.1.7，doctor 比对该字符串，skill 教 `pip install agentarts-sdk==0.1.7`                                                                                                                                               | 实测                                                                                                                                                                                                               |
| 凭证 env 契约   | `HUAWEICLOUD_SDK_AK/SK` 生效【实测】。认证链【源码 metadata.py:36】: **env（env 内 OIDC 对优先于 AK/SK）→ profile（`~/.huaweicloud/credentials` 或 `HUAWEICLOUD_SDK_CREDENTIALS_FILE`）→ metadata（最后，3s+3s）**。注意: profile 文件可静默认证（无 env 时）；wrapper 契约"env 或失败"必须显式拒绝 profile 意外命中 | 实测 + 源码                                                                                                                                                                                                        |
| 模型凭证风险    | 消除（**仅 basic 模板**）。langgraph/langchain 需 `OPENAI_API_KEY` 等，google-adk 需 `GOOGLE_API_KEY`【源码 init.py 模板 env 表】                                                                                                                                                                                    | 实测产物 + 源码                                                                                                                                                                                                    |
| 别名方向        | `launch` 主、`deploy` 隐藏别名（与 README 相反）；`config` 主、`configure` 别名；gateway 扁平命名（`gateway create`）。registry 以 `launch`/`config` 为键                                                                                                                                                            | fixture                                                                                                                                                                                                            |

## 权威命令面（43 fixture 全量钉住）

顶层: `init` `config` `dev` `launch`(alias deploy) `invoke` `runtime` `destroy` `gateway` `memory`；全局旗标 `--version/-v` `--verbose` `--install-completion` `--show-completion` `--help`（`_root.txt`）。

- `config`(8): `list` `set-default` `get` `set` `remove` `set-env` `remove-env` `list-env`
- `memory`(8): `create` `get` `list` `update` `delete` `status` `install` `uninstall`
- `gateway`(10): `create` `update` `delete` `get` `list` `create-target` `update-target` `delete-target` `get-target` `list-targets`
- `runtime`(6): `invoke` `exec-command` `upload-files` `download-files` `start-session` `stop-session`

## 分类表修正（fixture 驱动）

- registry 键: `launch`(含 deploy 别名)、`config`(含 configure 别名)。
- `config` 族全部 approved（D10 终裁）；裸 `config` 形式 wrapper 拒绝（交互向导）。
- `gateway delete`/`delete-target`: approved + **wrapper 硬停**（无非交互旗标，按 D11 规则降级到用户终端指引）。
- `memory create/update/delete`: blocked（memory 场景延至下版）；`memory list/get/status`: readonly；`install/uninstall`: approved + host-trust。
- `memory install` 目标平台【实测】: hermes, claude, codex, opencode, openclaw（无 workbuddy/atomcode/dsh）；`--global` 与 `--yes` 存在。
- `launch -m local|cloud`（默认 cloud）。local 为本地 Docker 构建+运行，仍 approved（fail-safe）。
- `-bt/--bearer-token` 出现在【实测】: `invoke`、`runtime invoke`、`exec-command`、`start-session`、`stop-session`。wrapper 全部拒绝（D13）。

## 实测陷阱清单（references 素材）

1. 【实测】首跑写真实 HOME 三处: `~/.bashrc`（追加补全 source 行）、`~/.bash_completions/agentarts.sh`、`~/.agentarts/.completion_shown`。触发于根回调（任何首条命令，含 `--help`）。
2. 【实测+源码】写 `~/.huaweicloud/application_id`: 36 字节本地生成 UUID（mode 640），huaweicloudsdkcore user_agent 模块 **import 时**写入（即任何 agentarts 调用，含 `--help`），并作为 `app/<uuid>` 随每个云请求的 User-Agent 发送。侵入 devkit 凭证命名空间（`credentialFilePatterns` 的 `\.huaweicloud` 会命中该目录读取）。
3. 【实测+源码】`config set-env` 与 `config remove-env` 在 0.1.7 崩溃: 触发条件是 **null**（init 的 basic 模板固定渲染 `environment_variables:` 裸键 → YAML null）而非空列表——空列表不崩（langgraph 等模板不受影响）。崩溃发生在写盘前，零值落盘。fresh basic 项目上确定性复现。
4. 【实测】失败仍 exit 0: 凭证错误时 `memory list` 完整栈回溯 + 空表格但退出码 0。wrapper 成功判定必须解析输出；且不得把失败后的空结果表误判为成功。
5. 【实测】`init` 交互: 无 `-r` 时提示 Region 并在 EOF 中止。E2E/工作流必须传全 `-n -t -r`。
6. 【实测】`invoke -bt/--bearer-token` 存在（见分类表，wrapper 拒绝）。
7. 【实测+文档，冲突待 S0】yaml 默认值 `file_transfer_config.enabled: false`、`url_match_type: ACCURATE_MATCH` 需部署前配置；**部署后可否修改存在证据冲突**: CLI help（runtime_invoke.txt:12-18）给出部署后两条路径（改 yaml 后 redeploy、控制台直改），源码 `launch` 走 `create_or_update_agent` 上插；SDK 文档称不可改。按 fail-safe 视为部署前必须配好，S0 实测裁决。
8. 【实测】SWR org 自动生成（如 `agentarts-cnso2-9qox3klw-org`），`organization_auto_create: true`。
9. 【实测】`dev --env KEY=VALUE` 可重复传参，优先于 yaml。
10. 【实测+源码】metadata 404 warning 是**失败信号**: 仅当 env 与 profile 双失败时才发 metadata 探测。见到 404 即凭证未注入，不是噪音。
11. 【源码】**profile 提供者环境认证**: 无 env 时 CLI 会读 `~/.huaweicloud/credentials`（或 `HUAWEICLOUD_SDK_CREDENTIALS_FILE`）静默认证。wrapper 契约必须显式处理（拒绝意外命中或至少警告）；E2E 隔离须显式断言 scratch 内无该文件。
12. 【源码】裸 `agentarts config`（无子命令）是交互向导（Prompt 逐项询问 name/entrypoint/region/org/repo，还会生成 Dockerfile）。wrapper 强制子命令形式。
13. 【源码】`config set` 破坏性重写 yaml: 剥掉全部注释、键重排序、物化 pydantic 默认值（`container_runtime: docker` 等非 init 模板字段）。用户手写的 yaml 注释一次 set 即丢。
14. 【源码】`memory install` 向宿主 agent 持久化凭证: 如 hermes 平台写 `~/.hermes/.env`（API key）并重写 `~/.hermes/config.yaml`。host-trust 标签的实证。
15. 【实测】`memory` 族命令默认 region **cn-north-4**（5 个子命令 help 均标注），与控制面 cn-southwest-2 不一致。wrapper/skill 必须显式传 `--region`。
16. 【实测】`memory list --output json`（默认 table）+ `--limit 20`/`--offset` 分页。wrapper 解析用 json 输出。
17. 【实测】`gateway delete`/`delete-target` 为 `typer.confirm` 交互确认，无跳过旗标。wrapper 硬停 → 用户终端。
18. 【实测】`config` 族全部从 `Path.cwd()` 解析 `.agentarts_config.yaml`，无路径旗标。wrapper 必须控制 cwd。

## 真实 yaml 形状（两种，勿混淆）

- **init 产物**（basic, 75 行，含注释）: 见源码模板 `init.py:173-248`。关键字段: `default_agent`、`agents.<name>.base`、`swr_config`、`runtime.invoke_config{protocol,port,file_transfer_config,url_match_type}`、`network_config`、`identity_configuration`、`observability`、`artifact_source`、`storage_config`、`environment_variables`（basic 为裸键 null）、`tags`。`platform: linux/arm64` 按宿主架构生成【实测】。
- **config set 后重写产物**（65 行，无注释，含物化默认值）: 即 `.e2e-home/proj/probe-agent/.agentarts_config.yaml` 当前保留物。陷阱 13 的直接后果。

## E2E 凭证交付

凭证文件 `~/.config/agentarts-e2e/creds`（0600，工作树外；变量名 `AK`/`SK`，harness 映射为 `HUAWEICLOUD_SDK_AK/SK`）。迁出工作树的理由是工作树卫生与 harness 映射需求（0.1.7 无 load_dotenv 调用点，"防 dotenv 自动加载"不成立【源码 grep 零命中】）。S0 落地时增补 `E2E_FORBIDDEN_ACCOUNT_ID`。
既有发现【运维】: `~/.bash_history` 存在 2026-08-21 用户会话遗留的明文 `export HUAWEICLOUD_SDK_AK/SK/PROJECT_ID=<值>`（早于本项目，非 PR0 泄漏——PR0 探针仅引用变量名未展开值）。建议清理该历史条目并评估轮换 AK/SK。

## 遗留到 S0（账号侧实测项）

- `launch`/`destroy` 的真实交互提示行为（destroy 有 `--yes`，预期无交互——【预测】）。
- deploy → invoke → destroy 全链路与计时。
- 审批计数基线核验（config/deploy/invoke/destroy = 4）。
- 【新增】`file_transfer_config`/`url_match_type` 部署后可变性（陷阱 7 的冲突裁决）。
