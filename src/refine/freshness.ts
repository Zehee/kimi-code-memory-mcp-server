import crypto from 'node:crypto';
import fs from 'node:fs';
import type { RawTurn } from './types.js';

type HashableTurn = Omit<RawTurn, 'timestamp'> & { timestamp?: string | null };

export function hashRawTurn(turn: HashableTurn): string {
  const normalized = {
    turnId: String(turn.turnId ?? ''),
    timestamp: turn.timestamp ?? null,
    user: turn.user ?? '',
    agentText: turn.agentText ?? turn.agent ?? '',
    actions: (turn.actions ?? []).map((action) => ({
      name: action.name ?? '',
      args: action.args ?? '',
      result: action.result ?? '',
    })),
  };
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

export function buildWireIdentityFromHashes(entries: Array<[string, string]>): string {
  const contentHash = crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  return JSON.stringify({ turnCount: entries.length, contentHash });
}

export function buildWireIdentity(turns: HashableTurn[]): string {
  return buildWireIdentityFromHashes(
    turns.map((turn) => [String(turn.turnId ?? ''), hashRawTurn(turn)]),
  );
}

export function readWireTurnCount(identity: string | null): number | null {
  if (!identity) return null;
  try {
    const parsed = JSON.parse(identity) as { turnCount?: unknown; refinedCount?: unknown };
    const count = parsed.turnCount ?? parsed.refinedCount;
    return typeof count === 'number' && Number.isInteger(count) && count >= 0 ? count : null;
  } catch {
    return null;
  }
}

export function withWirePrefixHash(identity: string, prefixHash: string): string {
  return JSON.stringify({ ...JSON.parse(identity), prefixHash });
}

export function readWirePrefixHash(identity: string | null): string | null {
  if (!identity) return null;
  try {
    const parsed = JSON.parse(identity) as { prefixHash?: unknown };
    return typeof parsed.prefixHash === 'string' && parsed.prefixHash ? parsed.prefixHash : null;
  } catch {
    return null;
  }
}

export function hashWireFilePrefix(filePath: string, endOffset: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    if (endOffset <= 0) {
      resolve(hash.digest('hex'));
      return;
    }
    const stream = fs.createReadStream(filePath, { start: 0, end: endOffset - 1 });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
