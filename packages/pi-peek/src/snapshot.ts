import type { SessionEntry } from "@earendil-works/pi-coding-agent";

interface RecordItem {
  source: string;
  kind: string;
  text: string;
  thinking: string;
}

/** @internal Complete text snapshot; never holds references to mutable session entries. */
export class SessionSnapshot {
  readonly capturedAt: string;
  private records: RecordItem[] = [];

  constructor(branch: readonly SessionEntry[], capturedAt = new Date().toISOString()) {
    this.capturedAt = capturedAt;
    for (const entry of branch) {
      if (entry.type === "message") {
        this.addMessage(entry.id, entry.message);
      } else if (entry.type === "custom_message") {
        this.addMessage(entry.id, { ...entry, role: "custom" });
      } else if (entry.type === "compaction" || entry.type === "branch_summary") {
        this.records.push({ source: entry.id, kind: entry.type, text: entry.summary, thinking: "" });
        if (entry.type === "compaction" && "retainedTail" in entry && Array.isArray(entry.retainedTail)) {
          entry.retainedTail.forEach((message, i) => this.addMessage(`${entry.id}/retained/${i}`, message));
        }
      }
    }
  }

  private addMessage(source: string, value: unknown): void {
    const m = value as Record<string, any>;
    const blocks: any[] = Array.isArray(m.content) ? m.content : [];
    const thinking = blocks.filter(b => b?.type === "thinking" && !b.redacted && typeof b.thinking === "string")
      .map(b => b.thinking).filter(Boolean).join("\n");
    const parts: string[] = [];
    if (m.timestamp !== undefined) parts.push(`Timestamp: ${m.timestamp}`);
    if (typeof m.content === "string") parts.push(m.content);
    for (const block of blocks) {
      if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
      if (block?.type === "toolCall") {
        parts.push(`Tool call ${block.id}: ${block.name}\nArguments: ${JSON.stringify(block.arguments)}`);
      }
      if (block?.type === "image") parts.push("[Image not included.]");
    }
    if (m.role === "toolResult") {
      parts.unshift(`Tool result ${m.toolCallId}: ${m.toolName}; isError=${Boolean(m.isError)}`);
      // Render-only patch evidence may not be duplicated in content.
      for (const key of ["diff", "patch", "fullOutputPath", "truncated"]) {
        if (m.details?.[key] !== undefined) parts.push(`${key}: ${JSON.stringify(m.details[key])}`);
      }
      if (Array.isArray(m.details?.files)) {
        for (const file of m.details.files) {
          if (!file || typeof file !== "object") continue;
          const evidence: Record<string, unknown> = {};
          for (const key of ["path", "moveTo", "kind", "diff", "patch", "added", "removed"]) {
            if (typeof file[key] === "string" || typeof file[key] === "number") evidence[key] = file[key];
          }
          if (Object.keys(evidence).length) parts.push(`File evidence: ${JSON.stringify(evidence)}`);
        }
      }
    }
    if (m.role === "assistant") {
      parts.unshift(`Model: ${m.provider ?? "unknown"}/${m.model ?? "unknown"}; stopReason=${m.stopReason ?? "unknown"}`);
      if (m.errorMessage) parts.push(`Error: ${m.errorMessage}`);
    }
    if (m.role === "bashExecution") {
      parts.push(`Command: ${m.command}\nOutput: ${m.output}\nexitCode=${m.exitCode}; cancelled=${m.cancelled}; truncated=${m.truncated}; excludeFromContext=${m.excludeFromContext}`);
    }
    if (typeof m.summary === "string") parts.push(m.summary);
    if (m.customType) parts.unshift(`Extension message: ${m.customType}; display=${m.display}`);
    this.records.push({ source, kind: String(m.role ?? "unknown"), text: parts.join("\n"), thinking });
  }

  reference(includeThinking = false): string {
    const header = [
      "Scope: complete recorded text on the current branch. Capture time is supplied with the question.",
      "Compaction retained records may overlap original history.",
      includeThinking
        ? "Readable saved thinking is included where available; missing/redacted thinking cannot be reconstructed."
        : "Thinking is not included.",
      "Images, the main system prompt, other branches and external files/logs are not included.",
    ].join("\n");
    const records = this.records.map((r, i) => {
      const thinking = includeThinking && r.thinking ? `\nSaved thinking:\n${r.thinking}` : "";
      return `[M${i + 1}] ${r.kind}; source=${r.source}\n${r.text}${thinking}`;
    }).join("\n\n");
    return `${header}\n\n${records || "(empty conversation)"}`;
  }

  dispose(): void {
    this.records = [];
  }
}
