import { describe, expect, it } from "vitest";
import { groqKeys, loadConfig, requireConfig } from "../src/config";

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

describe("groqKeys", () => {
  it("puts GROQ_API_KEY first, then the extra keys, without blanks or repeats", () => {
    expect(groqKeys(loadConfig({ GROQ_API_KEY: "main", GROQ_API_KEYS: "a, b,,main,a" }))).toEqual([
      "main",
      "a",
      "b",
    ]);
    expect(groqKeys(loadConfig({ GROQ_API_KEY: "main" }))).toEqual(["main"]);
    expect(() => groqKeys(loadConfig({}))).toThrow(/GROQ_API_KEY/);
  });
});
