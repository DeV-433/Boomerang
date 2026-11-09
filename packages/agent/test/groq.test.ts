import { describe, expect, it } from "vitest";
import { GroqClient, GROQ_URL, parseDuration, type FetchLike, type ModelRequest } from "../src/model";

const req: ModelRequest = {
  kind: "decide",
  model: "openai/gpt-oss-120b",
  promptVersion: "decide-v2",
  system: "system prompt",
  input: '{"case":{}}',
  jsonSchema: {
    type: "object",
    properties: { a: { type: "string" } },
    required: ["a"],
    additionalProperties: false,
  },
  reasoning: "low",
};

function ok(
  content: string,
  usage = { prompt_tokens: 120, completion_tokens: 60, completion_tokens_details: { reasoning_tokens: 40 } },
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }], usage }), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

function scriptedFetch(responses: (Response | Error)[]) {
  const calls: { url: string; body: Record<string, unknown>; key: string }[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({
      url,
      body: JSON.parse(String(init?.body)),
      key: String((init?.headers as Record<string, string>).Authorization).replace("Bearer ", ""),
    });
    const next = responses.shift();
    if (!next) throw new Error("no scripted response");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetchFn, calls };
}

describe("Groq client", () => {
  it("sends a strict JSON-schema request with low reasoning and no tools", async () => {
    const { fetchFn, calls } = scriptedFetch([ok('{"a":"x"}')]);
    const client = new GroqClient("key", { fetchFn, sleep: async () => {} });
    const res = await client.generate(req);
    expect(calls[0]!.url).toBe(GROQ_URL);
    expect(calls[0]!.body).toMatchObject({
      model: "openai/gpt-oss-120b",
      temperature: 0,
      reasoning_effort: "low",
      include_reasoning: false,
      response_format: {
        type: "json_schema",
        json_schema: { name: "decide", strict: true, schema: req.jsonSchema },
      },
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: '{"case":{}}' },
      ],
    });
    expect(calls[0]!.body).not.toHaveProperty("tools");
    expect(res).toMatchObject({
      model: "openai/gpt-oss-120b",
      text: '{"a":"x"}',
      usage: { inputTokens: 120, outputTokens: 20, thinkingTokens: 40 },
    });
  });

  it("waits for retry-after on a 429 and tries the same model again", async () => {
    const sleeps: number[] = [];
    const { fetchFn, calls } = scriptedFetch([
      new Response('{"error":{"message":"Rate limit reached"}}', {
        status: 429,
        headers: { "retry-after": "3" },
      }),
      ok('{"a":"x"}'),
    ]);
    const client = new GroqClient("key", { fetchFn, sleep: async (ms) => void sleeps.push(ms) });
    const res = await client.generate(req);
    expect(res.model).toBe("openai/gpt-oss-120b");
    expect(calls.map((c) => c.body.model)).toEqual(["openai/gpt-oss-120b", "openai/gpt-oss-120b"]);
    expect(sleeps).toContain(3250);
  });

  it("falls back to the 20B model when the 120B model keeps failing", async () => {
    const { fetchFn, calls } = scriptedFetch([
      new Response("overloaded", { status: 503 }),
      new Response("overloaded", { status: 503 }),
      ok('{"a":"y"}'),
    ]);
    const res = await new GroqClient("key", { fetchFn, sleep: async () => {} }).generate(req);
    expect(res.model).toBe("openai/gpt-oss-20b");
    expect(calls.map((c) => c.body.model)).toEqual([
      "openai/gpt-oss-120b",
      "openai/gpt-oss-120b",
      "openai/gpt-oss-20b",
    ]);
  });

  it("does not retry a bad request", async () => {
    const { fetchFn, calls } = scriptedFetch([
      new Response('{"error":{"message":"invalid schema"}}', { status: 400 }),
    ]);
    await expect(
      new GroqClient("key", { fetchFn, sleep: async () => {} }).generate(req),
    ).rejects.toMatchObject({ retryable: false });
    expect(calls).toHaveLength(1);
  });

  it("retries when Groq's strict-mode check rejects a generation", async () => {
    const { fetchFn, calls } = scriptedFetch([
      new Response(
        '{"error":{"message":"Failed to generate JSON.","type":"invalid_request_error","code":"json_validate_failed"}}',
        { status: 400 },
      ),
      ok('{"a":"x"}'),
    ]);
    expect((await new GroqClient("key", { fetchFn, sleep: async () => {} }).generate(req)).text).toBe(
      '{"a":"x"}',
    );
    expect(calls).toHaveLength(2);
  });

  it("treats a timeout as retryable", async () => {
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), {
      name: "TimeoutError",
    });
    const { fetchFn } = scriptedFetch([timeout, ok('{"a":"z"}')]);
    expect((await new GroqClient("key", { fetchFn, sleep: async () => {} }).generate(req)).text).toBe(
      '{"a":"z"}',
    );
  });

  it("records the limits Groq reports and waits when the token budget is spent", async () => {
    const sleeps: number[] = [];
    const { fetchFn } = scriptedFetch([
      ok('{"a":"1"}', undefined, {
        "x-ratelimit-limit-tokens": "8000",
        "x-ratelimit-remaining-tokens": "100",
        "x-ratelimit-reset-tokens": "7.5s",
        "x-ratelimit-limit-requests": "1000",
        "x-ratelimit-remaining-requests": "998",
      }),
      ok('{"a":"2"}'),
    ]);
    const client = new GroqClient("key", { fetchFn, sleep: async (ms) => void sleeps.push(ms) });
    await client.generate(req);
    expect(client.limits.get("openai/gpt-oss-120b")).toMatchObject({
      limitTokensPerMinute: 8000,
      remainingTokens: 100,
      resetTokensMs: 7500,
      limitRequestsPerDay: 1000,
    });
    await client.generate(req);
    expect(sleeps.length).toBe(1);
    expect(sleeps[0]!).toBeGreaterThan(7000);
  });

  it("parses Groq's duration formats", () => {
    expect([
      parseDuration("7.66s"),
      parseDuration("1m2.5s"),
      parseDuration("120ms"),
      parseDuration("3"),
      parseDuration(null),
    ]).toEqual([7660, 62500, 120, 3000, null]);
  });

  describe("several keys", () => {
    const daily = (model = "openai/gpt-oss-120b") =>
      new Response(
        `{"error":{"message":"Rate limit reached for model \`${model}\` on tokens per day (TPD): Limit 200000, Used 199212"}}`,
        {
          status: 429,
          headers: { "retry-after": "152" },
        },
      );

    it("rotates calls across keys", async () => {
      const { fetchFn, calls } = scriptedFetch([
        ok('{"a":"1"}'),
        ok('{"a":"2"}'),
        ok('{"a":"3"}'),
        ok('{"a":"4"}'),
      ]);
      const client = new GroqClient(["k1", "k2", "k3"], { fetchFn, sleep: async () => {} });
      for (let i = 0; i < 4; i++) await client.generate(req);
      expect(calls.map((c) => c.key)).toEqual(["k1", "k2", "k3", "k1"]);
    });

    it("sets a key aside on its daily limit and moves to the next key without waiting", async () => {
      const sleeps: number[] = [];
      const limited: unknown[] = [];
      const { fetchFn, calls } = scriptedFetch([daily(), ok('{"a":"x"}'), ok('{"a":"y"}')]);
      const client = new GroqClient(["k1", "k2"], {
        fetchFn,
        sleep: async (ms) => void sleeps.push(ms),
        onKeyLimited: (i) => void limited.push(i),
      });
      expect((await client.generate(req)).model).toBe("openai/gpt-oss-120b");
      await client.generate(req);
      expect(calls.map((c) => c.key)).toEqual(["k1", "k2", "k2"]);
      expect(sleeps).toEqual([]);
      expect(limited).toMatchObject([{ keyIndex: 0, model: "openai/gpt-oss-120b", reason: "daily" }]);
    });

    it("goes to the fallback model only when every key has hit its daily limit, and never puts a key in the error", async () => {
      const { fetchFn, calls } = scriptedFetch([
        daily(),
        daily(),
        daily("openai/gpt-oss-20b"),
        daily("openai/gpt-oss-20b"),
      ]);
      const client = new GroqClient(["gsk_secret_one", "gsk_secret_two"], { fetchFn, sleep: async () => {} });
      const error = await client.generate(req).catch((e: Error) => e);
      expect(calls.map((c) => `${c.key} ${String(c.body.model)}`)).toEqual([
        "gsk_secret_one openai/gpt-oss-120b",
        "gsk_secret_two openai/gpt-oss-120b",
        "gsk_secret_one openai/gpt-oss-20b",
        "gsk_secret_two openai/gpt-oss-20b",
      ]);
      expect(String(error)).toContain("[key 2/2]");
      expect(String(error)).not.toContain("gsk_secret");
    });

    it("ignores blank and repeated keys", () => {
      expect(new GroqClient(["k1", " k1 ", "", "k2"]).keyCount).toBe(2);
      expect(() => new GroqClient([" "])).toThrow();
    });
  });
});
