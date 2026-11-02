# AgentArts 云代码解释器接入计划（CI1-CI7）

日期: 2026-11-02。本计划把 AgentArts SDK 0.1.7 的云代码解释器能力接入 devkit, 形式是镜像 browser 桥（B1-B7, e9f4b439）的 SDK 桥接 MCP 工具族。消费者是宿主 agent（经 MCP 工具在隔离的云端沙箱里执行代码、装包、传文件）, 付费者是 S4 场景构建者（docs/agentarts-scenario-plan.md:56-70）。维护者继承 browser/memory 桥的既有机械（approval-tokens、buildChildEnv、runOverPythonCandidates、saveLargeOutput）, 新文件两枚。

SDK 钉版不升: 0.1.9 与 0.1.7 的 browser/code_interpreter 面字节级一致（wheel diff 实测, 2026-10-30, browser 计划已覆盖）。

范围裁决（操作者 2026-11-02 定案）: 最小动作面。invoke 动作只暴露 execute_code / install_packages / upload / download / clear_context, 不暴露裸 execute_command。依据: execute_code 本身是沙箱内任意 python, 能力严格大于 shell 命令; 真正的安全边界是云端一次性沙箱 + 会话租约审批, 客户端拦截是卫生层不是边界; S4 场故事定义的面是「执行代码、装包、上传下载文件」, 不含裸命令。install_packages 在桥侧加严格包名正则——SDK 只查 `; & | \` $`五字符, 而 execute_command 白名单的`\s` 含换行, 含换行的恶意包名可穿透两层校验（源码 CI:673-685, strict_block_pattrns = [] 死代码）。

审批模型裁决: 会话租约, 镜像 browser。start_session 是审批边界（session_timeout 60-86400 秒披露, SDK 默认 900）。租约载体是 0600 会话状态文件, 由已批准的 start 写入, stop 删除。与 browser 的关键差异: 会话寻址是 (code_interpreter_name, session_id) 二元组, 状态文件两字段都记; 租约只携带 timeout, 无域名围栏等价物。approval-tokens.mjs 零改动。

## How to read this

一个 box 一个工作单元, 证据存在才打勾。CI1 → CI2 → CI3 → CI4 → CI5 → CI6 → CI7 顺序执行, CI2 依赖 CI1 的 region 裁决, CI3 依赖 CI1 的 key 来源裁决, CI5 依赖 CI1 的信封形状裁决。

## Program checklist

### CI1 真机 spike（docs only）【裁决完成 2026-11-02, 陷阱 81-90】

- [x] 探测脚本走 e2e creds（~/.config/agentarts-e2e/creds, 0600, 与 S1 账号隔离）, 全程脱敏: 不打印 AK/SK、api_key 值（陷阱 81 凭证双名映射: AK/SK → HUAWEICLOUD_SDK_AK/SK）
- [x] CI-1 IAM 型数据面复核: create(auth_type=IAM) → 数据面 AK/SK 签名全程序化, **成立**（陷阱 81）
- [x] CI-2 access_endpoint 形状 + 端点解析链: 裸域名 defaultgw-*, 构造器 data_endpoint 参数经 _ensure_https 自动补 scheme（与 browser 不同, 陷阱 82）; 空端点报错不提端点
- [x] CI-3 start_session 最小参数面 = code_interpreter_name + session_name; timeout 60 与 86400 均接受（但 60 不是墙钟——陷阱 85）
- [x] CI-4 execute_code 响应信封: content 块形无 structured_content; execute_command/install 有 structured_content {exit_code, stderr, stdout}; 上传回 resource_link 块; 沙箱是 IPython 内核, sys.exit 不传播（陷阱 83）
- [x] CI-5 install_packages: `==` 正常; `>=` 静默变 shell 重定向; **newline 注入实测复现且 exit_code 0**（陷阱 84——桥侧包名白名单的依据）; pypi 出网正常
- [x] CI-6 upload 文本/binary 两形 + download 的 str/bytes 分叉（UTF-8 可解码回 str, 陷阱 88）; mime 按扩展名推断
- [x] CI-7 clear_context 语义实测: 变量清空, NameError is_error: true（陷阱 90）
- [x] CI-8 会话过期错误形状: **timeout=60 的会话 65s 后仍活**（与 browser 相反, 陷阱 85）; 活解释器伪 session_id → "Session not found"（双前缀形状, 陷阱 86）; 解释器删除 → "No matching policy found"（级联杀会话, 独立死亡签名）
- [x] CI-9 计费信号: 响应中零计费字段, unknown 维持（陷阱 89）
- [x] CI-10 stop_session 无状态 no-op True 实测确认; invoke 缺状态本地 ValueError（doccode 矛盾钉三处, 陷阱 86/87）
- [x] 资源预算: 3 个解释器先后建均删 + 会话全灭（显式 stop 或级联死亡经签名确认）, 按名过滤收敛 total_count: 0 终验（陷阱 90）
- [x] 回写 docs/agentarts-pr0-findings.md（陷阱 81-90）+ docs/agentarts-upstream-asks.md（诉求 35-40）
- [ ] 仓库门禁: `npm run lint` + `npm test` + `npm run validate` + `npm run format` + `npm run pack:verify`

### CI2 读桥（控制面）

- [ ] 创建 `plugins/huaweicloud-core/src/agentarts-interpreter-tools.mjs` + `agentarts-interpreter.mjs`（read 部分）
- [ ] 工具 `huaweicloud_agentarts_interpreter_read`: list_code_interpreters/get_code_interpreter
- [ ] AK/SK 注入子进程（控制面, list_agents 同姿态）, region 请求 JSON 显式传递, 默认 cn-southwest-2, 边界拒错型
- [ ] 复用 runOverPythonCandidates/buildChildEnv/saveLargeOutput; snippet 异常捕获 except BaseException + SystemExit 重抛（browser R1 契约）
- [ ] 测试镜像 browser 桩模式: `test/agentarts-interpreter.test.mjs`; `test/structure.test.mjs` 注册钉

### CI3 写桥（资源生命周期）

- [ ] plan/write 对, namespace `agentarts-interpreter-sdk`, 单次消费 token 契约逐字复用
- [ ] create canonicalizes auth_type=IAM（CI1 复核后定）; update 只暴露 tags（镜像 browser, SDK update 吃 observability + tags 但 observability 形状未实测）; delete 不可逆
- [ ] API_KEY 型支持: buildChildEnv 白名单加 HUAWEICLOUD_SDK_CODE_INTERPRETER_API_KEY（SDK 原生读取, CI:442）
- [ ] create/get 响应解析 access_endpoint 在结果面携带; 删 interpreter 清理对应会话状态文件; 秒级残留窗口教学（browser 陷阱 63 同族）

### CI4 会话生命周期

- [ ] start_session 走 approved 写契约; 捕获会话状态文件 `agentarts-interpreter-session-<session_id>.json`（0600, 无凭证）: code_interpreter_name + session_id + 数据面端点 + auth 姿态 + 租约到期（start + session_timeout）
- [ ] start 前查既有会话文件（二次 start 静默覆盖会孤儿化云侧会话）; 陈旧记录自动清扫; mint 后并发租约披露（browser 陷阱 75d 同族）
- [ ] get_session/stop_session 走免审批工具 `huaweicloud_agentarts_interpreter_session`（读 + 清理放行）; stop 删除本地租约记录; 二元组寻址从状态文件解析, 不进审批面

### CI5 租约门动作工具（最小动作面）

- [ ] `huaweicloud_agentarts_interpreter_invoke`, action 枚举: execute_code / install_packages / upload_files / download_file / clear_context
- [ ] 桥侧逐动作校验: install_packages 包名正则（禁空白与全部 Shell 元字符——封 newline 注入, SDK 五字符检查的洞）; upload/download 路径限定 /home/user（SDK DEFAULT_PATH）; execute_code 非空 + language 仅 python（SDK 只支持 python, 白名单镜像）
- [ ] 每次调用 snippet 先设 client.code_interpreter_name + client.session_id（跨进程连续性, browser 陷阱 68 同款）
- [ ] 租约门: 无记录 → start 指引; 过期 → SESSION_LEASE_EXPIRED coded 拒绝
- [ ] 大输出走 saveLargeOutput; binary 下载解码落 0600 文件返路径/mime/尺寸（browser screenshot 先例, base64 不上 stdout）
- [ ] 错误映射: 会话死亡错误形状按 CI1 实测锚定（「Session not found」双措辞风险, browser 陷阱 80 同族）

### CI6 skill 与文档

- [ ] SKILL.md: 移除 NOT-for 里 "code interpreter (not yet bridged)", 场景路由增 interpreter 行, tier map 增行, MCP Tools 增条目, Measured Traps 增行（全部 CI1 实测）
- [ ] `references/cli-workflows.md` 增 Code Interpreter Sessions and Actions 节; `references/credentials.md` 增 CI credential model 节
- [ ] `test/structure.test.mjs` 增 skill 路由钉（工具名、tier 行、场景行、references 节——死路规则执行）
- [ ] `docs/CHANGELOG.md` 落条目

### CI7 真机 e2e 与对抗加固

- [ ] 全工具面真机驱动（已交付工具函数, 非探测脚本）: read list/get → plan/write create → plan/write start → invoke execute_code/upload/download/install_packages/clear_context → get_session → stop → plan/write delete → 按名过滤收敛
- [ ] interrogate 对抗轮次循环（执行 → 检视 → 修复 → 再检视）直至零未修缺陷; 陷阱只写 CI1/CI7 实测

## 验证规则

每个 PR 的门是 `npm run lint` + `npm test` + `npm run validate` + `npm run format` + `npm run pack:verify`。单测只证明边界与契约, 不证明可达。可达性证据只在 CI1 与 CI7 的真机会话里产生。

## Appendix A. 已裁决项（源码闭环）

- SDK 面 17 方法: 控制 5（create/list/update/get/delete）+ 数据 12（start_session/get_session/stop_session/invoke/execute_code/execute_command/upload_file/upload_files/download_file/download_files/install_packages/clear_context）
- 构造器 CodeInterpreter(region, data_endpoint=None, auth_type="API_KEY", verify_ssl=True); auth_type=IAM 时数据面 open_ak_sk（AK/SK 签名, 与注入凭证同源）
- 端点解析链: AGENTARTS_CODEINTERPRETER_DATA_ENDPOINT env > 构造参数 > AGENTARTS_RUNTIME_DATA_ENDPOINT, 三层全过 _ensure_https（constant.py:118-133）; 空串报错不提端点
- API_KEY 型 env: HUAWEICLOUD_SDK_CODE_INTERPRETER_API_KEY（docstring 写 API_KEY, 文档代码矛盾之一）
- create 名称规则 ^[a-z][a-z0-9-]{0,38}[a-z0-9]$（与 browser 同）; API_KEY 型必须 api_key_name; 返回含 access_endpoint
- update 只吃 observability + tags（源码 CI:333-376）
- start_session(code_interpreter_name, session_name, session_timeout=900), 边界 60-86400; get_session 需二元组; stop_session 无状态 no-op True（CI:527-565）
- invoke 需 client 状态（name + session_id）, 缺失即 raise（docstring 声称自动开 session, 矛盾之二）
- execute_command 白名单 ^[a-zA-Z0-9_\-\.=\s\/\.:]+$（`;|&\`$'`引号重定向全拒）+ strict_block_pattrns = [] 死代码;`>` `<`不在白名单 → install_packages 版本规格只能`==`（CI1 验证）
- install_packages 客户端只查 `; & | \` $`五字符, 不查换行; 白名单`\s`含`\n` → newline 注入向量, 桥封
- upload/download 限定 /home/user（DEFAULT_PATH）; upload 走 write_files, content 为 text 或 base64 blob; download 走 read_files, 返回 content 块 type text/image/resource
- clear_context = execute_code("# Context cleared", clear_context=True)
- 0.1.9 与 0.1.7 CI 面字节一致（wheel diff 实测）

## Appendix B. 否决项

- 暴露 execute_command + devkit 侧拦截层（操作者 2026-11-02 裁决）: execute_code 能力严格更大, 拦截是卫生层不是边界, S4 故事不含裸命令; 真机跑出需求再立独立 PR
- CLI 路径: 0.1.7 零 CI 子命令（43 fixture 全量证实）
- 钉版升 0.1.9: CI 面字节一致, 无收益
- 逐动作审批: 代码执行是高频循环（browser 同裁决）
- CI 并入 browser 计划: 当年已否决（拦截层独立设计）, 本计划即该独立设计

## Appendix C. 风险

- 计费 unknown（CI-9 预计, 无 API 面, 控制台）→ skill 前置告知
- 沙箱出网策略未知（pip install 能否走华为云镜像）→ CI-5 实测
- 数据面 HTTP 超时与长代码执行竞速（browser 30s 同款? CI1 观察）
- execute_code 长时运行与会话超时的交互 → CI1 观察
- 三处文档代码矛盾（invoke 自动开 session / api_key env 名 / 第三处 CI1 找）→ 教学, 不修上游

## Appendix D. 未裁决项【CI1 后收口】

CI1 十项全部裁决（陷阱 81-90）。仍开放: 计费（无 API 面, 控制台）; timeout 语义的长时行为（60s 不死已钉, 更长窗口与空闲假设未测——本地租约硬门不依赖云语义, 无阻塞）; clear_context 后包存活与否（未测, 不影响桥契约）; 上传 resource_link 的 uri 对下载不可复用性（file:// 形状, 桥不消费）。桥的既有容错: 租约门对未形状错误保守拒绝; 分页保守默认 10/透传 100; language 白名单仅 python。
