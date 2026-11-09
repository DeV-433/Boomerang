import type { IServerSideGetRowsRequest } from "ag-grid-community";
import { describe, expect, it } from "vitest";
import { casesCall } from "../src/casesQuery";

const req = (o: Partial<IServerSideGetRowsRequest> = {}): IServerSideGetRowsRequest => ({
  startRow: 0,
  endRow: 50,
  rowGroupCols: [],
  valueCols: [],
  pivotCols: [],
  pivotMode: false,
  groupKeys: [],
  filterModel: {},
  sortModel: [],
  ...o,
});
const col = (field: string) => ({ id: field, field, displayName: field });

describe("grid request -> cases API call", () => {
  it("pages, sorts and filters a flat grid on the server", () => {
    const call = casesCall(
      req({
        startRow: 100,
        endRow: 150,
        sortModel: [{ colId: "amountCents", sort: "desc" }],
        filterModel: {
          state: { filterType: "set", values: ["awaiting", "approval"] },
          cause: { filterType: "set", values: [null, "overdue_unresponsive"] },
        },
      }),
      { q: " acme ", openOnly: true },
    );
    expect(call.kind).toBe("rows");
    const url = new URL(`http://x${(call as { path: string }).path}`);
    expect(url.pathname).toBe("/api/cases");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      state: "awaiting,approval",
      cause: "none,overdue_unresponsive",
      q: "acme",
      open: "true",
      offset: "100",
      limit: "50",
      sort: "amountCents",
      dir: "desc",
    });
  });

  it("asks for group totals at a grouping level, with parent keys as filters", () => {
    const top = casesCall(req({ rowGroupCols: [col("cause"), col("state")] }));
    expect(top).toEqual({ kind: "groups", by: "cause", path: "/api/cases/groups?by=cause" });
    const nested = casesCall(req({ rowGroupCols: [col("cause"), col("state")], groupKeys: ["none"] }));
    expect(nested).toEqual({ kind: "groups", by: "state", path: "/api/cases/groups?cause=none&by=state" });
    const leaves = casesCall(
      req({ rowGroupCols: [col("cause"), col("state")], groupKeys: ["overdue_unresponsive", "awaiting"] }),
    );
    expect(leaves.kind).toBe("rows");
    expect((leaves as { path: string }).path).toContain("cause=overdue_unresponsive&state=awaiting");
  });

  it("answers an empty set filter without calling the API, and ignores unsortable columns", () => {
    expect(casesCall(req({ filterModel: { lane: { filterType: "set", values: [] } } }))).toEqual({
      kind: "empty",
    });
    expect(
      (casesCall(req({ sortModel: [{ colId: "actions", sort: "asc" }] })) as { path: string }).path,
    ).not.toContain("sort=");
  });
});
