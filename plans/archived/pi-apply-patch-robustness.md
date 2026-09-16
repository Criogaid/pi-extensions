# pi-apply-patch — 补丁应用健壮性与诊断增强

> 状态：已实施。目标是改善大型、多文件和上下文漂移时的应用体验，不改变现有 Codex-compatible patch 语法、匹配语义与默认编辑行为。

## 背景与问题

`@d3ara1n/pi-apply-patch` 在小型精确修改上表现良好，但实际使用暴露的核心工程问题是 **fail-fast**：

- `applyUpdate` 在第一个坏 chunk 就抛错，同文件后续 chunk 的失败不可见；
- prepare 循环在第一个坏文件就中断，其余文件的匹配失败全部不可见；
- 失败信息把整个 `oldLines` 全量回显进错误文本，大 hunk 失败时直接撑爆模型上下文；
- 失败只有一行错误字符串，没有位置、没有候选、没有下一步建议；
- 成功结果不体现匹配过程（规范化匹配、重复上下文、覆盖写入、排队期间源变更）。

## 关键设计决策

评估阶段否决的方案及理由（记录在此，避免重新提出）：

| 否决项 | 理由 |
|--------|------|
| dry-run/预览模式 | 现有 prepare-all-then-write-all 已保证匹配失败零落盘；对失败诊断无增量价值。freeform grammar tool 只传 patch 文本，模型无法传模式参数；暴露为独立工具或命令也没有真实消费者（模型不需要预览自己写的补丁）。 |
| `ambiguous` 状态（多候选拒绝自动选择） | 与 Codex first-match-wins 语义冲突。对重复代码块打相同补丁时多个命中是常态，确定性取第一个就是现有正确行为。 |
| 按路径排序落盘 | 写入顺序必须是 patch 声明顺序：Move 链（move a→b 再 update b）和"前序 move 改变后续 source"的 re-prepare 依赖 patch 顺序。`keys.sort()` 只是 mutation queue 的锁获取顺序。 |
| 近似候选 opt-in 恢复 | opt-in 通道无法定义（工具参数撞 grammar 限制；执行中阻塞问用户超出工具模型）。与"不猜测模型意图"原则相悖。 |
| Move 目标已存在 = conflict | fixture 010 锁定了 move 覆盖已存在目标的行为。目标已存在是 informational（overwrites 标记），只有同 patch 内多操作同源才是错误（已有去重检查）。 |
| `core/grammar|match|prepare|report/` 多级目录 | 包总量约千行，扁平结构足够。 |
| 数值置信度 | 模型消费不了分数，需要的是确定性事实：行号、差异类型、是否多候选。 |

"大段移动只能用删除+新增表达"与"全量格式化混入逻辑 patch"是 grammar 层限制，本计划不解决（不重新设计 patch 语言）。

## 实施的设计

### 双层状态

hunk 匹配状态与文件状态分开，不混在一个枚举里：

- **hunk**：`matched`（带 line / strategy / occurrences）或 `unmatched`（带 HunkFailure）；
- **文件/操作**：prepared → applied，或 rejected（match 失败 / 读取失败）、write_failed、not-applied（部分落盘后的剩余列表）。

### fail-all 验证（核心）

`planUpdate(original, chunks)` 收集**所有** chunk 的匹配结果而不是第一个失败就停；失败的 chunk 不推进 cursor，后续 chunk 从上一个成功位置继续搜索（位置信息诚实标注 searchFrom）。`applyPatch` 的 prepare 循环逐文件 try/catch，任一失败则聚合所有文件、所有 hunk 的诊断一次性抛出，零落盘。

`applyUpdate` 保留原签名与抛错行为（报告首个失败，legacy 文案），仅作兼容 API。

### hunk 级诊断（HunkFailure）

- 失败的 anchor 文本，或调整过尾随空行后的实际搜索 pattern；
- searchFrom（1-based）与 endOfFile 标记；
- 有界回显：pattern ≤6 行全显，否则首 3 + 尾 3 + `… N of M lines omitted`；
- 候选窗口（最多 2 个）：
  - **搜索范围外的精确命中**（行号早于 searchFrom，或 EOF 锚定时的任意命中）——最常见原因是 chunk 顺序错乱；
  - **最近失配**：窗口评分 ≥0.5 的最佳候选，按 trimEnd(0.95)/trim(0.9)/normalize(0.85)/collapse(0.6) 逐行打分，整行差异分类为 whitespace-only drift 或 content differences；
- **already-applied 提示**：把 newLines 当 pattern 反向 ladder 搜索，命中则提示"hunk 可能已应用过"（no-op 替换不算）。

候选与次数统计有预算上限（lines × pattern ≤ 2,000,000 次行比较），超限直接跳过并保守返回 occurrences=1。

### 成功路径的信息补充（details，不改 content 文本）

- `hunks[]`：每个 chunk 的 {hunk, line, strategy, occurrences}——strategy 来自 4 级规范化阶梯中命中的那级（exact/trim_end/trim/unicode），occurrences 统计全文件同投影下的窗口数（first-match-wins 的透明化）；
- `overwrites`：Add 覆盖已有文件、Move 目标已存在时标记（语义不变，仅告知）；
- `rematched`：写入前 re-prepare 发现源内容与验证阶段不同（如前序 move 改写）时标记——内容按 live 文本重新匹配，与 Codex 一致。

TUI 展开视图渲染这些标注（overwrites/rematched 折叠视图也显示，安全相关）；RPC/print/json 的 details 是纯 JSON。

### 落盘失败部分报告

保持"原子性诚实"：预校验失败零写入；落盘中途失败报告 Completed operations + **Not applied 列表** + 当前需检查的路径，不伪造回滚。

### 模块结构

```text
src/core/types.ts       + MatchStrategy / HunkMatchInfo / HunkCandidate / HunkFailure / HunkOutcome
src/core/matcher.ts     seekSequence（语义未动）+ PASSES / seekPass / strategyOf 导出
src/core/diagnostics.ts 候选搜索、occurrences、already-applied、diagnoseContext（纯函数）
src/core/update.ts      planUpdate（fail-all 规划器）+ applyReplacements + applyUpdate（legacy）
src/report.ts           renderRejection：有界聚合报告（纯文本，无 TUI 依赖）
src/apply.ts            fail-all prepare、UnmatchedUpdateError、rematched/overwrites 捕获
src/render.ts           details 透传 + TUI 标注
```

## 语义兼容承诺

- 匹配：first-match-wins、4 级规范化阶梯、cursor 前向推进、尾随空行重试——全部未动；
- 写入：patch 声明顺序、mutation queue 锁顺序、写入前 re-prepare——未动；
- Move/Add 覆盖、workspace 边界、symlink 语义、dedupe 检查——未动；
- 错误前缀 `apply_patch verification failed:` / `apply_patch failed:`、部分落盘文案结构——保留（新增 Not applied 列表）；
- 成功 content 文本与 Codex summary 格式——未动；
- 25 个 upstream fixture、freeform/function 双协议、历史回放——全部保持通过。

## 验证

- 75 项单测 + 4 项集成全过；`npx tsc --noEmit` 干净；
- 新增覆盖：fail-all 聚合（多文件多 hunk 一次报告 + 零写入）、失败后继续搜索、策略/occurrences 上报、whitespace/content 候选分类、搜索范围外命中、already-applied、预算上限、回显与 hunk 列表上限、Not applied 列表、overwrites/rematched/hunks details、TUI 标注渲染；
- 待用户 `/reload` 后用真实模型验收：小 patch、多文件 patch、上下文漂移 patch 各一，确认错误输出可定位、可一次修复。
