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

  it("treats blank values copied from .env.example as unset, using the defaults (10.4)", () => {
    const config = loadConfig({ MERCHANT_NAME: "", PORT: "", GROQ_RPM: " ", LOG_LEVEL: "" });
    expect(config.MERCHANT_NAME).toBe("Boomerang Demo Store");
    expect(config.PORT).toBe(3000);
    expect(config.GROQ_RPM).toBeUndefined();
    expect(config.LOG_LEVEL).toBe("info");
  });

  it("loads the shipped .env.example as it is", async () => {
    const { readFileSync } = await import("node:fs");
    const text = readFileSync(new URL("../../../.env.example", import.meta.url), "utf8");
    const env = Object.fromEntries(
      text
        .split("\n")
        .filter((l) => /^[A-Z_]+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    expect(() => loadConfig(env)).not.toThrow();
  });

  it("rejects an unknown policy mode", () => {
    expect(() => loadConfig({ POLICY_MODE: "yolo" })).toThrow(/POLICY_MODE/);
  });

  it("reads offline mode (10.3), off by default", () => {
    expect(loadConfig({}).BOOMERANG_OFFLINE).toBe(false);
    expect(loadConfig({ BOOMERANG_OFFLINE: "true" }).BOOMERANG_OFFLINE).toBe(true);
    expect(loadConfig({ BOOMERANG_OFFLINE: "1" }).BOOMERANG_OFFLINE).toBe(true);
    expect(loadConfig({ BOOMERANG_OFFLINE: "false" }).BOOMERANG_OFFLINE).toBe(false);
    expect(() => loadConfig({ BOOMERANG_OFFLINE: "maybe" })).toThrow(/BOOMERANG_OFFLINE/);
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
