import { lintMessage, toneForStage, type Action, type Proposal, type ProposalMeta, type TemplateId } from "@boomerang/core";
import { messageFacts, proposeByRules, renderMessage, type CaseSnapshot, type Diagnosis, type Proposer } from "@boomerang/cases";
import { CLASSIFY_MODEL, costUsd, DECISION_MODEL, DRAFT_MODEL, ModelCallError, type ModelClient, type ModelRequest, type Usage } from "./model";
import { CLASSIFY_SYSTEM, DECIDE_SYSTEM, DRAFT_SYSTEM, PROMPT_VERSION } from "./prompts";
import {
  ClassificationSchema,
  CLASSIFY_JSON_SCHEMA,
  decisionJsonSchema,
  DRAFT_JSON_SCHEMA,
  DraftSchema,
  validateDecision,
  type ReplyLabel,
} from "./schema";
import { buildCaseSummary } from "./summary";

export interface AgentOptions {
  client: ModelClient;
  decisionModel?: string;
  draftModel?: string;
  /** Called after each call so a recording client can flag invalid replies. */
  onValidated?: (req: ModelRequest, valid: boolean) => Promise<void> | void;
}

const addUsage = (a: Usage & { costUsd: number }, model: string, u: Usage) => ({
  inputTokens: a.inputTokens + u.inputTokens,
  outputTokens: a.outputTokens + u.outputTokens,
  thinkingTokens: a.thinkingTokens + u.thinkingTokens,
  costUsd: a.costUsd + costUsd(model, u),
});
const ZERO = { inputTokens: 0, outputTokens: 0, thinkingTokens: 0, costUsd: 0 };

/** Which approved template a contact action uses. */
export function templateFor(action: Action, diagnosis: Diagnosis): TemplateId | null {
  if (action === "send_reminder") return diagnosis.cause === "broken_promise" ? "promise_follow_up" : "reminder";
  if (action === "offer_payment_plan") return "payment_plan";
  if (action === "send_update_payment_message") return "update_payment_method";
  return null;
}

/**
 * Steps 5.3 to 5.5: the decision call. The model sees only the structured summary and must pick
 * from its lane's menu. An invalid reply is retried once with the validation errors; a second
 * invalid reply escalates the case to a person. Model, prompt version and input are recorded.
 */
export async function decide(opts: AgentOptions, s: CaseSnapshot, diagnosis: Diagnosis, now: Date): Promise<Proposal> {
  const model = opts.decisionModel ?? DECISION_MODEL;
  const summary = buildCaseSummary(s, diagnosis, now);
  const meta: ProposalMeta = { model, promptVersion: PROMPT_VERSION.decide, input: summary, attempts: 0, rejected: [] };
  let usage = ZERO;
  let feedback = "";

  for (let attempt = 1; attempt <= 2; attempt++) {
    const req: ModelRequest = {
      kind: "decide",
      model,
      promptVersion: PROMPT_VERSION.decide,
      system: DECIDE_SYSTEM,
      input: JSON.stringify({ today: now.toISOString().slice(0, 10), case: summary }) + feedback,
      jsonSchema: decisionJsonSchema(s.lane),
      thinking: "MINIMAL",
      caseId: s.id,
    };
    const res = await opts.client.generate(req);
    usage = addUsage(usage, res.model, res.usage);
    meta.attempts = attempt;
    meta.model = res.model;
    const v = validateDecision(res.text, { caseId: s.id, lane: s.lane });
    await opts.onValidated?.(req, v.ok);
    if (v.ok) {
      const d = v.decision;
      if (d.cause !== diagnosis.cause) meta.modelCause = d.cause;
      const proposal: Proposal = {
        caseId: s.id,
        // The rules' diagnosis stays authoritative; the model's own label is recorded if it differs.
        cause: diagnosis.cause,
        action: d.action as Action,
        reason: d.reason,
        confidence: d.confidence,
        nextCheckAfterHours: d.next_check_after_hours,
        proposedBy: `agent:${res.model}`,
        meta: { ...meta, usage },
      };
      return withDraft(opts, proposal, s, diagnosis);
    }
    meta.rejected!.push(v.errors);
    feedback = `\n\nYour previous reply was rejected: ${v.errors.join("; ")}. Reply again with valid JSON that follows the rules.`;
  }

  return {
    caseId: s.id,
    cause: diagnosis.cause,
    action: "escalate_to_human",
    reason: "The agent returned an invalid decision twice; a person should review this case.",
    confidence: 0,
    nextCheckAfterHours: 0,
    proposedBy: `agent:${meta.model}`,
    meta: { ...meta, usage },
  };
}

/**
 * Step 5.7: personalises the approved template for a contact action. The model writes only the
 * optional note; the lint (5.8) checks the finished message. A failing note is redrafted once with
 * the lint issues; if the redraft also fails, the message is marked redrafted so the gate holds it
 * for a person (rule 11).
 */
async function withDraft(opts: AgentOptions, proposal: Proposal, s: CaseSnapshot, diagnosis: Diagnosis): Promise<Proposal> {
  const template = templateFor(proposal.action, diagnosis);
  if (!template) return proposal;
  const model = opts.draftModel ?? DRAFT_MODEL;
  const tone = toneForStage(s.contacts);
  const facts = messageFacts(s);
  let usage = proposal.meta?.usage ?? ZERO;
  let feedback = "";

  for (let attempt = 1; attempt <= 2; attempt++) {
    const req: ModelRequest = {
      kind: "draft",
      model,
      promptVersion: PROMPT_VERSION.draft,
      system: DRAFT_SYSTEM,
      input: JSON.stringify({ tone, template, stage: s.contacts, situation: proposal.reason, lane: s.lane }) + feedback,
      jsonSchema: DRAFT_JSON_SCHEMA,
      thinking: "MINIMAL",
      caseId: s.id,
    };
    let res: Awaited<ReturnType<ModelClient["generate"]>>;
    try {
      res = await opts.client.generate(req);
    } catch (error) {
      if (!(error instanceof ModelCallError)) throw error;
      // The note is optional: keep the agent's decision and send the approved template as it is.
      const message = renderMessage(template, s, tone);
      return { ...proposal, message, meta: { ...proposal.meta, usage, draft: { model, promptVersion: PROMPT_VERSION.draft, personalNote: "", redrafted: false, lintIssues: [`drafting unavailable: ${error.message.slice(0, 120)}`] } } };
    }
    usage = addUsage(usage, res.model, res.usage);
    let note = "";
    try {
      const parsed = DraftSchema.safeParse(JSON.parse(res.text));
      if (parsed.success) note = parsed.data.personal_note.trim();
    } catch {
      note = "";
    }
    const message = renderMessage(template, s, tone, note || undefined);
    const lint = lintMessage(message.body, facts);
    await opts.onValidated?.(req, lint.ok);
    if (lint.ok) {
      return { ...proposal, message, meta: { ...proposal.meta, usage, draft: { model: res.model, promptVersion: PROMPT_VERSION.draft, personalNote: note, redrafted: attempt > 1 } } };
    }
    feedback = `\n\nYour note was rejected: ${lint.issues.join("; ")}. Write a note that avoids these problems, or return an empty string.`;
    if (attempt === 2) {
      return {
        ...proposal,
        message,
        meta: { ...proposal.meta, usage, draft: { model: res.model, promptVersion: PROMPT_VERSION.draft, personalNote: note, redrafted: true, lintIssues: lint.issues } },
      };
    }
  }
  return proposal;
}

/**
 * Step 5.10: the agent as the loop's proposer, with the rule-based proposer as fallback when the
 * model cannot be reached (network, quota). Clear-cut cases skip the model entirely, because rules
 * are enough there (design principle 2): resolved, disputed, opted-out and exhausted cases.
 */
export function agentProposer(opts: AgentOptions): Proposer {
  return async (s: CaseSnapshot, diagnosis: Diagnosis, now: Date) => {
    if (["resolved", "dispute", "opted_out"].includes(diagnosis.cause)) return proposeByRules(s, diagnosis, now);
    try {
      return await decide(opts, s, diagnosis, now);
    } catch (error) {
      if (!(error instanceof ModelCallError)) throw error;
      const fallback = proposeByRules(s, diagnosis, now);
      return { ...fallback, proposedBy: "rules (agent fallback)", meta: { fallback: error.message } };
    }
  };
}

export interface Classification {
  label: ReplyLabel;
  promiseDate: string | null;
  model: string;
  promptVersion: string;
}

/**
 * Step 5.9: classifies one customer reply in a separate call with no tools and a fixed set of
 * labels. The reply text goes only here; the decision call only ever sees the resulting label.
 * A promise date is accepted only if it is a real date from today up to 60 days ahead.
 */
export async function classifyReply(client: ModelClient, text: string, now: Date, options: { model?: string; caseId?: string | null } = {}): Promise<Classification> {
  const model = options.model ?? CLASSIFY_MODEL;
  const req: ModelRequest = {
    kind: "classify",
    model,
    promptVersion: PROMPT_VERSION.classify,
    system: CLASSIFY_SYSTEM,
    // The reply is fenced and labelled as data; the instructions live only in the system prompt.
    input: JSON.stringify({ today: now.toISOString().slice(0, 10), reply: text.slice(0, 4000) }),
    jsonSchema: CLASSIFY_JSON_SCHEMA,
    thinking: "MINIMAL",
    caseId: options.caseId ?? null,
  };
  const res = await client.generate(req);
  let label: ReplyLabel = "other";
  let promiseDate: string | null = null;
  try {
    const parsed = ClassificationSchema.safeParse(JSON.parse(res.text));
    if (parsed.success) {
      label = parsed.data.label;
      promiseDate = label === "promise" ? validPromiseDate(parsed.data.promise_date, now) : null;
    }
  } catch {
    label = "other";
  }
  return { label, promiseDate, model: res.model, promptVersion: PROMPT_VERSION.classify };
}

function validPromiseDate(date: string | null, now: Date): string | null {
  if (!date) return null;
  const t = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== date) return null;
  const today = new Date(`${now.toISOString().slice(0, 10)}T00:00:00Z`).getTime();
  const daysAhead = (t.getTime() - today) / 86_400_000;
  return daysAhead >= 0 && daysAhead <= 60 ? date : null;
}
