import type { Agent, AgentEvent, AgentInput, AgentSession } from '../agent.ts';

export type Gate = { promise: Promise<void>; open(): void };
export function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

/** One step of a scripted turn. A tool step blocks until its gate opens (or the turn is interrupted). */
export type Step = { say: string } | { tool: string; output?: string; until?: Promise<void> };
export type Script = (text: string) => Step[];

/**
 * A fake agent that behaves like the Agent SDK in the ways the drain loop relies
 * on (checked against the real SDK, see issue #4):
 * - a `next` message joins the running turn at its next tool boundary; the
 *   fake acknowledges it with `ack:<text>` so tests can see where it landed
 * - a plain message waits and starts the next turn
 * - interrupt() kills the running tool and ends the turn as `interrupted`
 */
export function scriptedAgent(script: Script = (text) => [{ say: `echo:${text}` }]) {
  const sent: AgentInput[] = [];
  const agent: Agent = {
    async open() {
      return openSession(script, sent);
    }
  };
  return { agent, sent };
}

function openSession(script: Script, sent: AgentInput[]): AgentSession {
  const inputs: AgentInput[] = [];
  let ended = false;
  let wake: (() => void) | null = null;
  let interruptTurn: (() => void) | null = null;
  const notify = () => {
    wake?.();
    wake = null;
  };
  const nextInput = async (): Promise<AgentInput | null> => {
    for (;;) {
      const input = inputs.shift();
      if (input) return input;
      if (ended) return null;
      await new Promise<void>((resolve) => (wake = resolve));
    }
  };

  async function* events(): AsyncGenerator<AgentEvent> {
    for (;;) {
      const input = await nextInput();
      if (!input) return;
      yield { type: 'turn_start' };
      const interrupted = new Promise<'interrupted'>((resolve) => (interruptTurn = () => resolve('interrupted')));
      let outcome: 'done' | 'interrupted' = 'done';
      for (const [i, step] of script(input.text).entries()) {
        if ('say' in step) {
          yield { type: 'text', text: step.say };
          continue;
        }
        const id = `tool-${i}`;
        yield { type: 'tool_call', id, name: step.tool, input: {} };
        const result = await Promise.race([(step.until ?? Promise.resolve()).then(() => 'done' as const), interrupted]);
        if (result === 'interrupted') {
          yield { type: 'tool_result', toolCallId: id, output: 'interrupted', isError: true };
          outcome = 'interrupted';
          break;
        }
        yield { type: 'tool_result', toolCallId: id, output: step.output ?? 'ok', isError: false };
        // Tool boundary: `next` messages join the turn here.
        for (let j = 0; j < inputs.length; ) {
          const queued = inputs[j]!;
          if (queued.priority === 'next') {
            inputs.splice(j, 1);
            yield { type: 'text', text: `ack:${queued.text}` };
          } else j++;
        }
      }
      interruptTurn = null;
      yield { type: 'turn_end', outcome };
    }
  }

  return {
    send(input) {
      sent.push(input);
      inputs.push(input);
      notify();
    },
    async interrupt() {
      interruptTurn?.();
    },
    end() {
      ended = true;
      notify();
    },
    events: events()
  };
}
