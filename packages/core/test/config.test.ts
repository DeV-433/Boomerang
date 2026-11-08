import { describe, expect, it } from "vitest";
import { loadConfig, requireConfig } from "../src/config";

describe("loadConfig", () => {
  it("applies safe defaults", () => {
    const config = loadConfig({});
    expect(config.PAYPAL_ENVIRONMENT).toBe("SANDBOX");
    expect(config.POLICY_MODE).toBe("dry_run");
    expect(config.PORT).toBe(3000);
  });

  it("treats empty strings as unset", () => {
    const config = loadConfig({ PAYPAL_WEBHOOK_ID: "  " });
    expect(config.PAYPAL_WEBHOOK_ID).toBeUndefined();
  });

  it("rejects an unknown policy mode", () => {
    expect(() => loadConfig({ POLICY_MODE: "yolo" })).toThrow(/POLICY_MODE/);
  });

  it("names the missing variable", () => {
    expect(() => requireConfig(loadConfig({}), "DATABASE_URL")).toThrow(/DATABASE_URL/);
  });
});
