#!/usr/bin/env node
/**
 * Keep `src/version.ts` in sync with `package.json#version`.
 *
 * Run this before building or publishing so the runtime MCP server version
 * reported during protocol initialization matches the repository version.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.join(path.dirname(__filename), '..');

const packagePath = path.join(projectRoot, 'package.json');
const versionPath = path.join(projectRoot, 'src', 'version.ts');

const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const version = pkg.version;

if (!version || typeof version !== 'string') {
  console.error('Missing or invalid version in package.json');
  process.exit(1);
}

const content = `/**
 * Single source of truth for the MCP server runtime version.
 *
 * This value is kept in sync with \`package.json\` by \`scripts/sync-version.mjs\`
 * during the build/publish flow. The runtime version is reported to MCP clients
 * during protocol initialization and must match the repository (package)
 * version unless explicitly noted otherwise.
 */
export const VERSION = '${version}';
`;

fs.writeFileSync(versionPath, content, 'utf8');
console.log(`Synced src/version.ts to ${version}`);
