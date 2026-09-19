# Hashline Write 与统一 Action Fusion 设计书

> 状态：当前工作树实现基线 + 设计审阅稿

> 本文面向无法直接读取仓库的第三方模型，描述当前 Hashline 插件已经实现的工具、统一 Action Fusion、同名 `write`、共同提交层、生命周期、代码契约、验证证据和剩余风险。

> 文中“当前实现”表示当前工作树已经存在并通过测试的代码；“后续增强/剩余风险”表示尚未完成或尚未承诺的部分。本文不是发布版本或 commit 说明；当前改动尚未提交或发布。

> 阅读优先级：当前代码基线和第 18 节实施进度优先于前文的“未来设计”“未决问题”和阶段草案。前文保留这些内容，是为了让审阅者理解决策来源；已经完成的项目在第 18 节重新列出。

## 1. 背景与目标

当前插件是 `@d3ara1n/pi-hashline-edit`，源码位于：

```text
packages/pi-hashline-edit/
```

插件当前接管：

- `read`
- `grep`
- `edit`
- `replace`
- `write`

`write` 是 Hashline 直接注册的同名工具；不再使用 `composeSolPi`、共享 Action Fusion 包、注册拦截或跨插件加载顺序。

当前实现已经包含 `write`，本文后续仍保留设计理由和未决风险，供第三方审阅。

```text
edit / replace / write
```

统一能力开关为：

```jsonc
{
  "hashlineEdit": {
    "actionFusion": false
  }
}
```

语义：

```text
actionFusion = false
  -> edit、replace、write 都不暴露 then_run
  -> 不创建 Action Fusion executor
  -> 显式传入 then_run 时验证失败
  -> 不执行任何后置命令

actionFusion = true
  -> edit、replace、write 统一暴露 then_run
  -> 共用一个 Action Fusion executor
  -> 共用授权策略和外层文件队列
```

不设计 `editActionFusion`、`replaceActionFusion`、`writeActionFusion` 这类分散开关。

## 2. 设计原则

### 2.1 Hashline 本地实现

Action Fusion 和未来的 write 都直接实现于 Hashline 包内部：

```text
Hashline extension
  -> own action-fusion.ts
  -> own write-tool.ts
  -> own queues / validation / result handling
```

不使用 SoL-Pi 的共享库，不修改 SoL-Pi，不使用工具包装器，也不依赖跨插件加载顺序。

### 2.2 保留现有工具契约

必须继续保留：

- `read` 的 Hashline 输出格式；
- Hashline anchor 验证；
- `edit` 的批量操作语义；
- `replace` 的 regex/literal 语义；
- 当前 mutation queue；
- `write` 未来应尽量兼容 Pi 原生 `{ path, content }` 调用格式；
- `write` 不应偷偷改变为 anchor patch 工具。

### 2.3 mutation 优先，command 后置

所有工具都遵循：

```text
validate
  -> prepare mutation in memory
  -> commit mutation
  -> obtain final file state
  -> optional then_run
```

命令失败不回滚已经成功的 mutation。

### 2.4 不把“fresh anchors”当成永久状态

`edit` / `replace` 返回的 anchors 只代表 mutation 完成时的文件内容。

如果 formatter 或 `then_run` 又修改了文件，之前的 anchors 必须标记为 stale，要求重新 `read`。

## 3. 当前代码现状

### 3.1 配置

当前 `HashlineEditConfig` 包含：

```ts
export interface HashlineEditConfig {
  enabled: boolean;
  actionFusion: boolean;
  hashLen: number;
  shiftRadius: number;
}
```

默认配置：

```ts
const DEFAULT_CONFIG: HashlineEditConfig = {
  enabled: true,
  actionFusion: false,
  hashLen: 4,
  shiftRadius: 15,
};
```

配置解析为显式 opt-in：

```ts
return {
  enabled: typeof raw.enabled === "boolean"
    ? raw.enabled
    : DEFAULT_CONFIG.enabled,
  actionFusion: raw.actionFusion === true,
  hashLen: /* 2..8 or default */,
  shiftRadius: /* non-negative or default */,
};
```

因此缺少、非 boolean 或任何非 `true` 值都不会打开 Action Fusion。

### 3.2 Extension 初始化

当前入口逻辑简化后如下：

```ts
export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();
  const state = getState();
  state.config = loadConfig(cwd);

  if (state.config.enabled) {
    const fusion = state.config.actionFusion
      ? createActionFusionExecutor()
      : undefined;

		pi.registerTool(makeReadOverride(cwd));
		pi.registerTool(makeEditOverride(cwd, fusion));
		pi.registerTool(makeGrepOverride(cwd));
		pi.registerTool(makeReplaceTool(cwd, fusion));
		pi.registerTool(makeWriteTool(cwd, fusion));
	}
}

关键点：

- 一个 Hashline extension instance 只创建一个 Fusion executor；
- `edit`、`replace` 和 `write` 收到同一个 executor；
- `enabled: false` 时不注册 Hashline 工具；
- 当前同名 `write` 已由 Hashline 注册，默认保留完整内容创建/覆盖语义。
这里的 `write` 已经接入；`then_run` 是否可用只由统一的 `actionFusion` 决定。

## 4. 当前 edit 生命周期

当前 `edit` 的执行入口可以抽象为：

```ts
async execute(
  toolCallId,
  params,
  signal,
  onUpdate,
  ctx,
) {
  const { then_run, ...mutationParams } = params;

  if (!fusion && then_run !== undefined) {
    throw new Error(
      "then_run is unavailable because hashlineEdit.actionFusion is disabled",
    );
  }

  const mutate = () => {
    const path = mutationParams.path;
    const absPath = canonicalPath(cwd, path);

    if (!mutationParams.edits?.length) {
      return errResult(`Edit ${path}: edits is empty or missing.`);
    }

    return withFileMutationQueue(absPath, () =>
      runHashline(absPath, path, mutationParams.edits, signal),
    );
  };

  if (!fusion) return mutate();

  return fusion({
    toolName: "edit",
    toolCallId,
    absolutePath: canonicalPath(ctx.cwd, mutationParams.path),
    thenRun: then_run,
    mutate,
    signal,
    ctx,
  });
}
```

`runHashline` 的生命周期：

```text
read current file
  -> if aborted: return error
  -> translate input operations
  -> apply all operations in memory
  -> verify all anchors
  -> if any failure: return error, do not write
  -> if aborted: return error
  -> write resulting content
  -> normalize only for diff generation
  -> generate diff / patch
  -> generate updated anchors for touched lines
  -> return AgentToolResult
```

关键行为：

- 所有 batch edits 先在内存中验证和应用；
- 某个 anchor 失败时整个 batch 不写盘；
- edit 返回修改区域 fresh anchors；
- 当前底层最终写入使用 `writeFile`，不是临时文件 + atomic rename；
- 当前 edit 会在 read 后和 write 前检查取消，但同步计算阶段不可中断；
- mutation queue 覆盖 read-modify-write 整个过程。

## 5. 当前 replace 生命周期

当前 `replace` 的执行入口可以抽象为：

```ts
async execute(
  toolCallId,
  params,
  signal,
  onUpdate,
  ctx,
) {
  const { then_run, ...mutationParams } = params;

  if (!fusion && then_run !== undefined) {
    throw new Error(
      "then_run is unavailable because hashlineEdit.actionFusion is disabled",
    );
  }

  const state = getState();
  const path = mutationParams.path;
  const absPath = canonicalPath(cwd, path);

  const mutate = () =>
    withFileMutationQueue(absPath, () =>
      runReplace(
        absPath,
        path,
        mutationParams,
        state.config.hashLen,
        signal,
      ),
    );

  if (!fusion) return mutate();

  return fusion({
    toolName: "replace",
    toolCallId,
    absolutePath: canonicalPath(ctx.cwd, path),
    thenRun: then_run,
    mutate,
    signal,
    ctx,
  });
}
```

`runReplace` 的生命周期：

```text
validate find
  -> read current file
  -> if aborted: fail before apply
  -> construct regex
  -> count matches with maxMatches guard
  -> reject zero matches
  -> calculate complete new content in memory
  -> if aborted: fail before write
  -> write if content changed
  -> normalize only for diff generation
  -> generate diff / patch / changed-region anchors
  -> return result
```

关键行为：

- regex 构造失败不写盘；
- 匹配数超过 `maxMatches` 不写盘；
- 0 matches 不写盘；
- literal 模式用 function replacement，避免 `$` 被误解释；
- regex 模式保留 `$1`、`$&` 等替换语义；
- replace 返回 changed region 的 fresh anchors；
- 当前最终写入也是直接 `writeFile`。

## 6. 当前 Action Fusion 实现

当前 executor 的公开概念如下：

```ts
export interface ThenRunInput {
  command: string;
  timeout?: number;
}

type CommandRunner = (
  toolCallId: string,
  input: ThenRunInput,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
) => Promise<string>;

export type ActionFusionAuthorizer = (input: {
  toolName: "edit" | "replace" | "write";
  absolutePath: string;
  cwd: string;
  thenRun: ThenRunInput;
}) => void | Promise<void>;
```

当前 `createActionFusionExecutor`：

```ts
export function createActionFusionExecutor(
  commandRunner = defaultCommandRunner,
  authorize?: ActionFusionAuthorizer,
) {
  const queueTails = new Map<string, Promise<void>>();

  async function withQueue<T>(
    path: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const key = await canonicalQueueKey(path);
    const previous = queueTails.get(key) ?? Promise.resolve();

    let release!: () => void;
    const owned = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => owned);
    queueTails.set(key, tail);

    await previous;
    try {
      return await work();
    } finally {
      release();
      if (queueTails.get(key) === tail) {
        queueTails.delete(key);
      }
    }
  }

  return async function execute<TDetails>({
    toolCallId,
    toolName,
    absolutePath,
    thenRun,
    mutate,
    signal,
    ctx,
  }: {
    toolCallId: string;
    toolName: "edit" | "replace" | "write";
    absolutePath: string;
    thenRun: ThenRunInput | undefined;
    mutate: () => Promise<AgentToolResult<TDetails>>;
    signal: AbortSignal | undefined;
    ctx: ExtensionContext;
  }): Promise<AgentToolResult<TDetails>> {
    if (thenRun !== undefined) {
      validateThenRun(thenRun);
      await authorize?.({
        toolName,
        absolutePath,
        cwd: ctx.cwd,
        thenRun,
      });
    }

    return withQueue(absolutePath, async () => {
      signal?.throwIfAborted();

      let mutationResult: AgentToolResult<TDetails>;
      try {
        mutationResult = await mutate();
      } catch (error) {
        if (thenRun !== undefined) {
          throw new Error(
            `mutation failed; [then_run:skipped] ${errorText(error)}`,
            { cause: error },
          );
        }
        throw error;
      }

      if (thenRun === undefined) return mutationResult;

      try {
        signal?.throwIfAborted();
        await assertUnchangedBeforeCommand(absolutePath);
        signal?.throwIfAborted();

        const output = await commandRunner(
          toolCallId,
          thenRun,
          signal,
          ctx,
        );

        return {
          ...mutationResult,
          content: [
            ...mutationResult.content,
            {
              type: "text",
              text: output
                ? `[then_run:succeeded]\n${output}`
                : "[then_run:succeeded]",
            },
          ],
        };
      } catch (error) {
        throw new Error(
          `mutation completed; [then_run:failed] ${errorText(error)}`,
          { cause: error },
        );
      }
    });
  };
}
```

当前 Action Fusion 的重要保证：

- `then_run` 在进入 mutation queue 前验证；
- 授权回调在 mutation 前执行；
- 取消在进入 work 后检查；
- mutation 失败跳过 command；
- command 失败不回滚 mutation；
- command 使用 Pi 的公共 Bash API；
- command 使用相同 AbortSignal；
- Action Fusion queue 与 Hashline 现有 mutation queue 分离；
- 同一文件的 mutation + command 序列化。

当前未完成的能力：

- `toolName` 目前仍然是 `"edit" | "replace"`，未来需要增加 `"write"`；
- command 执行后没有完整确认目标文件是否被 command 修改；
- command 修改文件后，mutation 结果中还没有结构化的 `anchorsStale` 字段；
- 进入 queue 时使用的 path 必须和 mutation queue 使用的 path 统一，避免 `cwd` 不一致导致锁 key 不同。

## 7. 当前 edit / replace 生命周期中的不一致

### 7.1 错误返回方式不一致

`edit` 的部分验证错误通过 `errResult(...)` 返回；`replace` 的很多错误直接 `throw new Error(...)`。

这目前可以工作；当前 `write` 已经采用相同的阶段分类，但发布后后处理的结构化状态仍需继续完善：

```text
validation
read
prepare
commit
post-process
command
cancellation
partial-publication
```

建议最终都让工具层返回一致的 Pi tool error 形态，同时保留 `cause` 和阶段标识。

### 7.2 历史方案：早期“当前写入不是原子发布”评估

以下片段保留为历史分析，描述的是共同 `commitFile` 接入前的直接 `writeFile` 路径，不是当前实现：

```ts
await writeFile(absPath, nextText);
```

当时它不能保证：

- 进程中断时原文件不被截断；
- 并发发布不覆盖其他 writer；
- Windows 下替换语义稳定；
- 目标文件被外部进程替换时仍然安全。

当前实现已改为：创建使用同文件系统的 `link(temp, target)` no-replace 发布，覆盖使用完整临时文件后的 `rename(temp, target)`，并在发布前处理 symlink、普通文件类型、hardlink 和 revision 约束。跨平台差异与未运行平台由第 20 节矩阵记录。

### 7.3 queue path 来源不完全统一

mutation closure 当前使用 extension 初始化时的 `cwd`：

```ts
const absPath = canonicalPath(cwd, path);
```

Fusion 调用当前使用 `ctx.cwd`：

```ts
absolutePath: canonicalPath(ctx.cwd, path)
```

正常使用时二者应相同，但严格设计应在工具入口只解析一次：

```ts
const absolutePath = canonicalPath(cwd, input.path);
```

然后将同一个 `absolutePath` 传给：

- mutation queue；
- Fusion queue；
- authorizer；
- metadata；
- result formatting。

### 7.4 command 后 anchors 的 freshness：当前实现与剩余边界

当前流程是：

```text
mutation -> generate anchors -> then_run
```

但 `then_run` 可能修改文件。

应改为：

```text
mutation
  -> optional formatter
  -> generate provisional anchors
  -> then_run
  -> compare final file state
  -> anchors valid or stale
```

如果 command 修改了目标文件，返回结果应包含：

```ts
{
  anchorsStale: true,
  reason: "then_run modified the target file; re-read before the next edit"
}
```

## 8. write 契约与剩余增强设计

### 8.1 工具职责

未来 Hashline write 不是 anchor patch 工具，而是完整内容写入工具：

```json
{
  "path": "src/example.ts",
  "content": "const value = 1;\n"
}
```

它负责：

- 创建新文件；
- 在明确策略下覆盖已有文件；
- 清理被复制进来的 Hashline display prefix；
- 保持 BOM / 换行 / 文件尾换行策略；
- 原子提交；
- 生成最终 revision / fresh anchors；
- 可选执行 `then_run`。

它不负责将整个 write 内容逐行拿 anchor 做 patch 验证。

### 8.2 推荐 schema

统一 Action Fusion 后的 schema 概念：

```ts
const writeSchema = Type.Object({
  path: Type.String({
    description: "Path to the file to write",
  }),
  content: Type.String({
    description: "Complete file content",
  }),
  mode: Type.Optional(
    Type.Union([
      Type.Literal("create"),
      Type.Literal("overwrite"),
    ]),
  ),
  expectedRevision: Type.Optional(
    Type.String({
      description: "Required revision when protecting an existing file",
    }),
  ),
  ...(actionFusion
    ? {
        then_run: createThenRunSchema(
          "Command to run after write succeeds; failure does not roll back the write.",
        ),
      }
    : {}),
});
```

但这里有一个兼容性问题：原生 Pi write 通常只要求 `path` 和 `content`，不要求 `mode` 或 `expectedRevision`。

推荐采用渐进兼容策略：

```text
文件不存在:
  默认允许创建

mode = create:
  文件存在时失败，不覆盖

mode = overwrite + expectedRevision:
  revision 匹配才覆盖

已有文件且没有 expectedRevision:
  是否允许原生兼容覆盖，需要产品决定
```

严格安全模式可以拒绝“已有文件 + 无 expectedRevision”；兼容模式可以暂时允许，但应该明确它是非锚定覆盖。

### 8.3 Prefix stripping

借鉴 oh-my-pi：如果模型把 Hashline read 输出直接放进 write content，则只在高置信度下移除展示前缀。

输入：

```text
1#ABCD│const a = 1;
2#EFGH│const b = 2;
```

写入：

```text
const a = 1;
const b = 2;
```

必须避免误删普通代码中的 `#`：

- 只识别当前 Hashline 使用的 anchor 格式；
- 最好要求所有或绝大多数非空行都符合格式；
- 混合内容不自动剥离，宁可要求重新提交；
- 返回结果中记录 `strippedHashlinePrefixes`。

### 8.4 路径安全

借鉴 opencode-better-hashline：

```text
resolve input path
  -> verify workspace boundary
  -> realpath existing target or nearest existing parent
  -> reject symlink escape
  -> reject path outside workspace
  -> reject unsafe drive/UNC roots where applicable
```

对于不存在目标：

```text
目标文件不存在
  -> 找到最近存在的父目录
  -> realpath 父目录
  -> 验证父目录在 workspace 内
  -> 再允许创建
```

需要决定是否把相同 workspace jail 推广到当前 edit/replace。若 write 单独拥有 jail，而 edit/replace 仍然接受 workspace 外绝对路径，三者边界会不一致。

### 8.5 Commit 生命周期

当前 `commitFile` 的生命周期：

```text
inspect target with lstat/stat/realpath
  -> validate mode, expectedRevision, regular-file and hardlink policy
  -> create sibling temporary directory
  -> write complete content with private temporary mode
  -> fsync and close temporary file
  -> mode=create: link(temp, target) without replacement
  -> mode=overwrite: rename(temp, target) without deleting old target first
  -> POSIX: fsync containing directory
  -> compute final revision
  -> remove only this call's temporary directory
```

publication 只表达本次目标发布事实：

```text
NOT_PUBLISHED
  校验、临时文件准备或发布前失败；不表示外部进程没有其他变化

PUBLISHED
  目标发布已确认；后续 revision、目录同步或临时资源清理失败也保持 PUBLISHED

UNKNOWN
  发布原语返回无法确认的结果；不自动重试、不回滚、不执行尚未开始的 command
```

创建与替换使用不同的发布原语。创建竞争由 `link` 的 no-replace 语义决定，不能由发布前存在性检查代替。覆盖不先删除目标；如果替换原语失败且结果无法确认，返回 `UNKNOWN`。

### 8.6 最终 anchors

写入后不能直接对内存中的 `content` 生成最终 anchors，因为：

- 换行可能被恢复；
- BOM 可能被保留；
- formatter 可能修改内容；
- 原子发布可能发生内容转换。

正确顺序：

```text
commit
  -> optional formatter
  -> read final bytes from disk
  -> normalize only for hash calculation as existing Hashline requires
  -> generate revision and line anchors
  -> return result
```

结果概念：

```ts
{
  content: [
    {
      type: "text",
      text: "Wrote src/example.ts.\nFresh anchors are available in the result.",
    },
  ],
  details: {
    path: "src/example.ts",
    revision: "...",
    firstChangedLine: 1,
    lastChangedLine: 2,
    strippedHashlinePrefixes: false,
    anchorsStale: false,
  },
}
```

不建议默认返回整个大文件内容，避免 token 膨胀。可以只返回 revision 和 changed range，后续仍然由 `read` 获取完整 anchors。

## 9. 统一的三工具生命周期

最终目标：

```text
                    +-----------------------------+
                    | actionFusion capability     |
                    | false: no then_run          |
                    | true: shared executor       |
                    +--------------+--------------+
                                   |
          +------------------------+------------------------+
          |                        |                        |
        edit                    replace                   write
          |                        |                        |
          +------------ canonical absolute path ----------+
                                   |
                    +--------------v--------------+
                    | Action Fusion queue         |
                    | mutation + optional command |
                    +--------------+--------------+
                                   |
                    +--------------v--------------+
                    | withFileMutationQueue       |
                    | read-modify-write / commit  |
                    +--------------+--------------+
                                   |
                    +--------------v--------------+
                    | final file state            |
                    | diff / anchors / revision   |
                    +--------------+--------------+
                                   |
                    +--------------v--------------+
                    | optional then_run           |
                    | stale check                 |
                    +-----------------------------+
```

统一伪代码：

```ts
async function executeMutationTool(input, signal, ctx) {
  const { then_run, ...mutationInput } = input;
  const absolutePath = canonicalPath(extensionCwd, mutationInput.path);

  if (then_run !== undefined) {
    if (!fusion) throw actionFusionDisabledError();
    validateThenRun(then_run);
    await authorize({
      toolName,
      absolutePath,
      cwd: ctx.cwd,
      thenRun: then_run,
    });
  }

  const mutate = () => withFileMutationQueue(
    absolutePath,
    async () => {
      checkCancellation(signal);
      const before = await inspectFile(absolutePath);
      const prepared = await prepareMutation(before, mutationInput);
      checkCancellation(signal);
      await commitMutation(absolutePath, prepared);
      const finalState = await readFinalState(absolutePath);
      return buildMutationResult(before, finalState, prepared);
    },
  );

  if (!fusion) return mutate();

  return fusion({
    toolName,
    toolCallId,
    absolutePath,
    thenRun: then_run,
    mutate,
    signal,
    ctx,
  });
}
```

## 10. 外部实现可参考点

### 10.1 oh-my-pi

源码：

```text
https://github.com/can1357/oh-my-pi/blob/d7383294/packages/coding-agent/src/tools/write.ts
```

可参考：

- `stripHashlinePrefixes` / write content prefix cleanup；
- 写入后更新 Hashline snapshot；
- 写入结果生成新的 Hashline header；
- 对 read 输出被模型原样复制的兼容处理。

不应直接复制：

- SQLite/session store；
- LSP formatter / diagnostics 集成；
- oh-my-pi 专用 URL、SSH、approval、plan mode；
- 其完整 runtime 生命周期。

### 10.2 opencode-better-hashline

协议：

```text
https://github.com/makcimbx/opencode-better-hashline/blob/master/docs/protocol.md
```

可参考：

- create-only write；
- no-clobber；
- workspace path identity；
- 真实路径和 symlink 边界；
- staged publication；
- 历史讨论中的 `PARTIAL_PUBLICATION`；当前单文件发布协议使用 `NOT_PUBLISHED`、`PUBLISHED`、`UNKNOWN`。

关键取舍：它把新文件创建和已有文件 edit 分开，不让 write 绕过 edit 的 snapshot 约束。

### 10.3 opencode-hashline

源码：

```text
https://github.com/izzzzzi/opencode-hashline/blob/088c22e0/src/hashline-tool.ts
```

可参考：

- 先内存应用 Hashline edit；
- 失败时不写盘；
- 对现有文件和缺失文件采用不同策略；
- 写入后明确返回需要重新读取的提示。

### 10.4 oh-my-opencode

源码：

```text
https://github.com/code-yeongyu/oh-my-opencode/blob/fbcdeab6/src/tools/hashline-edit/hashline-edit-executor.ts
```

可参考：

- 统一 edit executor；
- 删除和 rename 的生命周期；
- formatter 在 mutation 后执行；
- formatter 改变文件时重新读取并生成 metadata。

## 11. 未决问题与第三方模型需要判断的事项

### A. write 是否真正接管原生工具

选项：

1. 保持原生 write，Hashline 只接管 edit/replace；
2. Hashline 注册同名 write，完整接管；
3. 新增独立 `hashline_write`，原生 write 保留。

需要判断：

- 是否必须兼容现有 agent 的原生 `{ path, content }` 请求；
- 是否能接受 Hashline 改变 write 的错误和覆盖语义；
- 是否允许同时存在两个 write 工具；
- 是否有工具注册冲突或加载顺序风险。

### B. 已有文件覆盖是否必须 revision

选项：

1. 完全保持原生覆盖语义；
2. 已有文件必须携带 `expectedRevision`；
3. 默认兼容覆盖，但提供 `mode` / `expectedRevision` 严格模式。

建议第三方模型重点评估：安全性、模型兼容性和迁移成本。

### C. 原子提交是否推广到 edit/replace

选项：

1. 只给 write 加 atomic commit；
2. 抽出共同 `commitFile`，三者统一；
3. 暂时保持直接 `writeFile`，只补 write。

如果只改 write，三个 mutation 工具的 crash safety 会不一致。

### D. workspace jail 是否统一

当前 Hashline edit/replace 已有路径 canonicalization，但不是完整 workspace jail 设计。

需要判断：

- write 单独保护是否足够；
- 是否应该让所有 Hashline mutation 工具拥有相同路径边界；
- 是否会破坏当前用户通过绝对路径编辑外部文件的行为。

### E. command 修改文件后的结果

选项：

1. 不检查，文档要求用户自行重新 read；
2. command 后 hash compare，变化时返回 `anchorsStale`；
3. command 后自动重新生成 anchors；
4. command 修改目标文件时视为 Fusion 失败。

推荐选项 2：不伪造新 anchors，但明确告诉调用方需要重新 read。

### F. formatter 是否属于 Hashline write

当前 Hashline 没有统一 formatter 生命周期。

需要决定：

- 完全不集成 formatter；
- 允许未来注入 formatter；
- formatter 是否属于 mutation queue 内部；
- formatter 失败是否保留原始写入结果；
- formatter 修改后是否重新生成 anchors。

### G. prefix stripping 的误识别边界

需要覆盖：

- 所有行都有 `LINE#HASH│`；
- 只有部分行有前缀；
- 普通 Markdown、shell、Python 注释中的 `#`；
- CRLF；
- 空行；
- 文件头 `[path#revision]`；
- 混合真实代码和复制的 Hashline 行。

原则：误剥离比不剥离更危险，低置信度时应拒绝自动清理或保持原文。

### H. actionFusion 的生命周期是否包含 command 后校验

当前 Action Fusion 只在 command 前做内容 guard：

```text
mutation complete
  -> hash check around command start
  -> command
  -> return mutation result + command output
```

未来需要判断是否升级为：

```text
mutation complete
  -> capture baseline
  -> command
  -> compare final state
  -> return anchors valid/stale
```

### I. 写入权限和文件权限

需要决定：

- 新文件权限使用系统默认 umask；
- 覆盖文件保留原权限；
- executable bit 是否保留；
- symlink 本身是否允许替换；
- Windows ACL 是否只依赖原子 rename。

## 12. 建议的实施顺序

### Phase 0：统一现有 edit/replace 生命周期

先不接管 write，先完成：

- 统一 absolute path 解析；
- 统一 mutation 错误阶段；
- 明确 Action Fusion command 后 freshness；
- 明确是否采用 atomic commit；
- 补齐相关测试。

### Phase 1：实现本地 write，不启用 then_run

新增：

```text
src/pi/write-tool.ts
```

先实现：

- `{ path, content }`；
- prefix stripping；
- canonical path；
- workspace/symlink 策略；
- create / overwrite 语义；
- atomic commit；
- final anchors/revision；
- 不执行 command。

但 schema 是否显示 `then_run` 仍然完全由全局 `actionFusion` 决定。

### Phase 2：将 write 接入统一 Action Fusion

扩展：

```ts
toolName: "edit" | "replace" | "write";
```

复用：

- 一个 executor；
- 一个 authorizer；
- 一个外层 queue；
- 相同取消和错误语义。

### Phase 3：command 后 freshness（已实现基础版本，仍有边界）

对 edit、replace、write 统一：

- 捕获 mutation 后 baseline；
- command 后检查文件内容；
- 文件变化时返回 `anchorsStale`；
- 不伪造过期 anchors。

### Phase 4：决定是否推广 atomic commit / workspace jail

根据第三方审阅结果决定是否统一到所有 mutation 工具。

## 13. 必须覆盖的测试

### Action Fusion 统一开关

- 默认关闭时三个工具都没有 `then_run`；
- 开启时三个工具都有 `then_run`；
- 关闭时手动传入 `then_run` 失败；
- `enabled: false` 时扩展完全不注册工具；
- edit、replace、write 使用同一个 executor。

### Mutation 生命周期

- mutation 失败不运行 command；
- command 失败不回滚 mutation；
- command timeout 不重新执行 mutation；
- queue 等待期间取消不写盘；
- mutation 前取消不写盘；
- mutation 后、command 前取消不运行 command；
- command 执行期间取消传递给 runner。

### Queue

- 同文件 edit/edit 串行；
- 同文件 replace/replace 串行；
- 同文件 edit/replace 串行；
- 同文件 write/edit 串行；
- 不同文件可以并发；
- 相对路径、绝对路径、symlink alias 使用相同 queue key；
- 缺失文件使用最近存在父目录归一化；
- executor 完成后 queue tail 清理。

### Write

- 新文件创建；
- `mode: create` 遇到已有文件失败且不覆盖；
- expectedRevision 匹配时覆盖；
- expectedRevision 不匹配时不覆盖；
- 临时文件失败不损坏目标；
- Windows / POSIX 路径；
- symlink escape 被拒绝；
- workspace 外路径被拒绝；
- BOM 保留；
- CRLF 保留；
- 无尾换行保留；
- Hashline display prefix 正确清理；
- 普通注释中的 `#` 不被误清理；
- formatter 改动后 anchors 来自最终内容；
- command 改动后返回 stale 状态。

## 14. 当前验证证据

本段是共同提交层接入前的历史验证记录；当前完整结果见第 20 节：

```text
npm run typecheck
  -> passed

node --test packages/pi-hashline-edit/src/core/*.test.ts packages/pi-hashline-edit/src/pi/*.test.ts
  -> 109 passed
  -> 0 failed
  -> 0 cancelled
```
```

测试覆盖已经包括：

- schema 默认关闭 / 开启；
- edit、replace、write 共享 executor；
- mutation failure；
- command failure；
- cancellation；
- 真实本地 Bash runner；
- command 修改目标后的 stale freshness；
- write 默认创建/覆盖；
- `mode`、`expectedRevision` 和 revision；
- 原有 Hashline edit/replace 回归；
- CRLF、anchors、regex、diff、queue 相关行为。

当前 write 已经实现并有独立测试；跨平台发布边界和发布后后处理状态仍列在剩余风险中。

## 15. 审阅问题与已采纳结论

请重点回答以下问题：

以下问题已经由项目决策确定，答案和实施边界见第 17、18 节；保留此列表是为了让第三方模型复核决策是否自洽。

1. 是否应该由 Hashline 直接接管名为 `write` 的工具，还是新增 `hashline_write`？
2. 如果接管 `write`，是否应保持 Pi 原生 `{ path, content }` 的无 revision 兼容性？
3. 是否推荐“兼容覆盖 + 可选 expectedRevision”，还是“已有文件必须 expectedRevision”？
4. `opencode-better-hashline` 的 create-only / no-clobber 语义是否适合新文件创建？
5. `oh-my-pi` 的 prefix stripping 是否应该移植，误识别风险如何控制？
6. 当前 edit/replace 是否应该先统一错误协议，再实现 write？
7. atomic commit 是否应只用于 write，还是抽成三种 mutation 工具共同使用？
8. workspace jail 是否应统一应用于 edit、replace、write？
9. `then_run` 后检查文件变化、返回 `anchorsStale` 是否优于自动重新读取？
10. formatter 是否应属于 write 的生命周期，还是应该留给外部 Action Fusion command？
11. 当前双层 queue：Action Fusion queue + `withFileMutationQueue` 是否合理，是否存在死锁或锁粒度问题？
12. 是否存在遗漏的生命周期阶段、异常状态或部分发布场景？

## 16. 一句话架构结论

目标不是把三个外部项目简单拼接，而是：

```text
Hashline 负责 anchors 和 mutation 语义
+ opencode-better-hashline 负责安全发布边界
+ oh-my-pi 负责 read 输出兼容和写后状态刷新
+ SoL-Pi 的 Action Fusion 负责统一的 mutation -> command 生命周期
```

其中 `actionFusion` 必须是统一开关：所有被 Hashline 接管的 mutation 工具一起开启或一起关闭 `then_run`。

## 17. 已采纳的第三方审阅决策（当前基线）

以下决策覆盖本文前面的候选项，后续实现以此为准：

- Hashline 直接接管同名 `write`，不再提供 `hashline_write`，也不继续扩展 `composeSolPi`。
- 默认保留 Pi 基本调用习惯：`{ path, content }` 默认允许创建或覆盖。
- `expectedRevision` 可选；一旦提供，必须严格匹配。
- `mode: "create"` 使用 create-only / no-clobber；不把 create-only 作为全部 write 的语义。
- 首版不自动剥离 Hashline display prefix；未来只能通过显式内容格式选项启用。
- 首版不内置 formatter；formatter 只能通过显式 `then_run` 参与。
- workspace path 策略统一实现，但严格 workspace 限制由用户显式启用，首版不默认收紧现有外部路径能力。
- 抽出共同 `commitFile`，目标是 edit、replace、write 三者统一使用。
- `actionFusion` 是三种 mutation 工具统一的 `then_run` 开关。
- command 结束后检查文件 freshness；文件变化时返回 stale，不默认重新输出整份 anchors，也不把正常文件变化判定为 command failure。
- 发布状态、command 状态、freshness 必须分开表达，不能只用一个工具成功/失败布尔值。
- 双层 queue 暂时保留，并固定锁顺序为 Action Fusion queue 外层、mutation queue 内层。

### 17.1 对原文中一个误判的修正

本文早先担心 `edit` 的 `errResult` 可能返回普通错误结果，导致 Fusion 继续执行 command。当前实际 Hashline 源码中的 `errResult` 定义为：

```ts
function errResult(text: string): never {
  throw new Error(text);
}
```

因此当前 edit 的验证失败会通过 throw 进入 executor 的 catch，不会正常返回后继续运行 `then_run`。该行为已经有源码注释和回归测试支持。

仍需修复的真实问题不是 `errResult`，而是：

- commit 已成功后，diff / anchors / final-read 后处理失败时，不应笼统报告为“mutation 未发生”；
- command 执行后需要报告目标文件 freshness；
- 所有 mutation 工具需要使用同一个 canonical absolute path；
- write 加入后 executor 的 `toolName` 需要扩展为 `"edit" | "replace" | "write"`。

### 17.2 当前阶段边界

阶段 0 必须先完成现有 edit/replace 与 Fusion 的契约修正，然后才能实现共同 `commitFile`。

阶段 0 不应提前加入：

- 自动 prefix stripping；
- 内置 formatter；
- 默认 workspace jail；
- 强制 expectedRevision；
- 第二个 Hashline write 工具名；
- 独立的 write Action Fusion 开关。

## 18. 实施进度（基于当前工作树）

已完成：

- 阶段 0 的统一路径：edit、replace 和 Fusion 使用一次解析的 canonical absolute path。
- Action Fusion command 前保存 mutation baseline，command 后检查 freshness。
- publication、command、freshness 三维状态与结构化异常。
- 共同 `file-commit.ts` 已由 edit、replace、write 统一使用。
- 创建与替换使用不同发布原语：创建 `link(temp, target)` no-replace；覆盖 `rename(temp, target)`，不先删除旧目标。
- 发布前解析 symlink，保留有效 symlink；拒绝 dangling/unresolvable symlink、非普通文件和多硬链接目标。
- 临时文件完整写入并 `fsync` 后才发布；POSIX 发布后同步父目录；Windows 不宣称目录持久性保证。
- 发布后 revision、目录同步或临时资源清理失败仍保留 `PUBLISHED`；发布结果无法确认时为 `UNKNOWN`。
- write 默认保留 `{ path, content }` 的创建/覆盖语义，支持 `mode` 和可选 `expectedRevision`。
- write 与 edit、replace 共用同一个 Action Fusion executor。
- write 不自动剥离 `LINE#HASH│` 前缀，不内置 formatter。
- 严格 workspace jail 仍是显式后续模式，不默认收紧现有外部路径能力。

当前验证：

```text
npm run typecheck
  passed
node --test packages/pi-hashline-edit/src/core/*.test.ts packages/pi-hashline-edit/src/pi/*.test.ts
  latest result recorded in Section 20
git diff --check
  passed
```

仍需继续处理：

- macOS/APFS 和 Linux 本地文件系统实测；
- Windows 上 symlink 权限开启后的真实链接测试；
- Windows ReplaceFile/ACL/只读共享语义的专门审查；
- 断电持久性不作完整承诺；目录同步与平台差异继续按矩阵记录；
- 还没有提交或发布；SoL-Pi 未修改。

## 19. 失败路径与状态协议收尾（本轮已完成）

本轮没有改变产品行为，没有增加 prefix stripping、formatter、默认 workspace jail 或新的工具名；没有提交或发布。

### 19.1 结构化状态

提交层现在提供：

```ts
type PublicationStatus = "NOT_PUBLISHED" | "PUBLISHED" | "UNKNOWN";
type CommandStatus = "not_requested" | "skipped" | "succeeded" | "failed" | "timeout" | "cancelled";
type Freshness = "unchanged" | "changed" | "missing" | "unknown";

interface ActionFusionDetails {
  publication: PublicationStatus;
  command: CommandStatus;
  freshness: Freshness;
}
```

`FileMutationError` 和 `ActionFusionError` 都保留 `cause`，控制流程通过结构化字段判断，不通过匹配 `mutation completed` 等文案判断。错误文本仍包含状态摘要，确保 Pi 最终只保留错误 message 时，模型也能看到关键事实。

### 19.2 已验证的失败场景

| 场景 | 验证结果 |
| --- | --- |
| mutation 失败 / 发布前取消 | command 不启动，publication 不会伪装成 PUBLISHED |
| 发布后结果生成失败 | 保留 `publication=PUBLISHED`，command 为 skipped |
| command 前 guard 失败 | command 为 skipped，不是 failed |
| command 成功但修改目标 | command 为 succeeded，freshness 为 changed |
| command 失败但修改目标 | command 为 failed，freshness 仍为 changed |
| command 超时或取消 | 不重复 mutation，并执行最终 freshness 检查 |
| queue 前一调用异常 | queue release，后续同文件调用可以继续 |
| enabled + actionFusion | 实际注册 read/edit/grep/replace/write，三种 mutation 都暴露 then_run |
| enabled=false | 实际不注册 Hashline 工具 |

本轮状态协议基线测试结果（发布边界测试另列于第 20 节）：

```text
npm run typecheck
  passed

node --test packages/pi-hashline-edit/src/core/*.test.ts packages/pi-hashline-edit/src/pi/*.test.ts
  109 passed
  0 failed
  0 cancelled

git diff --check
  passed
```

### 19.3 已转入发布边界审查的事项

上一轮列出的跨平台发布风险已由第 20 节接管；本节不再把 workspace jail 默认策略列为未决项。严格 workspace jail 仍是显式后续模式。

## 20. 共同提交层发布边界验收（当前轮）

### 20.1 当前发布算法

当前 [`src/pi/file-commit.ts`](../packages/pi-hashline-edit/src/pi/file-commit.ts) 使用以下流程：

1. `lstat` 输入目录项；有效 symlink 使用 `realpath` 得到实际发布目标，dangling、循环或无法解析的链接在发布前拒绝。
2. `stat` 实际目标，拒绝目录等非普通文件；`nlink > 1` 的已有目标拒绝替换。
3. 读取实际目标 revision，严格检查 `expectedRevision`。
4. 在实际发布目录创建 sibling temporary directory。
5. 使用临时文件完整写入，临时文件默认 `0600`；已有目标复制基本 permission bits；完成 `fsync` 和 close。
6. `mode: "create"` 使用同文件系统 `link(temp, target)`，目标已存在或在竞争中出现时不覆盖。
7. 覆盖使用 `rename(temp, target)`，不执行先删除旧目标的降级路径。
8. 发布成功后标记 `published=true`，之后的目录同步、revision 读取和临时目录清理失败仍报告 `PUBLISHED`。
9. rename/link 结果无法确认时报告 `UNKNOWN`，不自动重试、不回滚、不执行尚未启动的 command。

`AbortSignal` 只在准备阶段和发布原语调用前检查；已经发起的 `link`/`rename` 不会被取消信号抢先伪装成 `NOT_PUBLISHED`。这不是任意外部 writer 的 CAS 保证，检查与替换之间仍存在普通文件系统竞态窗口。

### 20.2 当前环境测试矩阵

| 环境 | Node | 文件系统 | 结果 | 说明 |
| --- | --- | --- | --- | --- |
| 当前 Windows 主机 | v26.9.0 | NTFS | `passed` / `skipped` | 创建竞争、no-clobber、多硬链接、目录拒绝、只读替换和共享访问失败已实测；下面逐项列出 4 个 skipped |
| Linux 本地文件系统 | 未运行 | 未取得 | `not_run` | 当前工作环境不是 Linux；未把 Windows 结果外推为 Linux 结果 |
| macOS/APFS | 未运行 | 未取得 | `not_run` | 当前工作环境不是 macOS；未把模拟结果外推为 APFS 结果 |
| 网络文件系统 | 未验证 | 未取得 | `not_run` | 不进入本轮支持范围 |

本轮专门测试命令：

```text
node --test packages/pi-hashline-edit/src/pi/file-commit.test.ts packages/pi-hashline-edit/src/pi/write.test.ts packages/pi-hashline-edit/src/pi/failure-path.test.ts
15 passed, 4 skipped, 0 failed

npm run typecheck
passed

git diff --check
passed

node --test packages/pi-hashline-edit/src/core/*.test.ts packages/pi-hashline-edit/src/pi/*.test.ts
117 passed, 4 skipped, 0 failed
0 cancelled
```

完整测试命令本轮已运行，最新结果为 `117 passed, 4 skipped, 0 failed`；上一轮的 `109 passed` 只代表状态协议完成阶段。

### 20.3 支持边界结论

- 创建防覆盖已由底层 `link` 发布操作保证，不依赖发布前存在性检查。
- 覆盖不会先删除旧目标；替换失败不会通过普通覆盖或分段写入降级。
- 有效 symlink 覆盖保留链接，dangling symlink、链接循环和非普通文件拒绝；当前 Windows 没有 symlink 创建权限，相关契约未实测。
- 多硬链接目标首版拒绝替换，避免拆散既有链接关系。
- 已实现基本 permission bits 保留逻辑，并提供对应测试；POSIX 实机结果尚未取得。Windows ACL、只读属性和共享访问不宣称完整元数据迁移。
- 本轮不宣称完整断电持久性；Windows 不执行与 POSIX 相同的目录同步路径。
- 默认 workspace 行为保持不变；严格模式是后续实现与验证，不是本轮未决的默认策略。

### 20.4 Windows skipped 项逐项记录

| 测试名称 | 跳过条件 | 本轮未验证的契约 |
| --- | --- | --- |
| `replacement exposes complete old or new content during concurrent reads` | `process.platform === "win32"` | 替换成功时 Windows 读者是否只观察到完整旧内容或完整新内容；当前打开读句柄会使 rename 返回 `EPERM`，该成功可见性路径未完成验证 |
| `overwriting a symlink updates its resolved regular-file target and preserves the link` | 创建 symlink 返回 `EPERM` | Windows 有权限创建 symlink 时，覆盖真实目标并保留链接 |
| `create rejects both valid and dangling symlinks without replacing the link` | 创建 symlink 返回 `EPERM` | Windows 有权限创建 valid/dangling symlink 时的 create 拒绝语义 |
| `existing private and executable permissions survive replacement; new files use private mode` | `process.platform === "win32"` | POSIX mode bits 的实机保留结果；Windows ACL、readonly 属性和 executable 语义不是该测试的覆盖范围 |

Windows 共享访问失败由 `Windows shared access failure preserves the target, skips then_run, and releases the queue` 单独覆盖：NTFS 上使用 `FileShare.None` 占用目标时，mutation 在 revision 读取阶段以 `publication=NOT_PUBLISHED` 结束，`command=skipped`，目标保持原内容；释放句柄后同一工具队列的下一次调用成功。

## 21. 安装产物与隔离 Pi 回归证据

### 21.1 产物

在包工作区运行：

```text
npm pack --workspace=@d3ara1n/pi-hashline-edit --dry-run --json
npm pack --workspace=@d3ara1n/pi-hashline-edit --pack-destination <temp-artifacts>
```

产物：`@d3ara1n/pi-hashline-edit@0.5.4`，32 个文件，tarball 64,952 bytes，unpacked size 226,461 bytes，SHA-256：

```text
636a08c26af0a355fd8dad6d22a1ef7487687c7930c81bf1331d545ca8f2226f
```

清单中包含 `src/index.ts`、`src/pi/file-commit.ts`、`src/pi/action-fusion.ts`、`src/pi/write-tool.ts`、三个 mutation 工具和对应测试；没有用户配置、凭据或旧 tarball。包仍使用 `main: src/index.ts` 和 Pi manifest `./src/index.ts`，依赖仍只声明 `@earendil-works/pi-coding-agent: "*"` peer，没有扩大 engines 或其他兼容性承诺。

### 21.2 隔离安装

1. 在仓库外临时项目执行 `npm install --ignore-scripts --no-save <tarball>`，实际安装的 peer Pi 版本为 `0.85.1`。
2. 临时 `.pi/settings.json` 只引用解包后的 `../node_modules/@d3ara1n/pi-hashline-edit`，并设置 `hashlineEdit`；没有修改用户全局 Pi 配置。
3. 用 Pi `0.85.1` 的 `createAgentSession` 和 `SessionManager.inMemory()` 从临时项目加载正式包目录；扩展解析路径来自 `node_modules/@d3ara1n/pi-hashline-edit/src/index.ts`，不是工作树。
4. 直接将 Pi runtime 已加载的工具对象作为正式 `execute` 边界调用，检查内容结果、异常 message 和文件状态。

注意：把 `.tgz` 直接写进 Pi `packages` 设置会被 loader 视为未知 `.tgz` 扩展；正式 npm 安装步骤先解包，再由 Pi 加载安装目录。本轮没有把这个临时 loader 错误当成产品缺陷。

### 21.3 隔离回归结果

临时回归脚本实际通过：

- `enabled: false`：只保留 Pi 内置工具，Hashline override 未注册。
- `enabled: true, actionFusion: false`：`edit`、`replace`、`write` 不暴露 `then_run`；显式传入被拒绝且文件未修改。
- `actionFusion: true`：三种 mutation 都暴露 `then_run`；真实 write/command、read→edit anchors、replace、stale marker 和 revision conflict 均通过。
- command 失败：最终异常 message 包含 `publication=PUBLISHED` 和 `command=failed`，已发布文件保持新内容。
- 已发布后的后处理故障：通过安装包实际 `replace.execute` 的确定性 hashLen fault injection 验证最终异常包含 `publication=PUBLISHED`、`command=skipped`，目标保持新内容且 command marker 不存在。
- stale：最终内容包含 `[then_run:stale]` 和 `freshness=changed`；`write.renderResult` 回归验证 renderer 也保留 command 输出和 stale marker。
- 产物入口和 extension load：`extensionCount=1`、无 extension errors，实际工具为 read/edit/grep/replace/write。

环境证据：Node `v26.9.0`、npm `11.19.1`、Pi `0.85.1`、Windows `win32`、NTFS。完整测试和 package dry-run 的最新计数见第 20.2 节及本轮交付记录。
