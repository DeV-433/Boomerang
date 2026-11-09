import { requireConfig, type Config, type Logger } from "@boomerang/core";
import type { Database } from "@boomerang/db";
import { TokenManager } from "./auth";
import { PayPalGateway } from "./gateway";
import { MemoryIdempotencyStore, PgIdempotencyStore } from "./idempotency";
import { PayPalWebhookVerifier } from "./webhooks";

export interface PayPalServices {
  tokens: TokenManager;
  gateway: PayPalGateway;
  verifier: PayPalWebhookVerifier;
}

/** Wires the PayPal layer from configuration. Without a database, idempotency is kept in memory. */
export function createPayPal(
  config: Config,
  options: { db?: Database; logger?: Logger } = {},
): PayPalServices {
  const tokens = new TokenManager({
    clientId: requireConfig(config, "PAYPAL_CLIENT_ID"),
    clientSecret: requireConfig(config, "PAYPAL_CLIENT_SECRET"),
    environment: config.PAYPAL_ENVIRONMENT,
  });
  const idempotency = options.db ? new PgIdempotencyStore(options.db) : new MemoryIdempotencyStore();
  return {
    tokens,
    gateway: new PayPalGateway({ tokens, idempotency, logger: options.logger }),
    verifier: new PayPalWebhookVerifier(tokens, config.PAYPAL_WEBHOOK_ID),
  };
}
