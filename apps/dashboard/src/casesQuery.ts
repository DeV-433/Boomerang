import type { IServerSideGetRowsRequest } from "ag-grid-community";

/** Grid column id -> API field, for the columns the API can sort, filter and group. */
export const SORTABLE: Record<string, string> = {
  customer: "customer",
  amountCents: "amountCents",
  recoveredCents: "recoveredCents",
  state: "state",
  cause: "cause",
  stage: "stage",
  lastContactAt: "lastContactAt",
  nextCheckAt: "nextCheckAt",
  lane: "lane",
  openedAt: "openedAt",
};
const FILTERABLE = ["lane", "state", "cause", "arm"] as const;
const GROUPABLE = ["cause", "state", "lane", "arm"] as const;

/** A missing cause or arm travels as "none", both as a group key and as a filter value. */
export const NONE = "none";

export type CasesCall =
  { kind: "rows"; path: string } | { kind: "groups"; path: string; by: string } | { kind: "empty" };

/**
 * Turns one server-side row model request into the API call that answers it: a page of cases, or
 * the group totals for the next grouping level (parent group keys become filters).
 */
export function casesCall(
  request: IServerSideGetRowsRequest,
  extra: { q?: string; openOnly?: boolean } = {},
): CasesCall {
  const params = new URLSearchParams();
  const filters = new Map<string, string[]>();

  const model = (request.filterModel ?? {}) as Record<
    string,
    { filterType?: string; values?: (string | null)[] }
  >;
  for (const field of FILTERABLE) {
    const f = model[field];
    if (f?.filterType === "set" && Array.isArray(f.values))
      filters.set(
        field,
        f.values.map((v) => v ?? NONE),
      );
  }
  // Each open parent group narrows the query to its key.
  request.groupKeys.forEach((key, i) => {
    const col = request.rowGroupCols[i]?.field ?? request.rowGroupCols[i]?.id;
    if (col) filters.set(col, [key]);
  });
  for (const [field, values] of filters) {
    // A set filter with nothing ticked matches no case: answer without calling the API.
    if (values.length === 0) return { kind: "empty" };
    params.set(field, values.join(","));
  }
  if (extra.q?.trim()) params.set("q", extra.q.trim());
  if (extra.openOnly) params.set("open", "true");

  const level = request.groupKeys.length;
  if (level < request.rowGroupCols.length) {
    const by = request.rowGroupCols[level]!.field ?? request.rowGroupCols[level]!.id;
    if (!(GROUPABLE as readonly string[]).includes(by)) throw new Error(`cannot group by ${by}`);
    params.set("by", by);
    return { kind: "groups", by, path: `/api/cases/groups?${params}` };
  }

  const start = request.startRow ?? 0;
  const end = request.endRow ?? start + 50;
  params.set("offset", String(start));
  params.set("limit", String(Math.min(500, Math.max(1, end - start))));
  const sort = request.sortModel.find((s) => SORTABLE[s.colId]);
  if (sort) {
    params.set("sort", SORTABLE[sort.colId]!);
    params.set("dir", sort.sort);
  }
  return { kind: "rows", path: `/api/cases?${params}` };
}
