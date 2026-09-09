import { ChatMessage } from '../config/model-provider';

export interface ContextPolicy { maxMessages?: number; maxChars?: number; preserveRecent?: number; }

/** Bounded context policy modeled on Hermes' compression-first approach: preserve the live turn and recent evidence. */
export function compressMessages(messages: ChatMessage[], policy: ContextPolicy = {}): ChatMessage[] {
  const maxMessages = Math.max(8, policy.maxMessages ?? 40);
  const maxChars = Math.max(8000, policy.maxChars ?? 60000);
  const preserveRecent = Math.max(4, policy.preserveRecent ?? 12);
  if (messages.length <= maxMessages && messages.reduce((n, m) => n + (m.content?.length || 0), 0) <= maxChars) return messages;

  const head = messages.slice(0, 2);
  const recent = messages.slice(-preserveRecent);
  const middle = messages.slice(head.length, Math.max(head.length, messages.length - preserveRecent));
  const summary = middle.map(message => `${message.role}: ${(message.content || '').replace(/\s+/g, ' ').slice(0, 700)}`).join('\n');
  const compact: ChatMessage[] = [...head, { role: 'user', content: `[COMPACTED CONTEXT]\n${summary.slice(0, 12000)}\n[/COMPACTED CONTEXT]` }, ...recent];

  while (compact.length > maxMessages) compact.splice(3, 1);
  return trimChars(compact, maxChars);
}

function trimChars(messages: ChatMessage[], maxChars: number): ChatMessage[] {
  let total = messages.reduce((n, m) => n + (m.content?.length || 0), 0);
  if (total <= maxChars) return messages;
  for (let i = 3; i < messages.length && total > maxChars; i++) {
    const message = messages[i];
    const allowed = Math.max(160, message.content.length - (total - maxChars));
    if (allowed < message.content.length) {
      total -= message.content.length - allowed;
      messages[i] = { ...message, content: `${message.content.slice(0, allowed)}\n[message truncated]` };
    }
  }
  return messages;
}
