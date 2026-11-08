import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const PAYPAL = { group: ["@paypal/*"], message: "Only packages/paypal may import the PayPal toolkit." };
const MODEL = { group: ["@google/genai", "@google/*"], message: "Only packages/agent may import the model SDK." };
const BOUNDARY = {
  group: ["@boomerang/agent", "@boomerang/paypal"],
  message: "The policy gate and audit writer must never reach the model or PayPal.",
};

function restrictImports(files, ignores, patterns) {
  return { files, ignores, rules: { "no-restricted-imports": ["error", { patterns }] } };
}

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/coverage/**", "packages/db/drizzle/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  // Dependency rules from BUILD_PLAN.md: only packages/paypal imports the PayPal toolkit, only
  // packages/agent imports the model SDK, and the gate and audit log may import neither.
  restrictImports(["**/*.ts"], ["packages/paypal/**", "packages/agent/**", "packages/policy/**", "packages/audit/**"], [PAYPAL, MODEL]),
  restrictImports(["packages/paypal/**"], [], [MODEL]),
  restrictImports(["packages/agent/**"], [], [PAYPAL]),
  restrictImports(["packages/policy/**", "packages/audit/**"], [], [PAYPAL, MODEL, BOUNDARY]),
);
