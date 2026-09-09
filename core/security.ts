import path from 'path';

/**
 * Layered untrusted-input checks adapted from the threat-oriented safety model used by
 * Hermes/OpenClaw: tool names and paths are constrained before dispatch and external text
 * is marked untrusted before it can become an instruction source.
 */
const THREAT_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /system\s+message\s*:/i,
  /developer\s+message\s*:/i,
  /reveal\s+(the\s+)?(system|developer)\s+prompt/i,
  /print\s+(the\s+)?api[_ -]?key/i,
  /exfiltrat(e|ion)\s+.*(secret|token|key)/i,
  /curl\s+[^\n|]*\|\s*(sh|bash)/i,
  /wget\s+[^\n|]*\|\s*(sh|bash)/i
];

export interface SecurityFinding { code: string; message: string; severity: 'low' | 'medium' | 'high'; }

export function inspectUntrustedText(text: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  for (const pattern of THREAT_PATTERNS) {
    if (pattern.test(text)) findings.push({ code: 'prompt_injection_pattern', message: `Matched threat pattern: ${pattern.source}`, severity: 'high' });
  }
  return findings;
}

export function assertSafeRelativePath(root: string, requested: string): string {
  const rootReal = path.resolve(root);
  const resolved = path.resolve(rootReal, requested || '.');
  if (resolved !== rootReal && !resolved.startsWith(`${rootReal}${path.sep}`)) throw new Error(`Path escapes workspace: ${requested}`);
  return resolved;
}

export function assertSafeSkillName(name: string): string {
  const value = name.trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(value) || value === '.' || value === '..') throw new Error(`Invalid skill name: ${name}`);
  return value;
}

export function sanitizeExternalContent(text: string, maxChars = 12000): string {
  const bounded = text.length > maxChars ? `${text.slice(0, maxChars)}\n[external content truncated]` : text;
  return `[UNTRUSTED EXTERNAL CONTENT]\n${bounded}\n[/UNTRUSTED EXTERNAL CONTENT]`;
}
