/**
 * Path and workspace hashing helpers.
 */

import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const homedir = os.homedir();

export function computeWorkspaceHash(cwd) {
  const normalized = String(cwd).replace(/\\/g, '/');
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}

export function computeWorkspaceId(cwd) {
  if (!cwd || cwd === homedir) {
    return 'workspace-default';
  }
  return `workspace-${computeWorkspaceHash(cwd)}`;
}

export function getProjectRoot() {
  return path.resolve(__dirname, '..', '..');
}

export function relativeStorePath(storeRoot, filePath) {
  return path.relative(storeRoot, filePath).replace(/\\/g, '/');
}
