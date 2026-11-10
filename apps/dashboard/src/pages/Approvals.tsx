import type { ColDef, ValueFormatterParams } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type {
  ApprovalDecisionRequest,
  ApprovalDecisionResponse,
  ApprovalRow,
  ApprovalsResponse,
} from "@boomerang/core";
import { api, ApiError } from "../api";
import { dateTime, money } from "../format";
import { setupGrid, useGridTheme } from "../grid";

setupGrid();

type View = "pending" | "decided";
const human = (v: string | null | undefined) => (v ?? "").replace(/_/g, " ");

const OUTCOME_TEXT: Record<string, string> = {
  executed: "Sent.",
  deferred: "Approved; it will go out when the gate allows (for example inside contact hours).",
  closed: "The case is closed.",
  dry_run: "Recorded as a dry run (POLICY_MODE is dry_run): nothing was sent.",
  cancelled: "Nothing was sent: the case changed before sending.",
};

function DecisionPanel({ row, onDecided }: { row: ApprovalRow; onDecided: (text: string) => void }) {
  const [mode, setMode] = useState<"view" | "edit" | "reject">("view");
  const [subject, setSubject] = useState(row.message?.subject ?? "");
  const [body, setBody] = useState(row.message?.body ?? "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; issues?: string[] } | null>(null);
  const pending = row.status === "pending";

  useEffect(() => {
    setMode("view");
    setSubject(row.message?.subject ?? "");
    setBody(row.message?.body ?? "");
    setNote("");
    setError(null);
  }, [row.approvalId, row.message]);

  async function submit(req: ApprovalDecisionRequest) {
    setBusy(true);
    setError(null);
    try {
      const res = await api<ApprovalDecisionResponse>(`/api/approvals/${row.approvalId}/decision`, {
        method: "POST",
        body: req,
      });
      onDecided(
        `${row.case.paypalRef}: ${req.decision === "reject" ? "rejected" : req.decision === "edit" ? "edited and approved" : "approved"}. ${OUTCOME_TEXT[res.outcome] ?? res.detail ?? ""}`,
      );
    } catch (err) {
      if (err instanceof ApiError) setError({ message: err.message, issues: err.issues });
      else setError({ message: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card decision" aria-label={`Held action for ${row.case.paypalRef}`}>
      <div className="card-head">
        <h2>
          {human(row.action)} for {row.case.paypalRef}
        </h2>
        <span className="chip">{row.status}</span>
      </div>
      <dl className="facts">
        <div>
          <dt>Customer</dt>
          <dd>{row.case.customer ?? "unknown"}</dd>
        </div>
        <div>
          <dt>Amount</dt>
          <dd>{money(row.case.amountCents)}</dd>
        </div>
        <div>
          <dt>Contacts so far</dt>
          <dd>{row.case.stage}</dd>
        </div>
        <div>
          <dt>Held</dt>
          <dd>{dateTime(row.createdAt)}</dd>
        </div>
      </dl>

      <div className="block">
        <h3>Why the gate held it</h3>
        <ul>
          {row.gate.reasons.length ? (
            row.gate.reasons.map((r) => <li key={r}>{r}</li>)
          ) : (
            <li>No reason recorded</li>
          )}
        </ul>
      </div>

      <div className="block">
        <h3>
          Proposed by {row.proposedBy}
          {row.confidence !== null ? `, confidence ${row.confidence.toFixed(2)}` : ""}
        </h3>
        <p>{row.reason ?? "No reason given."}</p>
      </div>

      {row.customerReply && (
        <div className="block customer-text" role="note" aria-label="Customer-written text">
          <h3>
            Customer wrote{" "}
            <span className="muted">
              (verbatim, untrusted;{" "}
              {row.customerReply.label ? `labelled ${human(row.customerReply.label)}` : "not labelled"},{" "}
              {dateTime(row.customerReply.receivedAt)})
            </span>
          </h3>
          <blockquote>{row.customerReply.text}</blockquote>
        </div>
      )}

      <div className="block">
        <h3>{mode === "edit" ? "Edit the message" : "Draft message"}</h3>
        {row.message ? (
          mode === "edit" ? (
            <div className="editor">
              <label htmlFor="subject">Subject</label>
              <input id="subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
              <label htmlFor="body">Body</label>
              <textarea id="body" rows={9} value={body} onChange={(e) => setBody(e.target.value)} />
              <p className="muted small">
                The body must keep the amount, the reference, the payment link and the opt-out line, and add
                no other amounts or links.
              </p>
            </div>
          ) : (
            <div className="draft">
              <div className="draft-subject">{row.message.subject}</div>
              <pre className="draft-body">{row.message.body}</pre>
            </div>
          )
        ) : (
          <p className="muted">This action sends no message.</p>
        )}
      </div>

      {mode === "reject" && (
        <div className="block">
          <label htmlFor="note">Why reject? (kept in the audit log)</label>
          <input
            id="note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="For example: key account, calling them instead"
          />
        </div>
      )}

      {error && (
        <div className="error" role="alert">
          {error.message}
          {error.issues && (
            <ul>
              {error.issues.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {pending ? (
        <div className="actions">
          {mode === "view" && (
            <>
              <button className="primary" disabled={busy} onClick={() => submit({ decision: "approve" })}>
                Approve and send
              </button>
              {row.message && (
                <button disabled={busy} onClick={() => setMode("edit")}>
                  Edit
                </button>
              )}
              <button disabled={busy} className="danger" onClick={() => setMode("reject")}>
                Reject
              </button>
            </>
          )}
          {mode === "edit" && (
            <>
              <button
                className="primary"
                disabled={busy || body.trim() === ""}
                onClick={() => submit({ decision: "edit", message: { subject, body } })}
              >
                Approve edited message
              </button>
              <button disabled={busy} onClick={() => setMode("view")}>
                Cancel
              </button>
            </>
          )}
          {mode === "reject" && (
            <>
              <button
                className="danger"
                disabled={busy}
                onClick={() => submit({ decision: "reject", note: note.trim() || undefined })}
              >
                Reject and stop the case
              </button>
              <button disabled={busy} onClick={() => setMode("view")}>
                Cancel
              </button>
            </>
          )}
        </div>
      ) : (
        <p className="muted">
          {row.status} by {row.decidedBy ?? "unknown"} {row.decidedAt ? `on ${dateTime(row.decidedAt)}` : ""}
          {row.note ? `: ${row.note}` : ""}
        </p>
      )}
    </section>
  );
}

export function Approvals() {
  const theme = useGridTheme();
  const queryClient = useQueryClient();
  const [view, setView] = useState<View>("pending");
  const [selected, setSelected] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const status = view === "pending" ? "pending" : "approved,edited,rejected";
  const list = useQuery({
    queryKey: ["approvals", status],
    queryFn: ({ signal }) => api<ApprovalsResponse>(`/api/approvals?status=${status}`, { signal }),
    refetchInterval: 15_000,
  });
  const rows = useMemo(() => list.data?.rows ?? [], [list.data]);
  const current = rows.find((r) => r.approvalId === selected) ?? rows[0] ?? null;

  const columns = useMemo<ColDef<ApprovalRow>[]>(
    () => [
      { headerName: "Case", valueGetter: (p) => p.data?.case.paypalRef, minWidth: 210, flex: 1 },
      { headerName: "Customer", valueGetter: (p) => p.data?.case.customer, minWidth: 160, flex: 1 },
      {
        headerName: "Amount",
        valueGetter: (p) => p.data?.case.amountCents,
        valueFormatter: (p: ValueFormatterParams) => (typeof p.value === "number" ? money(p.value) : ""),
        width: 120,
        type: "rightAligned",
      },
      { field: "action", headerName: "Action", valueFormatter: (p) => human(p.value), width: 170 },
      {
        headerName: "Held because",
        valueGetter: (p) => p.data?.gate.reasons[0] ?? "",
        minWidth: 220,
        flex: 2,
        tooltip: (p) => p.data?.gate.reasons.join("\n"),
      },
      {
        field: "createdAt",
        headerName: "Held",
        valueFormatter: (p) => dateTime(p.value),
        width: 170,
        sort: "desc",
      },
      ...(view === "decided" ? [{ field: "status" as const, headerName: "Decision", width: 110 }] : []),
    ],
    [view],
  );

  return (
    <div className="approvals-page">
      <div className="page-head">
        <h1>Approvals</h1>
        <div className="tabs" role="tablist">
          {(["pending", "decided"] as const).map((v) => (
            <button
              key={v}
              role="tab"
              aria-selected={view === v}
              className={view === v ? "tab active" : "tab"}
              onClick={() => (setView(v), setSelected(null))}
            >
              {v === "pending" ? "Waiting for you" : "Decided"}
            </button>
          ))}
        </div>
        <span className="muted">
          {list.data ? `${rows.length} ${view === "pending" ? "waiting" : "decided"}` : ""}
        </span>
      </div>
      {flash && (
        <p className="flash" role="status">
          {flash}
        </p>
      )}
      {list.isError && <p className="error">Could not load approvals: {list.error.message}</p>}
      <div className="approvals-layout">
        <div className="approvals-grid">
          <AgGridReact<ApprovalRow>
            theme={theme}
            rowData={rows}
            columnDefs={columns}
            defaultColDef={{ resizable: true, sortable: true, suppressHeaderMenuButton: true }}
            getRowId={(p) => p.data.approvalId}
            rowSelection={{ mode: "singleRow", checkboxes: false, enableClickSelection: true }}
            onRowClicked={(e) => e.data && setSelected(e.data.approvalId)}
            onRowDataUpdated={(e) => current && e.api.getRowNode(current.approvalId)?.setSelected(true)}
            onFirstDataRendered={(e) => current && e.api.getRowNode(current.approvalId)?.setSelected(true)}
            overlayNoRowsTemplate={
              view === "pending" ? "Nothing is waiting for approval." : "No decisions yet."
            }
            tooltipShowDelay={300}
            loading={list.isPending}
          />
        </div>
        {current ? (
          <DecisionPanel
            row={current}
            onDecided={(text) => {
              setFlash(text);
              setSelected(null);
              void queryClient.invalidateQueries({ queryKey: ["approvals"] });
              void queryClient.invalidateQueries({ queryKey: ["summary"] });
            }}
          />
        ) : (
          <section className="card muted">
            {view === "pending" ? "Nothing is waiting for approval." : "Select a decision to see it."}
          </section>
        )}
      </div>
    </div>
  );
}
