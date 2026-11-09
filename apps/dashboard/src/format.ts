/** Display helpers. Money arrives as integer cents. */
export function money(cents: number, opts: { compact?: boolean } = {}): string {
  const dollars = cents / 100;
  if (opts.compact && Math.abs(dollars) >= 10_000) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(dollars);
  }
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(dollars);
}

export function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

/** Signed percentage points, with a real minus sign. */
export function points(p: number | null): string {
  if (p === null) return "n/a";
  const v = Math.abs(p).toFixed(1);
  return p > 0 ? `+${v} pts` : p < 0 ? `−${v} pts` : `0.0 pts`;
}

export function count(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

export function usd(value: number | null | undefined, digits = 4): string {
  if (value === null || value === undefined) return "n/a";
  return `$${value.toFixed(digits)}`;
}

export function dateTime(iso: string | null): string {
  if (!iso) return "never";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
