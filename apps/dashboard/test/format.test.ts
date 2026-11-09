import { describe, expect, it } from "vitest";
import { count, money, pct, points } from "../src/format";

describe("dashboard formatting", () => {
  it("shows cents as dollars, compact only for large amounts", () => {
    expect(money(4_647_250)).toBe("$46,472.50");
    expect(money(4_647_250, { compact: true })).toBe("$46.5K");
    expect(money(4_000, { compact: true })).toBe("$40.00");
  });

  it("shows rates and signed percentage points with a real minus sign", () => {
    expect(pct(0.6537)).toBe("65.4%");
    expect(points(-8.93)).toBe("−8.9 pts");
    expect(points(4.2)).toBe("+4.2 pts");
    expect(points(null)).toBe("n/a");
    expect(count(1234)).toBe("1,234");
  });
});
