import type {
  ColDef,
  GetRowIdParams,
  GridApi,
  IServerSideDatasource,
  ValueFormatterParams,
} from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { AuditEntry, AuditListResponse, AuditListRow, CaseAuditResponse } from "@boomerang/core";
import { api } from "../api";
import { describeEntry } from "../auditText";
import { setupGrid, useGridTheme } from "../grid";
import { LiveBadge, useLiveGrid } from "../live";

setupGrid();

const KINDS = [
  "event_received",
  "diagnosed",
  "proposed",
  "gated",
  "approval",
  "executed",
  "observed",
  "closed",
  "scheduled",
  "system",
];
const when = (p: ValueFormatterParams) =>
  p.value
    ? new Date(p.value as string).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" })
    : "";
const kindLabel = (p: ValueFormatterParams) => String(p.value ?? "").replace(/_/g, " ");

/** Detail rows: one case's whole trail, oldest first, loaded when its row is expanded. */
const detailColumns: ColDef<AuditEntry>[] = [
  { headerName: "#", valueGetter: (p) => (p.node?.rowIndex ?? 0) + 1, width: 60 },
  { field: "at", headerName: "When", width: 190, valueFormatter: when },
  { field: "kind", headerName: "What", width: 120, valueFormatter: kindLabel },
  { field: "actor", headerName: "Who", width: 200 },
  {
    headerName: "Detail",
    flex: 1,
    minWidth: 300,
    valueGetter: (p) => (p.data ? describeEntry(p.data) : ""),
    tooltipValueGetter: (p) => (p.data ? JSON.stringify(p.data.data, null, 2) : ""),
  },
  { field: "id", headerName: "Entry", width: 90 },
];

export function Audit() {
  const theme = useGridTheme();
  const [params, setParams] = useSearchParams();
  const caseFilter = params.get("case");
  const gridApi = useRef<GridApi<AuditListRow> | null>(null);
  const lastRefresh = useLiveGrid(gridApi);
  const [q, setQ] = useState("");
  const [total, setTotal] = useState<number | null>(null);
  const extra = useRef<{ q: string; caseId: string | null }>({ q: "", caseId: caseFilter });
  const expandFirst = useRef(Boolean(caseFilter));

  const refresh = useCallback(() => gridApi.current?.refreshServerSide({ purge: true }), []);
  useEffect(() => {
    const t = setTimeout(() => {
      const changed = extra.current.q !== q || extra.current.caseId !== caseFilter;
      extra.current = { q, caseId: caseFilter };
      if (changed) {
        expandFirst.current = Boolean(caseFilter);
        refresh();
      }
    }, 300);
    return () => clearTimeout(t);
  }, [q, caseFilter, refresh]);

  const datasource = useMemo<IServerSideDatasource<AuditListRow>>(
    () => ({
      getRows: async (p) => {
        try {
          const qs = new URLSearchParams();
          const start = p.request.startRow ?? 0;
          qs.set("offset", String(start));
          qs.set("limit", String(Math.min(500, (p.request.endRow ?? start + 50) - start)));
          const kindFilter = (p.request.filterModel as Record<string, { values?: string[] }> | null)?.kind
            ?.values;
          if (kindFilter) {
            if (kindFilter.length === 0) return p.success({ rowData: [], rowCount: 0 });
            qs.set("kind", kindFilter.join(","));
          }
          if (extra.current.q.trim()) qs.set("q", extra.current.q.trim());
          if (extra.current.caseId) qs.set("case", extra.current.caseId);
          const sort = p.request.sortModel.find((s) => s.colId === "at" || s.colId === "id");
          if (sort) qs.set("dir", sort.sort);
          const res = await api<AuditListResponse>(`/api/audit?${qs}`);
          p.success({ rowData: res.rows, rowCount: res.total });
          setTotal(res.total);
          if (expandFirst.current && start === 0 && res.rows[0]) {
            expandFirst.current = false;
            const id = String(res.rows[0].id);
            setTimeout(() => gridApi.current?.getRowNode(id)?.setExpanded(true), 0);
          }
        } catch (err) {
          console.error(err);
          p.fail();
        }
      },
    }),
    [],
  );

  const columns = useMemo<ColDef<AuditListRow>[]>(
    () => [
      {
        field: "at",
        headerName: "When",
        width: 245,
        cellRenderer: "agGroupCellRenderer",
        valueFormatter: when,
        sortable: true,
        sort: "desc",
      },
      { field: "paypalRef", headerName: "Case", width: 230, valueFormatter: (p) => p.value ?? "(system)" },
      {
        field: "kind",
        headerName: "What",
        width: 140,
        valueFormatter: kindLabel,
        filter: "agSetColumnFilter",
        filterParams: { values: KINDS, valueFormatter: kindLabel },
      },
      { field: "actor", headerName: "Who", width: 200 },
      {
        headerName: "Detail",
        flex: 1,
        minWidth: 260,
        valueGetter: (p) => (p.data ? describeEntry(p.data) : ""),
        tooltipValueGetter: (p) => (p.data ? JSON.stringify(p.data.data, null, 2) : ""),
      },
      { field: "caseState", headerName: "Case now", width: 120 },
    ],
    [],
  );

  return (
    <div className="cases-page">
      <div className="page-head">
        <h1>Audit</h1>
        <span className="muted">{total === null ? "" : `${total.toLocaleString()} entries`}</span>
        <LiveBadge last={lastRefresh} />
        {caseFilter && (
          <span className="chip">
            One case only{" "}
            <button className="link-button" onClick={() => setParams({})} aria-label="Show all cases">
              show all
            </button>
          </span>
        )}
      </div>
      <div className="toolbar">
        <input
          type="search"
          placeholder="Search reference, actor or details"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search the audit log"
        />
        <span className="muted hint">
          Expand a row to see that case's whole trail in order. Hover a detail for the full record.
        </span>
      </div>
      <div className="grid-wrap">
        <AgGridReact<AuditListRow>
          theme={theme}
          rowModelType="serverSide"
          serverSideDatasource={datasource}
          columnDefs={columns}
          defaultColDef={{ resizable: true, sortable: false }}
          masterDetail
          isRowMaster={(d) => Boolean(d?.caseId)}
          detailRowAutoHeight
          detailCellRendererParams={{
            detailGridOptions: {
              columnDefs: detailColumns,
              defaultColDef: { resizable: true, suppressHeaderMenuButton: true },
              tooltipShowDelay: 300,
              domLayout: "autoHeight",
            },
            getDetailRowData: (p: { data: AuditListRow; successCallback: (rows: AuditEntry[]) => void }) => {
              api<CaseAuditResponse>(`/api/cases/${p.data.caseId}/audit`)
                .then((r) => p.successCallback(r.entries))
                .catch(() => p.successCallback([]));
            },
          }}
          getRowId={(p: GetRowIdParams<AuditListRow>) => String(p.data.id)}
          pagination
          paginationPageSize={50}
          paginationPageSizeSelector={[25, 50, 100]}
          cacheBlockSize={50}
          tooltipShowDelay={300}
          onGridReady={(e) => {
            gridApi.current = e.api;
            if (import.meta.env.MODE !== "production")
              (window as unknown as { __auditGrid?: GridApi }).__auditGrid = e.api;
          }}
        />
      </div>
    </div>
  );
}
