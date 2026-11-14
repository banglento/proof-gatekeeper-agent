import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Persistent local state (JSON file, atomic replace on write):
 *  - seenProofTx: every proof_tx the agent has ever processed (reuse trap).
 *  - responses:   task_id -> raw response body string (idempotency:
 *                 a platform retry must get the identical response back).
 */
export class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.seenProofTx = new Set();
    this.responses = new Map();
    if (existsSync(filePath)) {
      try {
        const data = JSON.parse(readFileSync(filePath, 'utf8'));
        this.seenProofTx = new Set(data.seenProofTx ?? []);
        this.responses = new Map(Object.entries(data.responses ?? {}));
      } catch {
        // Corrupt state file: start clean rather than crash (fail-closed
        // decision logic still applies to every task).
        console.error(`[store] warning: could not parse ${filePath}, starting empty`);
      }
    }
  }

  hasSeenProofTx(tx) {
    return this.seenProofTx.has(normalizeTx(tx));
  }

  markProofTxSeen(tx) {
    this.seenProofTx.add(normalizeTx(tx));
  }

  getResponse(taskId) {
    return this.responses.get(taskId) ?? null;
  }

  saveResponse(taskId, rawBody) {
    this.responses.set(taskId, rawBody);
  }

  flush() {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify({
      seenProofTx: [...this.seenProofTx],
      responses: Object.fromEntries(this.responses),
    }));
    renameSync(tmp, this.filePath);
  }
}

function normalizeTx(tx) {
  return String(tx ?? '').trim().toLowerCase();
}
