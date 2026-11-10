import type {
  ColDef,
  GetRowIdParams,
  GridApi,
  ICellRendererParams,
  IServerSideDatasource,
  ValueFormatterParams,
} from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { CaseGroupsResponse, CaseRow, CasesResponse } from "@boomerang/core";
import { api } from "../api";
import { casesCall, NONE } from "../casesQuery";
import { dateTime, money } from "../format";
import { setupGrid, useGridTheme } from "../grid";
import { LiveBadge, useLiveGrid } from "../live";

setupGrid();

/** A group row as the server returns it: the group's value in its own column, plus summed amounts. */
type GroupRow = Partial<CaseRow> & { childCount?: number; group?: boolean };

const label = (v: string | null | undefined) =>
  v === null || v === undefined || v === NONE ? "(none)" : v.replace(/_/g, " ");
const moneyCell = (p: ValueFormatterParams) => (typeof p.value === "number" ? money(p.value) : "");
const dateCell = (p: ValueFormatterParams) => (p.value ? dateTime(p.value as string) : "");

async function setValues(by: "cause" | "state"): Promise<string[]> {
  const res = await api<CaseGroupsResponse>(`/api/cases/groups?by=${by}`);
  return res.groups.map((g) => g.key ?? NONE);
}

function RowActions(
  props: ICellRendererParams<CaseRow> & { onDone: () => void; openAudit: (id: string) => void },
) {
  const row = props.data;
  const [busy, setBusy] = useState(false);
  if (!row || props.node.group) return null;
  const closed = row.closedAt !== null;

  async function act(path: string, body: unknown, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    try {
      await api(path, { method: "POST", body });
      props.onDone();
    } catch (err) {
      window.alert((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="row-actions">
      {!closed && (
        <button disabled={busy} onClick={() => act(`/api/cases/${row.id}/pause`, { paused: !row.paused })}>
          {row.paused ? "Resume" : "Pause"}
        </button>
      )}
      {!closed && (
        <button
          disabled={busy}
          onClick={() =>
            act(
              `/api/cases/${row.id}/escalate`,
              {},
              `Hand ${row.paypalRef} to a person? Boomerang will not contact this customer again.`,
            )
          }
        >
          Escalate
        </button>
      )}
      {!closed && row.lane === "invoice" && (
        <button
          disabled={busy}
          title="Copy this case's signed pay-or-promise link"
          onClick={async () => {
            try {
              const { link } = await api<{ link: string }>(`/api/cases/${row.id}/paylink`);
              await navigator.clipboard?.writeText(link).catch(() => undefined);
              window.prompt("Pay-or-promise link for this case (copied):", link);
            } catch (err) {
              window.alert((err as Error).message);
            }
          }}
        >
          Pay link
        </button>
      )}
      <button onClick={() => props.openAudit(row.id)}>Audit</button>
    </div>
  );
}

export function Cases() {
  const theme = useGridTheme();
  const navigate = useNavigate();
  const gridApi = useRef<GridApi | null>(null);
  const lastRefresh = useLiveGrid(gridApi);
  const [q, setQ] = useState("");
  const [openOnly, setOpenOnly] = useState(false);
  const [total, setTotal] = useState<number | null>(null);
  const extra = useRef({ q: "", openOnly: false });

  const refresh = useCallback((purge = false) => gridApi.current?.refreshServerSide({ purge }), []);

  // Search and the open-only toggle live outside the grid's own filter model.
  useEffect(() => {
    const t = setTimeout(() => {
      extra.current = { q, openOnly };
      refresh(true);
    }, 300);
    return () => clearTimeout(t);
  }, [q, openOnly, refresh]);

  const datasource = useMemo<IServerSideDatasource>(
    () => ({
      getRows: async (params) => {
        try {
          const call = casesCall(params.request, extra.current);
          if (call.kind === "empty") {
            params.success({ rowData: [], rowCount: 0 });
            if (params.request.groupKeys.length === 0) setTotal(0);
            return;
          }
          if (call.kind === "groups") {
            const res = await api<CaseGroupsResponse>(call.path);
            const rowData: GroupRow[] = res.groups.map((g) => ({
              [call.by]: g.key ?? NONE,
              amountCents: g.amountCents,
              recoveredCents: g.recoveredCents,
              childCount: g.cases,
            }));
            params.success({ rowData, rowCount: rowData.length });
            if (params.request.groupKeys.length === 0) setTotal(res.groups.reduce((s, g) => s + g.cases, 0));
            return;
          }
          const res = await api<CasesResponse>(call.path);
          params.success({ rowData: res.rows, rowCount: res.total });
          if (params.request.rowGroupCols.length === 0) setTotal(res.total);
        } catch (err) {
          console.error(err);
          params.fail();
        }
      },
    }),
    [],
  );

  const columnDefs = useMemo<ColDef[]>(
    () => [
      {
        field: "customer",
        headerName: "Customer",
        minWidth: 180,
        flex: 1.4,
        valueGetter: (p) => p.data?.customer ?? p.data?.customerEmail ?? "",
        tooltip: (p) => p.data?.paypalRef,
      },
      {
        field: "lane",
        headerName: "Lane",
        width: 120,
        enableRowGroup: true,
        filter: "agSetColumnFilter",
        filterParams: { values: ["invoice", "subscription"] },
      },
      {
        field: "amountCents",
        headerName: "Amount",
        width: 120,
        type: "rightAligned",
        aggFunc: "sum",
        valueFormatter: moneyCell,
      },
      {
        field: "cause",
        headerName: "Cause",
        minWidth: 170,
        flex: 1,
        enableRowGroup: true,
        filter: "agSetColumnFilter",
        filterParams: {
          values: (p: { success: (v: string[]) => void }) => void setValues("cause").then(p.success),
          valueFormatter: (p: ValueFormatterParams) => label(p.value),
        },
        valueFormatter: (p) => label(p.value),
      },
      {
        field: "state",
        headerName: "State",
        width: 130,
        enableRowGroup: true,
        filter: "agSetColumnFilter",
        filterParams: {
          values: (p: { success: (v: string[]) => void }) => void setValues("state").then(p.success),
        },
        valueFormatter: (p) => (p.value ? `${label(p.value)}${p.data?.paused ? " (paused)" : ""}` : ""),
      },
      { field: "stage", headerName: "Stage", width: 100, type: "rightAligned" },
      { field: "lastContactAt", headerName: "Last contact", width: 170, valueFormatter: dateCell },
      { field: "nextCheckAt", headerName: "Next check", width: 170, valueFormatter: dateCell },
      {
        field: "recoveredCents",
        headerName: "Recovered",
        width: 120,
        type: "rightAligned",
        aggFunc: "sum",
        valueFormatter: moneyCell,
      },
      {
        field: "arm",
        headerName: "Arm",
        width: 110,
        enableRowGroup: true,
        filter: "agSetColumnFilter",
        filterParams: {
          values: ["control", "treatment", NONE],
          valueFormatter: (p: ValueFormatterParams) => label(p.value),
        },
        valueFormatter: (p) => (p.value ? label(p.value) : ""),
        sortable: false,
      },
      {
        colId: "actions",
        headerName: "",
        width: 300,
        pinned: "right",
        sortable: false,
        filter: false,
        suppressHeaderMenuButton: true,
        cellRenderer: RowActions,
        cellRendererParams: {
          onDone: () => refresh(false),
          openAudit: (id: string) => navigate(`/audit?case=${id}`),
        },
      },
    ],
    [navigate, refresh],
  );

  return (
    <div className="cases-page">
      <div className="page-head">
        <h1>Cases</h1>
        <span className="muted">{total === null ? "" : `${total.toLocaleString()} matching`}</span>
        <LiveBadge last={lastRefresh} />
      </div>
      <div className="toolbar">
        <input
          type="search"
          placeholder="Search reference, email or name"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search cases"
        />
        <label className="check">
          <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} /> Open
          cases only
        </label>
        <span className="muted hint">
          Drag Cause, State, Lane or Arm into the bar above the grid to group with summed amounts.
        </span>
      </div>
      <div className="grid-wrap">
        <AgGridReact
          theme={theme}
          rowModelType="serverSide"
          serverSideDatasource={datasource}
          columnDefs={columnDefs}
          defaultColDef={{ sortable: true, resizable: true, filter: false }}
          autoGroupColumnDef={{ headerName: "Group", minWidth: 220 }}
          rowGroupPanelShow="always"
          suppressAggFuncInHeader
          pagination
          paginationPageSize={50}
          paginationPageSizeSelector={[25, 50, 100]}
          cacheBlockSize={50}
          getRowId={(p: GetRowIdParams<GroupRow>) =>
            p.data?.id
              ? p.data.id
              : `group:${(p.parentKeys ?? []).join("/")}/${p.data?.cause ?? p.data?.state ?? p.data?.lane ?? p.data?.arm ?? ""}`
          }
          getChildCount={(data: GroupRow) => data?.childCount ?? 0}
          serverSideSortAllLevels
          tooltipShowDelay={300}
          onGridReady={(e) => {
            gridApi.current = e.api;
            // Browser checks drive the grid through its API; never exposed in a production build.
            if (import.meta.env.MODE !== "production")
              (window as unknown as { __casesGrid?: GridApi }).__casesGrid = e.api;
          }}
        />
      </div>
    </div>
  );
}
