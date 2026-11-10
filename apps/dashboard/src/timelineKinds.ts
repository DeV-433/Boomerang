import type { TimelineEvent, TimelineEventKind } from "@boomerang/core";

/**
 * How each kind of timeline event looks, shared by the Bryntum timeline and the plain fallback.
 * Identity never rests on colour alone: every kind also has its own icon and a legend label.
 * Recovered, stopped and handed-off use the dashboard's status colours (good, bad, warning).
 */
export const KIND_META: Record<
  TimelineEventKind,
  { label: string; icon: string; bryntumColor: string; cssVar: string }
> = {
  opened: { label: "Opened", icon: "fa-flag", bryntumColor: "gray", cssVar: "--tl-opened" },
  contact: { label: "Message sent", icon: "fa-envelope", bryntumColor: "blue", cssVar: "--tl-contact" },
  followup: { label: "Scheduled check", icon: "fa-clock", bryntumColor: "indigo", cssVar: "--tl-followup" },
  promise: { label: "Promise", icon: "fa-handshake", bryntumColor: "violet", cssVar: "--tl-promise" },
  paypal: { label: "PayPal event", icon: "fa-building-columns", bryntumColor: "teal", cssVar: "--tl-paypal" },
  page: { label: "Pay page", icon: "fa-link", bryntumColor: "pink", cssVar: "--tl-page" },
  recovered: { label: "Recovered", icon: "fa-circle-check", bryntumColor: "green", cssVar: "--ok" },
  stopped: { label: "Stopped", icon: "fa-ban", bryntumColor: "red", cssVar: "--bad" },
  escalated: { label: "Handed to a person", icon: "fa-user-tie", bryntumColor: "orange", cssVar: "--warn" },
};

/** The sentence a marker's hover shows for the gate rule that decided it. */
export const ruleText = (e: Pick<TimelineEvent, "rule">) =>
  e.rule ? `Gate rule ${e.rule.number}: ${e.rule.name.replace(/_/g, " ")}` : null;

const fmt = (iso: string, withTime: boolean) =>
  new Date(iso).toLocaleString(
    undefined,
    withTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" },
  );

/** One line saying when, as precisely as the source knows it (a simulated run only knows the day). */
export const whenText = (e: Pick<TimelineEvent, "start" | "end" | "future">, simulated: boolean) =>
  `${e.future ? "Scheduled for " : ""}${fmt(e.start, !simulated)}`;
