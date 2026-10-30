# DSHBar 任务记录规则（粘贴给 AI 客户端）

你已接入 DSHBar（DSH 桌面端的轻量任务计时工具）。请在日常执行任务时，遵循下面这套「只记录有跟踪价值的内容」的规则，帮助用户沉淀一份诚实、可回溯的工作日志。

> **DSH 桌面端**里工具名带服务器前缀：下文写的 `dshbar_start_work`，实际要调用 `mcp__dshbar__dshbar_start_work`。把本文件内容写进 `%APPDATA%\dsh-desktop\harness\AGENTS.md`（= `$DSH_HOME/AGENTS.md`，对本机所有会话生效）或在仓库根放 `AGENTS.md`；DSH 内置的 `dsh-agent-instructions` 会在每次会话第一次请求前把这类文件注入上下文。详见 `install.md` §5。

## 一、什么时候记，什么时候不记

**要记录（值得跟踪）**
- 用户明确要求的待办事项（用户说「稍后我要做 X」「帮我记一下要做 Y」）。
- 你实际在执行、且需要一段明确时间的任务（写代码、写文档、做研究、跑实验、开会、读资料等）。
- 用户手动指定「这个任务开始计时 / 这个任务做完」的场景。

**不记录**
- 一句话即可完成的零碎问答、闲聊、寒暄。
- 与用户工作无关的纯信息查询（今天的天气、某条新闻等）。
- 你自己无法控制、也不该占据「执行时间」的等待（比如等用户回复）。

> 原则：宁可少记，不可虚记。没有跟踪价值的动作不要创建任务，避免污染统计。

## 二、任务生命周期

1. **开始执行** → 调 `dshbar_start_work`，`title` 用用户的语言概括（中文场景用中文），必要时带 `estimated_seconds`（秒）。
   - 不填 `estimated_seconds` = 正计时；填了 = 倒计时，到 0 前应主动 `dshbar_finish_work`。
2. **执行中被打断** → 调 `dshbar_pause_work`；重新开始 → 调 `dshbar_resume_work`（会自动暂停其他 running 任务）。
3. **任务结束**（二选一）
   - 正常完成 → `dshbar_finish_work`，`note` 填一句结果或产出，方便日后检索。
   - 主动放弃 / 被取消 / 失败 → `dshbar_abort_work`，`reason` 说明原因。**不要**用 finish 掩盖失败。
4. **用户新增待办** → `dshbar_add_tasks`（批量，状态 pending，不会自动计时）。待开始执行时再用 `dshbar_start_work` 或 `dshbar_resume_work`。
5. **需要核对当前状态** → `dshbar_get_status` 看统计与最近完成记录；`dshbar_list_tasks` 看明细。
6. **改错了** → `dshbar_update_task` 改标题/预计时长；`dshbar_delete_task` 删除误建任务；`dshbar_reorder_tasks` 调整显示顺序。

## 三、关键纪律

- **工具未连接 / 调用失败时，静默跳过，绝不让记录行为阻塞你的正常工作。** 不要因为记录失败而中断用户的任务，也不要在回复里抱怨。
- **不要在回复中主动提及你在记录。** 记录是你的后台动作，输出给用户的仍是正常的工作结果。
- 每个任务只对应一个 running 状态：开始新任务会自动暂停旧的，符合单线程工作模型。
- `dshbar_start_work` / `dshbar_add_tasks` 之后可以用 `dshbar_list_tasks` 校验是否成功（可选）。

## 四、快速模板

- 开始：`dshbar_start_work { "title": "编写登录接口文档", "estimated_seconds": 1800 }`
- 完成：`dshbar_finish_work { "task_id": "<上一步返回的 id>", "note": "完成 4 个接口的文档与示例" }`
- 失败：`dshbar_abort_work { "task_id": "<id>", "reason": "第三方 API 凭证缺失，无法继续" }`
- 加待办：`dshbar_add_tasks { "tasks": [ { "title": "整理周报", "estimated_seconds": 600 } ] }`
- 查状态：`dshbar_get_status {}`
