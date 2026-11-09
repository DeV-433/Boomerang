import type { AuditEntry } from "@boomerang/core";

const s = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const human = (v: unknown) => s(v).replace(/_/g, " ");

/** One line that says what an audit entry recorded. The full data stays one click away. */
export function describeEntry(e: Pick<AuditEntry, "kind" | "data">): string {
  const d = e.data;
  switch (e.kind) {
    case "event_received":
      return `PayPal event ${s(d.type ?? d.eventType)}`.trim();
    case "diagnosed":
      return `cause: ${human(d.cause)}${d.stage !== undefined ? ` (contacts so far: ${s(d.stage)})` : ""}`;
    case "proposed":
      return `${human(d.action)}${typeof d.confidence === "number" ? ` (confidence ${d.confidence.toFixed(2)})` : ""}${d.reason ? `: ${s(d.reason)}` : ""}`;
    case "gated": {
      const reasons = Array.isArray(d.reasons) ? (d.reasons as unknown[]).map(s).join("; ") : "";
      return `${s(d.verdict)}${d.decidedBy ? ` by rule ${s(d.decidedBy)}` : ""}${reasons ? `: ${reasons}` : ""}${d.afterApproval ? " (after approval)" : ""}`;
    }
    case "approval":
      return `${s(d.status)}${d.reason ? `: ${s(d.reason)}` : ""}${d.note ? `: ${s(d.note)}` : ""}`;
    case "executed":
      if (d.failed) return `failed: ${s(d.error)}`;
      if (d.dryRun) return `dry run: would call ${s(d.tool)}`;
      return `called ${s(d.tool ?? d.internal)}`;
    case "observed":
      return d.cancelled ? `cancelled: ${s(d.reason)}` : `PayPal status ${s(d.paypalStatus)}`;
    case "scheduled":
      return `next check ${s(d.runAt)}${d.action ? ` after ${human(d.action)}` : ""}${d.reason ? `: ${s(d.reason)}` : ""}`;
    case "closed":
      return `${s(d.endState)}: ${s(d.reason)}`;
    case "system":
      if ("paused" in d) return `${d.paused ? "paused" : "resumed"}${d.note ? `: ${s(d.note)}` : ""}`;
      if (d.startedBatch) return `batch started (${s(d.treatmentCases)} treatment cases)`;
      return JSON.stringify(d).slice(0, 160);
    default:
      return JSON.stringify(d).slice(0, 160);
  }
}
