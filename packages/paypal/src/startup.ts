import { PINNED_TOOLKIT_VERSION, toolkitVersion, toolRegistry } from "./toolkit";
import { isRestOperation, TOOL_WHITELIST, type Profile } from "./whitelist";

export interface ToolkitReport {
  version: string;
  pinned: string;
  installedTools: string[];
  enabled: Record<Profile, string[]>;
  missing: string[];
}

/**
 * Step 2.2: what the installed toolkit offers and what each profile may use. Called at startup,
 * so a toolkit upgrade that renames or drops a whitelisted tool fails loudly instead of at 2 a.m.
 */
export function toolkitReport(): ToolkitReport {
  const registry = toolRegistry();
  const missing = new Set<string>();
  const enabled = {} as Record<Profile, string[]>;
  for (const [profile, tools] of Object.entries(TOOL_WHITELIST) as [Profile, readonly string[]][]) {
    enabled[profile] = [...tools];
    for (const tool of tools) if (!isRestOperation(tool) && !registry.has(tool)) missing.add(tool);
  }
  return {
    version: toolkitVersion(),
    pinned: PINNED_TOOLKIT_VERSION,
    installedTools: [...registry.keys()].sort(),
    enabled,
    missing: [...missing],
  };
}

export function assertToolkitReady(report: ToolkitReport = toolkitReport()): ToolkitReport {
  if (report.missing.length > 0) {
    throw new Error(
      `PayPal toolkit ${report.version} is missing whitelisted tools: ${report.missing.join(", ")}`,
    );
  }
  return report;
}
