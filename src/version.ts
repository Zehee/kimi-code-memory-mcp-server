/**
 * Single source of truth for the MCP server runtime version.
 *
 * This value is kept in sync with `package.json` by `scripts/sync-version.mjs`
 * during the build/publish flow. The runtime version is reported to MCP clients
 * during protocol initialization and must match the repository (package)
 * version unless explicitly noted otherwise.
 */
export const VERSION = '1.1.0';
