import {
  ColumnApiModule,
  RowApiModule,
  CellStyleModule,
  ClientSideRowModelModule,
  colorSchemeDark,
  colorSchemeLight,
  ModuleRegistry,
  NumberFilterModule,
  PaginationModule,
  TextFilterModule,
  themeQuartz,
  TooltipModule,
  ValidationModule,
} from "ag-grid-community";
import {
  ColumnMenuModule,
  ColumnsToolPanelModule,
  LicenseManager,
  MasterDetailModule,
  RowGroupingModule,
  RowGroupingPanelModule,
  ServerSideRowModelApiModule,
  ServerSideRowModelModule,
  SetFilterModule,
} from "ag-grid-enterprise";
import { useEffect, useState } from "react";

/** Registers the AG Grid modules the dashboard uses (not AllEnterpriseModule, to keep the bundle small) and the licence. */
let registered = false;
export function setupGrid(): void {
  if (registered) return;
  registered = true;
  ModuleRegistry.registerModules([
    ServerSideRowModelModule,
    ServerSideRowModelApiModule,
    RowGroupingModule,
    RowGroupingPanelModule,
    SetFilterModule,
    ColumnMenuModule,
    ColumnsToolPanelModule,
    MasterDetailModule,
    PaginationModule,
    CellStyleModule,
    ClientSideRowModelModule,
    ColumnApiModule,
    RowApiModule,
    TextFilterModule,
    NumberFilterModule,
    TooltipModule,
    ...(import.meta.env.DEV ? [ValidationModule] : []),
  ]);
  const key = import.meta.env.VITE_AG_GRID_LICENSE_KEY as string | undefined;
  if (key) LicenseManager.setLicenseKey(key);
}

const light = themeQuartz
  .withPart(colorSchemeLight)
  .withParams({ fontFamily: "inherit", fontSize: 13, headerFontWeight: 600, accentColor: "#2f5bd3" });
const dark = themeQuartz.withPart(colorSchemeDark).withParams({
  fontFamily: "inherit",
  fontSize: 13,
  headerFontWeight: 600,
  accentColor: "#7c9cf0",
  backgroundColor: "#1d1d1b",
});

/** The grid theme follows the operating system's light or dark setting, live. */
export function useGridTheme() {
  const query = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const [isDark, setDark] = useState(query?.matches ?? false);
  useEffect(() => {
    if (!query) return;
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [query]);
  return isDark ? dark : light;
}
