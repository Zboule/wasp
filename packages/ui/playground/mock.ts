import type { CancelResult, Deliver, FeedEntry, FeedEvent, FeedPage, QueuedMessage, ThreadState, WaspFile } from '@zboule/wasp-protocol';

import type { WaspTransport } from '../src/index.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A scripted agent behind the real transport interface: the queue, `later` /
 * `asap` / `now`, interrupt and cancel behave like the runner's, so the UI
 * can be exercised without AWS. Say "long" for a slow turn, "fail" for errors.
 */
export function mockTransport({ seed = true } = {}): WaspTransport {
  const entries: FeedEntry[] = [];
  let queue: QueuedMessage[] = [];
  let state: ThreadState = 'idle';
  let seq = 0;
  let running = false;
  let interrupt = false;
  const uploaded = new Map<string, WaspFile>();

  const emit = (event: FeedEvent) => entries.push({ cursor: String(++seq).padStart(8, '0'), at: Date.now(), event });
  const deliverMsg = (m: QueuedMessage) =>
    emit({
      type: 'CUSTOM',
      name: 'wasp.message',
      value: { messageId: m.id, text: m.text, deliver: m.deliver, ...(m.attachments ? { attachments: m.attachments } : {}) }
    });

  async function say(text: string) {
    const id = `a${++seq}`;
    emit({ type: 'TEXT_MESSAGE_START', messageId: id, role: 'assistant' });
    for (const chunk of text.match(/\S+\s*|\s+/g) ?? []) {
      if (interrupt) return false;
      emit({ type: 'TEXT_MESSAGE_CONTENT', messageId: id, delta: chunk });
      await sleep(18);
    }
    emit({ type: 'TEXT_MESSAGE_END', messageId: id });
    return true;
  }

  async function tool(name: string, args: object, result: string, { ms = 700, error = false, outputRef = false } = {}) {
    const id = `t${++seq}`;
    emit({ type: 'TOOL_CALL_START', toolCallId: id, toolCallName: name });
    emit({ type: 'TOOL_CALL_ARGS', toolCallId: id, delta: JSON.stringify(args) });
    emit({ type: 'TOOL_CALL_END', toolCallId: id });
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (interrupt) return false;
      await sleep(100);
    }
    emit({
      type: 'TOOL_CALL_RESULT',
      messageId: `r${seq}`,
      toolCallId: id,
      content: result,
      ...(error ? { isError: true } : {}),
      ...(outputRef ? { outputRef: 'https://example.com/full-output.txt' } : {})
    });
    return await between();
  }

  /** Between steps: an `asap` message joins the turn, a `now` one ends it. */
  async function between() {
    if (interrupt) return false;
    if (queue.some((m) => m.deliver === 'now')) {
      interrupt = true;
      return false;
    }
    const asap = queue.filter((m) => m.deliver === 'asap');
    if (asap.length) {
      queue = queue.filter((m) => m.deliver !== 'asap');
      for (const m of asap) deliverMsg(m);
      return say(`Noted: “${asap.map((m) => m.text).join('”, “')}”. Carrying on with that in mind.\n\n`);
    }
    return true;
  }

  async function turn(m: QueuedMessage) {
    const text = m.text.toLowerCase();
    const steps: (() => Promise<boolean>)[] = [];
    if (m.attachments?.length) {
      const names = m.attachments.map((f) => f.name);
      steps.push(
        () => tool('Bash', { command: `ls -la files/*/` }, names.map((n) => `-rw-r--r-- 1 agent agent 1234 ${n}`).join('\n')),
        () =>
          say(
            `I have ${names.length === 1 ? 'your file' : `your ${names.length} files`}: ${names.map((n) => `\`${n}\``).join(', ')}. What should I do with ${names.length === 1 ? 'it' : 'them'}?`
          )
      );
    } else if (text.includes('fail')) {
      steps.push(
        () => tool('Bash', { command: 'cat /etc/missing.conf' }, 'cat: /etc/missing.conf: No such file or directory', { error: true }),
        async () => {
          emit({ type: 'RUN_ERROR', message: 'API Error: 529 overloaded_error' });
          return false;
        }
      );
    } else if (text.includes('long')) {
      steps.push(
        () => say('This will take a moment. I will check three things in turn.\n'),
        () => tool('Bash', { command: 'sleep 3 && du -sh /var/log', description: 'Size the logs' }, '1.2G\t/var/log', { ms: 3000 }),
        () => tool('mcp__calendar__list_events', { from: '2026-10-04', to: '2026-10-11' }, '[{"title":"Standup","at":"09:30"}]', { ms: 3000 }),
        () => tool('Read', { file_path: '/srv/app/config/production.yaml' }, 'server:\n  port: 8080\n  workers: 4', { ms: 3000 }),
        () => say('Done: the logs take **1.2 GB**, there is one event this week, and the app runs **4 workers**.')
      );
    } else {
      steps.push(
        () => say('Let me look.'),
        () => tool('Bash', { command: 'uname -m && node -v', description: 'Machine and Node version' }, 'aarch64\nv24.21.0'),
        () =>
          say(
            [
              'The sandbox is an **ARM64** machine running Node `v24.21.0`.',
              '',
              '### What that means',
              '- Native modules must be built for `linux/arm64`',
              '- Images pulled from a registry need an arm64 variant',
              '',
              '| Check | Result |',
              '|:--|--:|',
              '| Architecture | aarch64 |',
              '| Node | 24.21.0 |',
              '',
              '```sh',
              'docker buildx build --platform linux/arm64 .',
              '```',
              '',
              'More in the [AgentCore docs](https://docs.aws.amazon.com/bedrock-agentcore/).'
            ].join('\n')
          )
      );
    }
    for (const step of steps) if (!(await step())) break;
  }

  async function loop() {
    if (running) return;
    running = true;
    state = 'waking_up';
    await sleep(900);
    state = 'working';
    while (queue.length) {
      // `now` first, then the rest in order.
      const next = queue.find((m) => m.deliver === 'now') ?? queue[0]!;
      queue = queue.filter((m) => m !== next);
      interrupt = false;
      deliverMsg(next);
      await turn(next);
      emit({ type: 'RUN_FINISHED', threadId: 'demo', runId: `run${seq}`, result: { outcome: interrupt ? 'interrupted' : 'done', costUsd: 0.02 } });
      interrupt = false;
    }
    state = 'idle';
    running = false;
  }

  if (seed) {
    deliverMsg({ id: 'seed-u1', text: 'What does the sandbox run on?', deliver: 'later', createdAt: 0 });
    emit({ type: 'TEXT_MESSAGE_START', messageId: 'seed-a1', role: 'assistant' });
    emit({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'seed-a1', delta: 'I will check the machine and what is installed.' });
    for (const [id, name, args, out, error] of [
      ['seed-t1', 'Bash', { command: 'uname -a' }, 'Linux localhost 6.1.0 #1 SMP aarch64 GNU/Linux', false],
      ['seed-t2', 'Bash', { command: 'ls /opt/tools' }, 'ls: cannot access /opt/tools: No such file or directory', true],
      ['seed-t3', 'Grep', { pattern: 'TODO', path: '/workspace' }, Array.from({ length: 40 }, (_, i) => `src/file${i}.ts:12: // TODO tidy`).join('\n'), false]
    ] as const) {
      emit({ type: 'TOOL_CALL_START', toolCallId: id, toolCallName: name });
      emit({ type: 'TOOL_CALL_ARGS', toolCallId: id, delta: JSON.stringify(args) });
      emit({
        type: 'TOOL_CALL_RESULT',
        messageId: `${id}r`,
        toolCallId: id,
        content: out,
        ...(error ? { isError: true } : {}),
        ...(id === 'seed-t3' ? { outputRef: 'https://example.com/out' } : {})
      });
    }
    emit({ type: 'TEXT_MESSAGE_START', messageId: 'seed-a2', role: 'assistant' });
    emit({
      type: 'TEXT_MESSAGE_CONTENT',
      messageId: 'seed-a2',
      delta:
        'It is a **Linux arm64** microVM. There is no `/opt/tools`, and the workspace has *40* TODOs left.\n\n1. Check the image\n2. Clean the TODOs\n\n> Everything here runs inside the sandbox.'
    });
    emit({ type: 'RUN_FINISHED', threadId: 'demo', runId: 'seed', result: { outcome: 'done' } });
    deliverMsg({ id: 'seed-u2', text: 'Stop, that is enough for now.', deliver: 'now', createdAt: 0 });
    emit({ type: 'RUN_FINISHED', threadId: 'demo', runId: 'seed2', result: { outcome: 'interrupted' } });
  }

  return {
    async feed(after): Promise<FeedPage> {
      await sleep(40);
      const fresh = entries.filter((e) => !after || e.cursor > after);
      return { state, queue: queue.map((m) => ({ ...m })), entries: fresh, cursor: fresh.at(-1)?.cursor ?? after };
    },
    async upload(file: File, onProgress?: (fraction: number) => void) {
      if (file.name.toLowerCase().includes('fail')) {
        await sleep(400);
        throw new Error('Upload refused (403)');
      }
      for (let step = 1; step <= 10; step++) {
        await sleep(90);
        onProgress?.(step / 10);
      }
      const id = crypto.randomUUID();
      const ref = `payloads/demo/files/${id}/${file.name}`;
      uploaded.set(ref, {
        id,
        name: file.name,
        mediaType: file.type || 'application/octet-stream',
        size: file.size,
        ref,
        url: `https://example.com/files/${encodeURIComponent(file.name)}`
      });
      return ref;
    },
    async post(text: string, deliver: Deliver, files?: string[]) {
      await sleep(60);
      const attachments = (files ?? []).map((ref) => uploaded.get(ref)).filter((f): f is WaspFile => Boolean(f));
      const m: QueuedMessage = {
        id: crypto.randomUUID(),
        text,
        deliver: running ? deliver : 'later',
        createdAt: Date.now(),
        ...(attachments.length ? { attachments } : {})
      };
      queue.push(m);
      void loop();
      return { messageId: m.id, position: queue.length - 1 };
    },
    async interrupt() {
      await sleep(60);
      if (running) interrupt = true;
    },
    async cancel(messageId: string): Promise<CancelResult> {
      await sleep(60);
      const before = queue.length;
      queue = queue.filter((m) => m.id !== messageId);
      return queue.length < before ? 'cancelled' : 'missing';
    }
  };
}
