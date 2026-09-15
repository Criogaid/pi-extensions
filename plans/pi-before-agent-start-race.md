# pi `before_agent_start` 并发 prompt 竞态调查

> **用途**：跟踪一个 **pi core 的上游 bug**（非本仓库插件缺陷）。scout 是主要受害方——它把竞态窗口放大到秒级，导致 scouting 期间再发消息会报错且消息彻底丢失。等待上游修复并验证后关闭本计划。
>
> 调查时点：2026-09-15，本地 pi-coding-agent 0.84.3，npm 最新 0.85.1（已核对源码，同样未修）。

## 现象

- scouting（side agent 运行）期间再提交一条消息，第二条报错：
  `Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.`
- 报错的那条消息**彻底消失**——不在 transcript 里，需要用户重新输入。
- 用户预期：像 streaming 期间一样排进 steer 队列。

## 根因（已定位，代码级证据）

`AgentSession.prompt()` 的 streaming 闸门检查 `isStreaming`（= `_isAgentRunActive`），但该 flag 在 `_runAgentPrompt()` 里才置 true——即 **`emitBeforeAgentStart` 返回之后**。整个 `before_agent_start` 异步窗口不受保护：

```
t0  prompt(A)：isStreaming=false → await emitBeforeAgentStart(A) → scout A 跑 side agent（最长 15s）
t1  prompt(B)：isStreaming 仍为 false（flag 尚未置位）→ 走完整路径
    → await emitBeforeAgentStart(B)：两个 scout 并发跑（共享 prevTurn/lastDecision 互相污染）
t2  scout A 先返回 → _runAgentPrompt(A) → agent.prompt(A) → run 启动
t3  scout B 返回 → _runAgentPrompt(B) → agent.prompt(B) → 抛错
    B 的消息体只存在于局部数组，从未 append 到 transcript → 消失
```

谁先跑完 scout 谁赢，另一个死（B 先返回则换成 A 消失）。

证据（0.84.3 dist，行号为该版本）：

| 位置 | 事实 |
|------|------|
| `pi-coding-agent/dist/core/agent-session.js` ~L834 | `prompt()` 内 `if (this.isStreaming)` 闸门 |
| 同文件 ~L887 | `await emitBeforeAgentStart(...)`——无并发保护 |
| 同文件 ~L749 | `_runAgentPrompt()` 内才 `_isAgentRunActive = true` |
| 同文件 L330–331 | flag 仅在 `_emitAgentSettled()` 复位 |
| `pi-agent-core/dist/agent.js` L226–229 | `agent.prompt()` 见 `activeRun` 即抛错 |
| `modes/interactive/interactive-mode.js` ~L2539 | TUI 按 `session.isStreaming` 决定 steer 排队 vs 完整提交——scout 等待期被误判为 idle |

受害窗口 = 任何异步 `before_agent_start` handler 的时长；scout 的 side-agent 调用（`packages/pi-scout/src/side-agent.ts`，15s 超时）把窗口拉到 2–15s，是最容易触发的现实场景。注意 compaction 有自己的闸门（`_compactionAbortController` 检查 + TUI 排队），唯独 `before_agent_start` 没有。

## 上游状态

- **[#5886](https://github.com/earendil-works/pi/issues/5886)** "AgentSession settlement/continuation and assistant-tail lifecycle bugs" — **open**（`pkg:agent` `pkg:coding-agent`）。wWzZb 2026-08-24 评论精确复现了本 race（5/5 稳定）：一 fulfill 一 reject、`isStreaming=true` 但 `isIdle=true`、`waitForIdle()` 已提前 resolve、双 `agent_settled`。维护者 Dante-dan 2026-08-31 承认并发 prompt race 是独立问题、需统一生命周期方案。
- [#6744](https://github.com/earendil-works/pi/issues/6744) — 同源 race，被 `no-action` 关闭（wWzZb 在 #5886 引用）。
- [#6820](https://github.com/earendil-works/pi/issues/6820) — 相邻变体：compaction 期间 flush 队列撞 `session.prompt()` 抛 "Agent is already processing"，同样 closed NOT_PLANNED。佐证 `isStreaming`/`isIdle` 语义在多个路径上不一致。
- 0.85.1（npm pack 核对 `dist/core/agent-session.js`）：结构与 0.84.3 一致，**未修**。

## 为什么 scout 侧不修（已排除的方案）

- **hook API 无手段**：`before_agent_start` 返回值只能改 systemPrompt/加 custom message，不能中止或重排外层 prompt 流程。
- **scout 内互斥无效**：B 的 scout 返回后 B 的 prompt 流程照样继续撞 `agent.prompt`，只是换个时刻抛错。
- **让 B 跳过 scout 更糟**：B 提前到达 `agent.prompt` 会赢下 race，换成 A（首条消息）消失。
- **在 hook 里等 idle**：`waitForIdle()` 在该 race 下会提前 resolve（#5886 已证实 false settlement），不可靠；且阻塞期间用户气泡不渲染，无反馈。

结论：唯一正确修法在 pi core，scout 保持不动。

## 建议上游修法（供日后提交 PR / 跟帖参考）

`AgentSession.prompt()` 在 await `emitBeforeAgentStart` 之前就应把"prompt 流程进行中"视同 streaming：

- 置位一个流程级 flag（或提前 `_isAgentRunActive = true`），第二个 `prompt()` 落入 steer/followUp 排队路径（TUI 已默认传 `streamingBehavior: "steer"`）；
- 注意验证失败路径（model/auth 校验在置位点之后抛错时）要复位 flag；
- 排队语义下 B 会进入 A 的 run、不再触发自己的 `before_agent_start`——与现有 steer 语义一致（streaming 期间的 steer 消息本来也跳过 scout），可接受。

## 跟踪清单

- [ ] 关注 #5886 动态 / pi release notes，等待并发 prompt race 的修复落地
- [ ] 修复版本发布后升级，用 scout 场景回归验证：scouting 期间发第二条消息应进 steer 队列、消息不丢、无报错
- [ ] 验证通过后关闭本计划；若上游长期不动，再评估是否提 PR（需另行确认）
