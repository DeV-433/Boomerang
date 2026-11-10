import {
  RowSelectionModule,
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
    RowSelectionModule,
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

// Matches the dashboard theme in styles.css: white surface, light rules, orange accent, rounded wrapper.
const shared = {
  fontFamily: "inherit",
  fontSize: 13,
  headerFontSize: 11,
  headerFontWeight: 500,
  wrapperBorderRadius: 20,
  wrapperBorder: false,
  columnBorder: false,
  rowVerticalPaddingScale: 1.3,
} as const;
const light = themeQuartz.withPart(colorSchemeLight).withParams({
  ...shared,
  accentColor: "#f0601e",
  backgroundColor: "#ffffff",
  foregroundColor: "#171717",
  headerBackgroundColor: "#ffffff",
  headerTextColor: "#8a8a86",
  borderColor: "#ececea",
  oddRowBackgroundColor: "#ffffff",
});
const dark = themeQuartz.withPart(colorSchemeDark).withParams({
  ...shared,
  accentColor: "#ff7a3d",
  backgroundColor: "#1e1e1c",
  headerBackgroundColor: "#1e1e1c",
  headerTextColor: "#9b9b95",
  borderColor: "#2f2f2c",
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
