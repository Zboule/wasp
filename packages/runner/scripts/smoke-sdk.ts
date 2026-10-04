/**
 * The drain loop against the real Agent SDK and model, with an in-memory store.
 *   CLAUDE_CODE_OAUTH_TOKEN=… node packages/runner/scripts/smoke-sdk.ts
 */
import type { Deliver, FeedEntry } from '@zboule/wasp-protocol';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { drain } from '../src/drain.ts';
import { createMemoryStore } from '@zboule/wasp-store';
import { sdkAgent } from '../src/sdkAgent.ts';

const store = createMemoryStore();
const agent = sdkAgent({ model: 'claude-haiku-4-5', workDir: mkdtempSync(path.join(tmpdir(), 'wasp-smoke-')), maxTurns: 10 });
const thread = crypto.randomUUID();
// Each post wakes a drain, as the waker Lambda does in production; a busy thread ignores it.
const drains: Promise<unknown>[] = [];
const post = async (text: string, deliver: Deliver = 'later') => {
  await store.enqueue(thread, { id: crypto.randomUUID(), text, deliver, createdAt: Date.now() });
  drains.push(drain(thread, { store, agent, owner: 'smoke', pollMs: 300 }));
};
const line = ({ event: e }: FeedEntry) =>
  e.type === 'CUSTOM' ? `> ${'text' in e.value ? e.value.text : e.name}`
  : e.type === 'TEXT_MESSAGE_CONTENT' ? `  ${e.delta.replace(/\s+/g, ' ').slice(0, 90)}`
  : e.type === 'TOOL_CALL_START' ? `  [${e.toolCallName}]`
  : e.type === 'TOOL_CALL_RESULT' ? `  [result${e.isError ? ' ERROR' : ''}] ${e.content.slice(0, 50).replace(/\s+/g, ' ')}`
  : e.type === 'RUN_FINISHED' ? `  -- ${e.result.outcome} ($${e.result.costUsd?.toFixed(4)})`
  : e.type === 'RUN_ERROR' ? `  -- error ${e.message}`
  : null;
const dump = async () => {
  for (const entry of await store.feed(thread)) {
    const text = line(entry);
    if (text) console.log(text);
  }
};
const until = async (predicate: (entries: FeedEntry[]) => boolean) => {
  const deadline = Date.now() + 120_000;
  while (!predicate(await store.feed(thread))) {
    if (Date.now() > deadline) {
      await dump();
      throw new Error('smoke: timed out waiting');
    }
    await new Promise((r) => setTimeout(r, 200));
  }
};
const hasTool = (n: number) => (entries: FeedEntry[]) => entries.filter((e) => e.event.type === 'TOOL_CALL_START').length >= n;

await post('Use Bash to run `sleep 5; echo ONE`, then `sleep 5; echo TWO`, then reply with one line listing what was printed.');
await until(hasTool(1));
await post('Also end that reply with the word BANANA.', 'asap');
await post('Then reply with only the word CHERRY.', 'later');
await until((entries) => entries.some((e) => e.event.type === 'TEXT_MESSAGE_CONTENT' && e.event.delta.includes('CHERRY')));
await post('Use Bash to run `sleep 30; echo SLOW` in the foreground, then reply with what it printed.', 'later');
await until(hasTool(3));
await post('Forget that. Reply with only the word STOPPED.', 'now');
while (drains.length) await drains.shift();

await dump();
