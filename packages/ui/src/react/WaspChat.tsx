import type { Deliver } from '@zboule/wasp-protocol';
import { type KeyboardEvent, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { type WaspSessionState, type WaspTransport, createWaspSession } from '../core/session.ts';
import type { TimelineItem } from '../core/timeline.ts';

export type WaspChatProps = {
  transport: WaspTransport;
  placeholder?: string;
  /** Shown while the thread is empty. */
  emptyText?: string;
  className?: string;
};

const DELIVER: { value: Deliver; label: string; hint: string }[] = [
  { value: 'later', label: 'Later', hint: 'After the current turn' },
  { value: 'asap', label: 'ASAP', hint: 'At the next tool call' },
  { value: 'now', label: 'Now', hint: 'Interrupt and answer this' }
];

/**
 * A chat on one wasp thread. Everything the agent produces is rendered as
 * text, never as HTML: the agent is untrusted (see the wasp security model).
 */
export function WaspChat({ transport, placeholder = 'Message the agent…', emptyText = 'Start the conversation.', className }: WaspChatProps) {
  const session = useMemo(() => createWaspSession(transport), [transport]);
  const state = useSyncExternalStore(session.store.subscribe, session.store.getState, session.store.getState) as WaspSessionState;
  const [text, setText] = useState('');
  const [deliver, setDeliver] = useState<Deliver>('later');
  const [sending, setSending] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    session.start();
    return () => session.stop();
  }, [session]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [state.timeline.length]);

  const busy = state.state !== 'idle';
  const send = async () => {
    const message = text.trim();
    if (!message || sending) return;
    setSending(true);
    try {
      await session.post(message, busy ? deliver : 'later');
      setText('');
    } finally {
      setSending(false);
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className={`wasp ${className ?? ''}`}>
      <div className="wasp-scroll" ref={scroller}>
        {state.loaded && state.timeline.length === 0 && state.queue.length === 0 && <div className="wasp-empty">{emptyText}</div>}
        {state.timeline.map((item) => (
          <Item key={`${item.kind}:${item.id}`} item={item} />
        ))}
        {state.state === 'waking_up' && <div className="wasp-status">Waking up the agent…</div>}
        {state.state === 'working' && (
          <div className="wasp-status">
            <span className="wasp-spin" /> Working
          </div>
        )}
      </div>

      {state.queue.length > 0 && (
        <div className="wasp-queue" aria-label="Queued messages">
          {state.queue.map((m) => (
            <div className="wasp-queued" key={m.id}>
              <span className={`wasp-badge ${m.deliver}`}>{m.deliver}</span>
              <span className="wasp-queued-text">{m.text}</span>
              <button type="button" className="wasp-link" onClick={() => void session.cancel(m.id)}>
                Cancel
              </button>
            </div>
          ))}
        </div>
      )}

      {state.error && <div className="wasp-error">{state.error}</div>}

      <div className="wasp-composer">
        <textarea
          className="wasp-input"
          value={text}
          placeholder={placeholder}
          rows={2}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="wasp-actions">
          {busy && (
            <div className="wasp-deliver" role="radiogroup" aria-label="When to deliver">
              {DELIVER.map((d) => (
                <button
                  key={d.value}
                  type="button"
                  role="radio"
                  aria-checked={deliver === d.value}
                  title={d.hint}
                  className={deliver === d.value ? 'on' : ''}
                  onClick={() => setDeliver(d.value)}
                >
                  {d.label}
                </button>
              ))}
            </div>
          )}
          <span className="wasp-spacer" />
          {state.state === 'working' && (
            <button type="button" className="wasp-btn" onClick={() => void session.interrupt()}>
              Interrupt
            </button>
          )}
          <button type="button" className="wasp-btn primary" disabled={!text.trim() || sending} onClick={() => void send()}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function Item({ item }: { item: TimelineItem }) {
  const [open, setOpen] = useState(false);
  switch (item.kind) {
    case 'user':
      return <div className="wasp-msg user">{item.text}</div>;
    case 'assistant':
      return <div className="wasp-msg assistant">{item.text}</div>;
    case 'notice':
      return <div className={`wasp-notice ${item.tone}`}>{item.text}</div>;
    case 'tool':
      return (
        <div className={`wasp-tool ${item.status}`}>
          <button type="button" className="wasp-tool-head" onClick={() => setOpen(!open)} aria-expanded={open}>
            {item.status === 'running' ? <span className="wasp-spin" /> : <span className="wasp-tool-ico">{item.status === 'error' ? '!' : '✓'}</span>}
            <span className="wasp-tool-name">{item.name}</span>
            <span className="wasp-tool-caret">{open ? '▾' : '▸'}</span>
          </button>
          {open && (
            <div className="wasp-tool-body">
              <pre className="wasp-pre">{item.args}</pre>
              {item.argsUrl && <SafeLink href={item.argsUrl}>Full arguments</SafeLink>}
              {item.result !== undefined && <pre className="wasp-pre result">{item.result}</pre>}
              {item.resultUrl && <SafeLink href={item.resultUrl}>Full output</SafeLink>}
            </div>
          )}
        </div>
      );
  }
}

/** Only https links (the client's signed URLs), opened without access to this page. */
function SafeLink({ href, children }: { href: string; children: string }) {
  if (!href.startsWith('https://')) return null;
  return (
    <a className="wasp-link" href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}
