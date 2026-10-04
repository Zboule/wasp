import { createHash } from 'node:crypto';

/** AgentCore's limit: `[A-Za-z][A-Za-z0-9_]{0,47}`, unique in the account and region. */
const MAX_RUNTIME_NAME = 48;

/**
 * The AgentCore runtime's name for an agent of an app's stage. It reads as
 * `app_stage_Agent`. When that is too long (a long branch stage), it keeps what
 * fits and ends with a hash of the whole, so two agents, or two stages sharing a
 * long prefix, never get the same name. A name that fits never changes: the
 * name is create-only, and changing it replaces the runtime.
 */
export function runtimeName(app: string, stage: string, agent: string): string {
  const full = `${app}_${stage}_${agent}`.replace(/[^A-Za-z0-9_]/g, '_').replace(/^[^A-Za-z]/, 'w');
  if (full.length <= MAX_RUNTIME_NAME) return full;
  const hash = createHash('sha256').update(`${app}\0${stage}\0${agent}`).digest('hex').slice(0, 8);
  return `${full.slice(0, MAX_RUNTIME_NAME - hash.length - 1)}_${hash}`;
}
