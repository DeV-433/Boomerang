import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { anonymizeIp, createLogger, scrub } from "../src/logger";

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, done) {
      lines.push(String(chunk));
      done();
    },
  });
  return { logger: createLogger({ level: "info" }, stream), text: () => lines.join("") };
}

describe("log redaction (9.7)", () => {
  it("scrubs emails, pay-page tokens, bearer tokens and keys from any string", () => {
    expect(scrub("mail ada.l+x@example.com now")).toBe("mail [email] now");
    expect(scrub("GET /pay/eyJhbGciOi.abc-DEF_123?x=1")).toBe("GET /pay/[token]?x=1");
    expect(scrub("Authorization: Bearer abc.def-123")).toBe("Authorization: Bearer [redacted]");
    expect(scrub("key gsk_ABCDEFGH12345678")).toBe("key [groq-key]");
    expect(scrub("token A21AAKx-very_long_paypal_token_value")).toBe("token [paypal-token]");
    expect(scrub("t=1762800000,v1=0123456789abcdef0123")).toBe("[sim-signature]");
  });

  it("truncates client addresses", () => {
    expect(anonymizeIp("203.0.113.7")).toBe("203.0.113.0");
    expect(anonymizeIp("2001:db8:85a3:8d3:1319:8a2e:370:7348")).toBe("2001:db8:85a3::");
  });

  it("applies to messages, nested fields, errors and PayPal error bodies", () => {
    const { logger, text } = capture();
    logger.info(
      { customer: { email: "ada@example.com", name: "x" }, note: "write to bob@example.org" },
      "sent to ada@example.com",
    );
    logger.warn(
      { body: '{"details":[{"issue":"PAYER","description":"payer carol@example.net"}]}' },
      "PayPal call failed",
    );
    logger.error({ err: new Error("failed for dave@example.com at /pay/SECRET.TOKEN") }, "boom");
    logger.info(
      { authorization: "Bearer zzz.yyy", apiKey: "k", headers: { authorization: "Bearer q" } },
      "auth",
    );
    const out = text();
    expect(out).not.toMatch(/@example\.(com|org|net)/);
    expect(out).not.toContain("SECRET.TOKEN");
    expect(out).not.toContain("zzz.yyy");
    expect(out).toContain("[email]");
    expect(out).toContain("/pay/[token]");
    expect(out).toContain('"message":"failed for [email] at /pay/[token]"');
  });

  it("logs a request's URL without its pay token and with a truncated address", () => {
    const { logger, text } = capture();
    logger.info(
      { req: { method: "GET", url: "/pay/abc.def", ip: "198.51.100.23", hostname: "h" } },
      "incoming request",
    );
    expect(JSON.parse(text()).req).toEqual({
      method: "GET",
      url: "/pay/[token]",
      hostname: "h",
      remoteAddress: "198.51.100.0",
    });
  });

  it("never logs a failed query's parameters (message bodies, names)", () => {
    const { logger, text } = capture();
    const err = Object.assign(
      new Error(
        'Failed query: update "actions" set "tool_call" = $1\nparams: {"body":"Hi Silva Media, you owe"}',
      ),
      { query: 'update "actions" set "tool_call" = $1', params: ['{"body":"Hi Silva Media"}'] },
    );
    logger.error({ err }, "case check failed");
    const out = text();
    expect(out).not.toContain("Silva");
    expect(out).toContain("params: [redacted]");
  });
});
