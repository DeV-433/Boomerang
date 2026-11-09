import { describe, expect, it } from "vitest";
import { loadSimConfig, parseSimConfig, withOverrides } from "../src/config";
import { CUSTOMER_TYPES } from "../src/types";

describe("simulator config (3.1)", () => {
  const config = loadSimConfig();

  it("loads the documented config file and covers every customer type", () => {
    expect(config.horizonDays).toBeGreaterThan(0);
    for (const type of CUSTOMER_TYPES) {
      expect(config.responses[type]?.default, type).toBeDefined();
      expect(config.dailySelfPay[type], type).toBeGreaterThanOrEqual(0);
      expect(config.promise.keepProbability[type], type).toBeGreaterThanOrEqual(0);
    }
  });

  it("rejects a response row whose probabilities exceed 1", () => {
    const bad = structuredClone(config) as unknown as {
      responses: Record<string, Record<string, Record<string, number>>>;
    };
    bad.responses.slow_payer!.default = { pay: 0.7, promise: 0.3, dispute: 0.1, optOut: 0 };
    expect(() => parseSimConfig(bad)).toThrow(/sum to at most 1/);
  });

  it("rejects a type mix that does not sum to 1", () => {
    expect(() => withOverrides(config, (c) => (c.batch.typeMix.invoice.slow_payer = 0.9))).toThrow(
      /typeMix.invoice/,
    );
  });

  it("supports overrides without touching the original", () => {
    const changed = withOverrides(config, (c) => (c.horizonDays = 10));
    expect(changed.horizonDays).toBe(10);
    expect(config.horizonDays).not.toBe(10);
  });
});
