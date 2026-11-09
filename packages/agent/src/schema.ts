import { z } from "zod";
import { ACTION_MENUS, ALL_CAUSES, type Lane } from "@boomerang/core";

/**
 * Step 5.1: the decision the model must return (section 6, structured output). Validated twice:
 * the model is held to the JSON schema by Groq's strict mode, and the reply is checked again here, because a provider-side
 * schema is a convenience, not a guarantee.
 */
export const DecisionSchema = z
  .object({
    case_id: z.string().min(1),
    cause: z.enum(ALL_CAUSES as [string, ...string[]]),
    action: z.string().min(1),
    reason: z.string().min(5).max(400),
    confidence: z.number().min(0).max(1),
    next_check_after_hours: z.number().int().min(1).max(720),
  })
  .strict();

export type Decision = z.infer<typeof DecisionSchema>;

export type ValidationResult = { ok: true; decision: Decision } | { ok: false; errors: string[] };

/** Parses and validates a raw model reply for one case and lane. Extra fields are rejected. */
export function validateDecision(raw: string, expected: { caseId: string; lane: Lane }): ValidationResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, errors: ["reply is not valid JSON"] };
  }
  const parsed = DecisionSchema.safeParse(json);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  const d = parsed.data;
  const errors: string[] = [];
  if (d.case_id !== expected.caseId) errors.push(`case_id must be "${expected.caseId}"`);
  if (!(ACTION_MENUS[expected.lane] as readonly string[]).includes(d.action)) {
    errors.push(`action "${d.action}" is not on the ${expected.lane} menu: ${ACTION_MENUS[expected.lane].join(", ")}`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, decision: d };
}

/** JSON schema given to the model (Groq strict mode), with the action limited to the case's own lane menu. */
export function decisionJsonSchema(lane: Lane): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      case_id: { type: "string" },
      cause: { type: "string", enum: [...ALL_CAUSES] },
      action: { type: "string", enum: [...ACTION_MENUS[lane]] },
      reason: { type: "string", description: "One or two sentences on why this action fits this case now." },
      // Ranges (0..1, 1..720) are checked by DecisionSchema; Groq strict mode documents only types and enums.
      confidence: { type: "number" },
      next_check_after_hours: { type: "integer" },
    },
    required: ["case_id", "cause", "action", "reason", "confidence", "next_check_after_hours"],
    additionalProperties: false,
  };
}

// 5.7: drafting ---------------------------------------------------------------------------------------

export const DraftSchema = z.object({ personal_note: z.string().max(280) }).strict();
export const DRAFT_JSON_SCHEMA = {
  type: "object",
  properties: { personal_note: { type: "string", description: "At most two short sentences, or an empty string." } },
  required: ["personal_note"],
  additionalProperties: false,
};

// 5.9: reply classification ------------------------------------------------------------------------------

export const REPLY_LABELS = ["promise", "dispute", "opt_out", "question", "other"] as const;
export type ReplyLabel = (typeof REPLY_LABELS)[number];
export const ClassificationSchema = z
  .object({ label: z.enum(REPLY_LABELS), promise_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable() })
  .strict();
export const CLASSIFY_JSON_SCHEMA = {
  type: "object",
  properties: {
    label: { type: "string", enum: [...REPLY_LABELS] },
    promise_date: { type: ["string", "null"], description: "yyyy-MM-dd if the customer names a payment date, else null" },
  },
  required: ["label", "promise_date"],
  additionalProperties: false,
};
