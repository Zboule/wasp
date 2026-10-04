/**
 * How a tool call reads at a glance: a friendly name and a one-line summary of
 * its arguments. Arguments stream in as JSON fragments, so a parse can fail
 * mid-call; the summary then waits for the rest.
 */

/** `mcp__calendar__list_events` → `calendar · list_events`. */
export function toolLabel(name: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  return mcp ? `${mcp[1]} · ${mcp[2]}` : name;
}

export function parseArgs(args: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(args) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The argument people recognise a call by, in the order Claude's tools name them. */
const SUMMARY_KEYS = ['command', 'file_path', 'pattern', 'path', 'url', 'query', 'description', 'prompt', 'skill', 'name'];

export function toolSummary(args: string, max = 96): string {
  const parsed = parseArgs(args);
  if (!parsed) return '';
  const key = SUMMARY_KEYS.find((k) => typeof parsed[k] === 'string' && parsed[k]) ?? Object.keys(parsed).find((k) => typeof parsed[k] === 'string');
  const value = key ? String(parsed[key]).replace(/\s+/g, ' ').trim() : '';
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Pretty JSON when the arguments parse, the raw text while they stream. */
export function formatArgs(args: string): string {
  const parsed = parseArgs(args);
  return parsed ? JSON.stringify(parsed, null, 2) : args;
}
