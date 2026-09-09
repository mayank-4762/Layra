import { promises as fs } from 'fs';
import path from 'path';

export interface SessionEvent { timestamp: string; eventType: string; description: string; data: unknown; sessionId?: string; runNumber?: number; }

/** Bounded retrieval over Layra's durable JSONL session journal. */
export async function searchSessionEvents(query: string, limit = 20, root = process.env.LAYRA_STATE_DIR || path.join(process.cwd(), '.state')): Promise<SessionEvent[]> {
  const bounded = Math.max(1, Math.min(100, Number(limit || 20)));
  let text: string;
  try { text = await fs.readFile(path.join(path.resolve(root), 'events.jsonl'), 'utf8'); }
  catch (error: any) { if (error?.code === 'ENOENT') return []; throw error; }
  const terms = String(query || '').toLowerCase().split(/[^a-z0-9_:-]+/).filter(Boolean);
  const lines = text.split('\n').filter(Boolean).slice(-5000);
  const events: SessionEvent[] = [];
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as SessionEvent;
      const haystack = `${event.eventType} ${event.description} ${JSON.stringify(event.data ?? '')}`.toLowerCase();
      if (!terms.length || terms.every(term => haystack.includes(term))) events.push(event);
    } catch { /* skip corrupted individual journal entries */ }
  }
  return events.slice(-bounded).reverse();
}
