# AgentArts PR0 实测裁决记录

日期: 2026-10-19（interrogate 循环下多轮修订，轮次见 git 历史）。环境: Python 3.12.3, agentarts-sdk 0.1.7 (pip, 华为云镜像), aarch64 Linux, typer 0.27.3 / rich 15.0.0。
fixture 捕获环境: `COLUMNS=80 NO_COLOR=1` 非 TTY 重定向，共 43 个文件（`_root`、`_version` + 9 个一级 + 32 个二级 help），位于 `test/fixtures/agentarts/help-tree/`。
标注纪律: 【实测】= 本机运行观测；【源码】= 钉版 venv 内源码验证；【源码预裁】= 源码级预裁决（待 S0 真机确认）；【文档】= SDK 文档转述（不作裁决依据）；【预测】= 待 S0 裁决。
后续 PR 以本文为单一事实源；与本文件冲突的早期规划段落以本文件为准。

## 裁决汇总（映射计划 v3 决策号）

| 决策            | 裁决                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 依据                                                                                                                                                                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D10 config 档位 | approved（终裁，不降级）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 【实测】`config set` 写 cwd 本地 yaml；【源码】set-env 持久化路径存在且官方 help 示例即 `config set-env HUAWEICLOUD_SDK_AK your-ak`（0.1.7 该路径在 fresh basic 项目上崩溃，见陷阱 3，故为源码证实而非端到端实测）                      |
| D11 非交互旗标  | `destroy --yes/-y`、`memory install --yes`、`memory uninstall --yes`、`memory delete --force/-f`【实测】；`init` 必须传 `-r`【实测】；`memory install/uninstall` 省略 `target` 参数时进入选择交互【实测 help "Omit to select/detect"，源码 installer/cli.py:112,180】→ wrapper 必须显式传 target + `--yes`；`gateway delete/delete-target` **无任何跳过旗标**【源码 gateway.py:159,358 typer.confirm】→ 按 D11 规则 wrapper 硬停指向用户终端；裸 `config`（无子命令）是交互向导【源码】→ wrapper 必须强制带子命令 | fixture + 源码                                                                                                                                                                                                                          |
| D11 退出码陷阱  | wrapper 不得信任退出码，必须解析输出                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 【实测】凭证缺失时 `memory list` 全栈回溯但 exit 0；【源码】失败路径 echo_error 后**落穿继续执行**（无 return：list 在错误行后仍打印空表格，create/delete 甚至追加成功行；仅 delete 的用户取消路径有 `typer.Exit(0)`，commands.py:379） |
| D11 超时基线    | `invoke`/`runtime invoke` 默认 900s；`exec-command` 60s（max 3600）；`upload-files`/`download-files` 默认 900s【源码】。approved 档注册表逐命令配置                                                                                                                                                                                                                                                                                                                                                               | fixture + 源码                                                                                                                                                                                                                          |
| D17 版本钉版    | `agentarts --version` 输出 `agentarts version: 0.1.7`【实测，fixture `_version.txt` 钉住】。钉 0.1.7，doctor 比对该字符串，skill 教 `pip install agentarts-sdk==0.1.7 -i https://mirrors.huaweicloud.com/repository/pypi/simple`【PR5 裁决: 华为云 pypi 镜像为默认安装源（受限网络友好，对齐 README npm 镜像姿势）；镜像滞后新钉版时回退官方源；skills 的 `-i` 字面量与 src `AGENTARTS_SDK_MIRROR` 常量由 validate 奇偶校验钉住】                                                                                 | 实测                                                                                                                                                                                                                                    |
| 凭证 env 契约   | `HUAWEICLOUD_SDK_AK/SK` 生效【实测】。认证链【源码 metadata.py:36】: **env（env 内 OIDC 对优先于 AK/SK）→ profile（`~/.huaweicloud/credentials` 或 `HUAWEICLOUD_SDK_CREDENTIALS_FILE`）→ metadata（最后，3s+3s）**。注意: profile 文件可静默认证（无 env 时）；wrapper 契约"env 或失败"必须显式拒绝 profile 意外命中                                                                                                                                                                                              | 实测 + 源码                                                                                                                                                                                                                             |
| 模型凭证风险    | 消除（**仅 basic 模板**）。langgraph/langchain 需 `OPENAI_API_KEY` 等，google-adk 需 `GOOGLE_API_KEY`【源码 init.py 模板 env 表】                                                                                                                                                                                                                                                                                                                                                                                 | 实测产物 + 源码                                                                                                                                                                                                                         |
| 别名方向        | `launch` 主、`deploy` 别名（help 命令列表中明示，与 README 相反）；`config` 主、`configure` 别名；gateway 扁平命名（`gateway create`）。registry 以 `launch`/`config` 为键                                                                                                                                                                                                                                                                                                                                        | fixture                                                                                                                                                                                                                                 |

## 权威命令面（43 fixture 全量钉住）

顶层: `init` `config` `dev` `launch`(alias deploy) `invoke` `runtime` `destroy` `gateway` `memory`；全局旗标 `--version/-v` `--verbose` `--install-completion` `--show-completion` `--help`（`_root.txt`）。

- `config`(8): `list` `set-default` `get` `set` `remove` `set-env` `remove-env` `list-env`
- `memory`(8): `create` `get` `list` `update` `delete` `status` `install` `uninstall`
- `gateway`(10): `create` `update` `delete` `get` `list` `create-target` `update-target` `delete-target` `get-target` `list-targets`
- `runtime`(6): `invoke` `exec-command` `upload-files` `download-files` `start-session` `stop-session`

**注意: CLI 没有 agent 运行时列表命令**（43 fixture 全量证实）。PR7 起由 `huaweicloud_agentarts_list_agents` 工具补此空缺，走 SDK Python API。

## SDK API 面（PR7 实测，钉版 venv 源码）

- `RuntimeClient.get_agents(agent_name, offset=1, limit=10, **extra)`【源码】走 `GET /v1/core/runtimes`；信封键 `items` 或 `agents` 或裸列表，SDK 侧三兼容，返回 agent dict 列表。`find_agent_by_name` 为 EXACT 匹配同端点。
- 控制面认证 = AK/SK 签名（`open_ak_sk=True`，SDK-HMAC-SHA256），凭据走 env 链——wrapper 的 `HUAWEICLOUD_SDK_AK/SK` 注入直接可用，无需 bearer token【源码 http_client.py】。
- 区域 env 链（`HUAWEICLOUD_SDK_REGION` 等）不在 wrapper 子进程白名单内 → 工具必须显式传 region；`get_control_plane_endpoint(region)` 构造 `https://agentarts.<region>.myhuaweicloud.com`【源码 constant.py】。
- 工具契约（与 CLI runner 的两点刻意差异）: (1) 参数作为**独立 argv 元素**（`python -c <snippet> <json>`，snippet 读 `sys.argv[1]` 后 `json.loads`）——JSON 串不是 Python 字面量（true/false/null），织入代码会在未来布尔参数上静默漂移;(2) snippet 退出码是我们自己的契约（0 成功 / 3 模块缺失→换 python 候选 / 1 失败），`detectFailure` 签名嗅探保留为第二防御层。python 候选链: 解析出路径的 CLI 同级 python（venv/AGENTARTS_BIN）> PATH `python3`/`python`。
- 分页默认**省略不传**（SDK `offset=1, limit=10` 与 gateway 的 0 基分页相悖，方向未实测）——SDK 缺省是唯一真源，S0 全默认实测后再裁决。

## install-agentarts 实测（PR6 工具，A2 补测 2026-10-21）

- 从零创建路径【实测，aarch64 Linux + Python 3.12.3 + 真网络】: `HUAWEICLOUD_HOME=<scratch> node bin/setup.cjs install-agentarts` 38s 完成，全部 63 个包经华为云镜像真实下载（`Downloading …mirrors.huaweicloud.com/repository/pypi/packages/…`，零官方源回退），venv 153M，`agentarts --version` 输出钉版横幅 `agentarts version: 0.1.7`，`resolveAgentartsCommand()` 在 `HUAWEICLOUD_HOME` 覆盖下正确解析 scratch venv。
- 幂等收敛路径【实测】: 对已存在的 153M venv 重跑 `install-agentarts`，`python -m venv` 覆盖无错、pip 报全部 already satisfied（钉版 `==0.1.7` 经镜像确认）、exit 0；doctor 报 `[PASS] AgentArts CLI 0.1.7 (pinned 0.1.7)`。
- 残留 open item: Windows（win32 python/venv/`Scripts\agentarts.exe` 路径）与真正裸机 HOME（本机首跑 HOME 写入已物化，无法区分新写入）仍无真机记录。

## 分类表修正（fixture 驱动）

- registry 键: `launch`(含 deploy 别名)、`config`(含 configure 别名)。
- `config` 族全部 approved（D10 终裁）；裸 `config` 形式 wrapper 拒绝（交互向导）。
- `gateway delete`/`delete-target`: approved + **wrapper 硬停**（无非交互旗标，按 D11 规则降级到用户终端指引）。
- `memory create/update/delete`: PR11 起解封为 approved（create/update 无 label，delete 带 `irreversible`——源码级删除级联 sessions/messages/memories，client.py:63-64；计费未实测不加 billing label）；`memory list/get/status`: readonly；`install/uninstall`: approved + host-trust。
- `memory install` 目标平台【实测】: hermes, claude, codex, opencode, openclaw（无 workbuddy/atomcode/dsh）；`--global` 与 `--yes` 存在。
- `launch -m local|cloud`（默认 cloud）【实测】。local 为本地 Docker 路径【实测 help "local Docker"】，构建+运行为【源码】语义，仍 approved（fail-safe）。
- `-bt/--bearer-token` 出现在【实测】共 **7 个命令**: `invoke`、`runtime invoke`、`runtime exec-command`、`runtime upload-files`、`runtime download-files`、`runtime start-session`、`runtime stop-session`。wrapper 规则为**拒绝任何命令上的 `--bearer-token`/`-bt` 出现**（不依赖枚举，防未来新增）。

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
15. 【实测】`memory` 族命令默认 region **cn-north-4**（6 个子命令 help 均标注: create/get/list/update/delete/status；install/uninstall 无 region 旗标），与控制面 cn-southwest-2 不一致。wrapper/skill 必须显式传 `--region`。
16. 【实测】`memory list --output json`（默认 table）+ `--limit 20`/`--offset` 分页。wrapper 解析用 json 输出。
17. 【实测+源码】`gateway delete`/`delete-target` 为 `typer.confirm` 交互确认（gateway.py:159,358），无跳过旗标。wrapper 硬停 → 用户终端。
18. 【实测+源码】`config` 族全部从 `Path.cwd()` 解析 `.agentarts_config.yaml`（operations/runtime/config.py:69-71），无路径旗标。wrapper 必须控制 cwd。
19. 【实测，PR5】镜像安装命令 `pip install agentarts-sdk==0.1.7 -i https://mirrors.huaweicloud.com/...` 被 credentialFilePatterns 的 `\.huaweicloud` 误拒（域名 `mirrors.huaweicloud.com` 被当作凭证路径读取；README npm 镜像命令、sandbox node 镜像 curl、support 文档 URL 同类误伤）。PR5 窄化为路径组件语义 `\.huaweicloud(?![.\w])`：后随 `/`、行尾、引号、反斜杠才命中，`.com` 域名不命中；`~/.huaweicloud` 真实读取（含 URL 内嵌路径的 exfil 形）保持拒绝。policy.json 单一来源，两层 hook 同步生效，双向回归测试钉住。

## 真实 yaml 形状（两种，勿混淆）

- **init 产物**（basic, 75 行，含注释）: 见源码模板 `init.py:173-248`。关键字段: `default_agent`、`agents.<name>.base`、`swr_config`、`runtime.invoke_config{protocol,port,file_transfer_config,url_match_type}`、`network_config`、`identity_configuration`、`observability`、`artifact_source`、`storage_config`、`environment_variables`（basic 为裸键 null）、`tags`。`platform: linux/arm64` 按宿主架构生成【实测】。
- **config set 后重写产物**（65 行，无注释，含物化默认值）: 即 `.e2e-home/proj/probe-agent/.agentarts_config.yaml` 当前保留物。陷阱 13 的直接后果。

## E2E 凭证交付

凭证文件 `~/.config/agentarts-e2e/creds`（0600，工作树外；变量名 `AK`/`SK`，harness 映射为 `HUAWEICLOUD_SDK_AK/SK`）。迁出工作树的理由是工作树卫生与 harness 映射需求（0.1.7 无 load_dotenv 调用点，"防 dotenv 自动加载"不成立【源码 grep 零命中】）。S0 落地时增补 `E2E_FORBIDDEN_ACCOUNT_ID`。
既有发现【运维】: `~/.bash_history` 存在 2026-08-21 用户会话遗留的明文 `export HUAWEICLOUD_SDK_AK/SK/PROJECT_ID=<值>`（早于本项目，非 PR0 泄漏——PR0 探针仅引用变量名未展开值）。建议清理该历史条目并评估轮换 AK/SK。

## 文档级事实（非裁决依据，供 skill 引用标注出处）

- 产品四种使用方式（Managed Agents、自带代码运行时托管、外部智能体观测评估、低代码编排）与 Python ≥3.10 最低版本:【文档】产品介绍页 / SDK README。
- memory 插件行为 = 会话捕获 + 回复追踪（SDK 仓库 opencode/claude_code 插件自述）:【文档】agentarts-sdk-python 仓库 plugin.json 描述。凭证持久化为【源码】（陷阱 14）。
- `AGENTARTS_BIN`:【约定】包装器的可执行覆盖（对齐 HCLOUD_BIN 先例），PR2 起为消费方。PR5 起解析顺序为 env > devkit 托管 venv（`~/.config/huaweicloud/agentarts-venv`，honors `HUAWEICLOUD_HOME`；探测 CLI 本体而非目录，半建 venv 不遮蔽 PATH；venv 由 PR6 的 install-agentarts 供给）> PATH。

## 遗留到 S0（账号侧实测项）

- `launch`/`destroy` 的真实交互提示行为。【源码预裁】destroy 的唯一提示是 `Confirm.ask` 且被 `--yes` 门控（destroy.py:39-47）；launch 链无任何 CLI 级 prompt 站点（deploy.py 全链零 confirm/prompt/input）；docker login 经 subprocess 程序化传参。S0 仅做真机确认。
- deploy → invoke → destroy 全链路与计时。
- 审批计数基线核验（config/deploy/invoke/destroy = 4）。
- 【新增】`file_transfer_config`/`url_match_type` 部署后可变性（陷阱 7 的冲突裁决）。
- 【PR7 新增】list-agents 真机裁决: 信封键与 agent dict 字段形状、SDK 全默认分页语义（offset=1 基准与返回条数）、`agent_name` 模糊过滤行为、destroy 后列表消失的最终一致性窗口。
- 【PR11 新增】memory 真机裁决: rich print_json 的真机输出格式（折行/噪声——提取器 JSON.parse+正则双路的实测裁决）、`memory get` 是否回传 api_key（`_space_info_to_dict` 含该键，服务端行为未知）、region 拓扑不一致（CLI 默认 cn-north-4，PR4 e2e 的 memory list 用 cn-southwest-2 成功过——待裁）。

## PR11 memory 生命周期（实测源码钉点）

- `toolkit/cli/memory/commands.py:121-131`【源码】: `--output json` 分支 `console.print_json` 完整 space dict（含 api_key）；table 分支只打 Space ID/Status → 不带 json 一次性 key 永久丢失。
- `toolkit/operations/memory/space.py:54-55`【源码】: 序列化字典含 `api_key`/`api_key_id`。
- `sdk/memory/client.py:46-47,102-131`【源码】: 数据面 `HUAWEICLOUD_SDK_MEMORY_API_KEY` env / `api_key` 形参链。
- fixture: `memory_create.txt:36-37` `--output/-o [default: table]`；`memory_delete.txt:13` `--force/-f`（**不是** `--yes`）；`memory_update.txt` 无确认旗标。
- wrapper 设计: per-operation 旗标 Map（`destroy`/`memory install`/`uninstall` → `--yes`；`memory delete` → `--force`；`memory create` → `--output json`，显式非 json 在 plan 层拒绝——不做审批绑定参数上的 argv 手术）；key 提取在 redactSecrets **之前**的原始 stdout 上（JSON.parse 失败退正则，同 e2e memory list 的正则法），写 `~/.config/huaweicloud/agentarts-memory-api-key-<space_id>.txt`（0600，honors `HUAWEICLOUD_HOME`），载荷仅路径；key 文件读取被 credentialFilePatterns hook 拦（纵深防御）。
