import { describe, expect, it } from "vitest";
import { EXPIRY_MARGIN_MS, TokenManager } from "../src/auth";
import { PayPalHttpError, type FetchLike } from "../src/http";

/** Token endpoint stub that hands out token-1, token-2, ... each valid for one hour. */
function tokenEndpoint(expiresIn = 3600) {
  let issued = 0;
  const fetchFn: FetchLike = async () => {
    issued++;
    await new Promise((r) => setTimeout(r, 1));
    return new Response(JSON.stringify({ access_token: `token-${issued}`, expires_in: expiresIn }), { status: 200 });
  };
  return { fetchFn, issued: () => issued };
}

const creds = { clientId: "id", clientSecret: "secret", environment: "SANDBOX" as const };

describe("TokenManager (2.1)", () => {
  it("caches the token and refreshes it just before expiry, using a fake clock", async () => {
    let now = 1_000_000;
    const endpoint = tokenEndpoint(3600);
    const tokens = new TokenManager(creds, endpoint.fetchFn, () => now);

    expect(await tokens.getToken()).toBe("token-1");
    now += 3600_000 - EXPIRY_MARGIN_MS - 1; // one millisecond before the refresh point
    expect(await tokens.getToken()).toBe("token-1");
    expect(endpoint.issued()).toBe(1);

    now += 1; // exactly at the refresh point: 5 minutes before PayPal's expiry
    expect(await tokens.getToken()).toBe("token-2");
    expect(endpoint.issued()).toBe(2);
  });

  it("shares one in-flight request between concurrent callers", async () => {
    const endpoint = tokenEndpoint();
    const tokens = new TokenManager(creds, endpoint.fetchFn);
    const results = await Promise.all(Array.from({ length: 10 }, () => tokens.getToken()));
    expect(new Set(results)).toEqual(new Set(["token-1"]));
    expect(endpoint.issued()).toBe(1);
  });

  it("retries exactly once with a fresh token on 401", async () => {
    const endpoint = tokenEndpoint();
    const tokens = new TokenManager(creds, endpoint.fetchFn);
    const seen: string[] = [];
    const result = await tokens.withToken(async (token) => {
      seen.push(token);
      if (token === "token-1") throw new PayPalHttpError(401, "{}", null, "test");
      return "ok";
    });
    expect(result).toBe("ok");
    expect(seen).toEqual(["token-1", "token-2"]);
  });

  it("gives up after the single retry if PayPal still answers 401", async () => {
    const tokens = new TokenManager(creds, tokenEndpoint().fetchFn);
    let calls = 0;
    const always401 = tokens.withToken(async () => {
      calls++;
      throw new PayPalHttpError(401, "{}", null, "test");
    });
    await expect(always401).rejects.toMatchObject({ status: 401 });
    expect(calls).toBe(2);
  });

  it("does not retry other errors", async () => {
    const tokens = new TokenManager(creds, tokenEndpoint().fetchFn);
    let calls = 0;
    await expect(
      tokens.withToken(async () => {
        calls++;
        throw new PayPalHttpError(422, "{}", null, "test");
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect(calls).toBe(1);
  });

  it("surfaces a failed token request with PayPal's body and debug id", async () => {
    const fetchFn: FetchLike = async () =>
      new Response('{"error":"invalid_client"}', { status: 401, headers: { "paypal-debug-id": "dbg-1" } });
    const tokens = new TokenManager(creds, fetchFn);
    await expect(tokens.getToken()).rejects.toMatchObject({ status: 401, debugId: "dbg-1", errorName: "invalid_client" });
  });
});
