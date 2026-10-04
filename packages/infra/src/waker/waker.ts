import type { DynamoDBStreamEvent } from 'aws-lambda';

export type WakeAction = { threadId: string; op: 'drain' | 'refresh' };

/**
 * What the table's stream asks for. The event source mapping already filters
 * to new queue items and wake/credential requests; a batch may hold several
 * records for one thread, which collapse into one action each.
 */
export function actionsFrom(event: DynamoDBStreamEvent): WakeAction[] {
  const actions = new Map<string, WakeAction>();
  for (const record of event.Records) {
    const pk = record.dynamodb?.Keys?.PK?.S;
    const sk = record.dynamodb?.Keys?.SK?.S;
    if (!pk?.startsWith('T#') || !sk) continue;
    const threadId = pk.slice(2);
    const op = sk === 'CTL#CREDENTIALS' ? 'refresh' : sk === 'CTL#WAKE' || sk.startsWith('Q#') ? 'drain' : null;
    if (op) actions.set(`${threadId}:${op}`, { threadId, op });
  }
  return [...actions.values()];
}

export type WakerDeps = {
  /** Thread-scoped credentials: STS AssumeRole on the thread role with `threadSessionPolicy`. */
  credentialsFor(threadId: string): Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: string }>;
  claude(): Promise<Record<string, string>>;
  /** InvokeAgentRuntime with the thread id as the session; resolves to the runtime's HTTP status. */
  invoke(threadId: string, payload: object): Promise<number>;
  log?: (message: string) => void;
};

export async function wake(actions: WakeAction[], deps: WakerDeps): Promise<void> {
  const log = deps.log ?? console.log;
  await Promise.all(
    actions.map(async ({ threadId, op }) => {
      const credentials = await deps.credentialsFor(threadId);
      const payload = op === 'drain' ? { op, threadId, credentials, claude: await deps.claude() } : { op, threadId, credentials };
      const status = await deps.invoke(threadId, payload);
      log(`wasp waker: ${op} ${threadId} → ${status}`);
      if (status >= 500) throw new Error(`runtime answered ${status} for ${op} ${threadId}`);
    })
  );
}
