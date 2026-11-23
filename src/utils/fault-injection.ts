/**
 * Deterministic fault injection for crash-recovery tests.
 *
 * Enabled only through the `KIMI_MEMORY_FAULT` environment variable, which
 * carries a comma-separated list of `point:action` pairs (point names use
 * dots, never colons, so the pair separator stays unambiguous):
 *
 * - `remember.after-file-write:throw` — throw an `InjectedFaultError`.
 * - `remember.after-file-write:crash` — exit the process immediately
 *   (simulates a hard kill between the journal entry and the next step).
 *
 * Never set this variable in production: it exists for tests only.
 */

export class InjectedFaultError extends Error {
  readonly point: string;

  constructor(point: string) {
    super(`Injected fault at ${point}`);
    this.name = 'InjectedFaultError';
    this.point = point;
  }
}

export function faultPoint(point: string): void {
  const spec = process.env.KIMI_MEMORY_FAULT;
  if (!spec) return;
  for (const part of spec.split(',')) {
    const [name, action] = part.split(':');
    if (name !== point) continue;
    if (action === 'crash') {
      process.exit(70);
    }
    if (action === 'throw' || !action) {
      throw new InjectedFaultError(point);
    }
  }
}
