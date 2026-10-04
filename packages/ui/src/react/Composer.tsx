import type { Deliver } from '@zboule/wasp-protocol';
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { useWasp } from './context.tsx';
import { ArrowUp, ChevronUp, Clock, Close, Pencil, Spinner, Stop } from './icons.tsx';

const ORDER: Deliver[] = ['asap', 'later', 'now'];

/**
 * The input, with its action inside it: send, or stop while the agent works
 * and nothing is typed. While it works, a chip picks how a message is
 * delivered: next step (the default), after the turn, or interrupting it.
 */
export function WaspComposer() {
  const { state, session, labels, defaultDeliver, draft, setDraft, composerRef, send } = useWasp();
  const [deliver, setDeliver] = useState<Deliver>(defaultDeliver);
  const [menu, setMenu] = useState(false);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const chip = useRef<HTMLDivElement>(null);

  const working = state.state === 'working';
  const busy = state.state !== 'idle';
  const hasText = draft.trim().length > 0;
  const showStop = working && !hasText;

  useEffect(() => setDeliver(defaultDeliver), [defaultDeliver]);
  // Stopping ends when the run does: the thread goes idle, or a queued message
  // starts the next run straight away (a new "stopped" notice marks the end).
  const stops = state.timeline.filter((i) => i.kind === 'notice' && i.code === 'interrupted').length;
  useEffect(() => setStopping(false), [stops]);
  useEffect(() => {
    if (!working) setStopping(false);
  }, [working]);

  // Grow with the text, up to the CSS max-height.
  useLayoutEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [draft, composerRef]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (!chip.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menu]);

  const submit = async () => {
    if (!hasText || sending) return;
    setSending(true);
    const ok = await send(draft, busy ? deliver : 'later');
    setSending(false);
    if (ok) {
      setDraft('');
      setDeliver(defaultDeliver);
      composerRef.current?.focus();
    }
  };
  const stop = async () => {
    if (stopping) return;
    setStopping(true);
    try {
      await session.interrupt();
    } catch (error) {
      setStopping(false);
      session.store.setState({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    } else if (e.key === 'Escape') {
      if (menu) setMenu(false);
      else if (working && !hasText) void stop();
    }
  };

  return (
    <div className="wasp-composer" data-deliver={busy ? deliver : undefined}>
      <textarea
        ref={composerRef}
        className="wasp-input"
        value={draft}
        rows={1}
        placeholder={busy ? labels.placeholderBusy : labels.placeholder}
        aria-label={labels.placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="wasp-composer-bar">
        {busy && (
          <div className="wasp-deliver" ref={chip}>
            <button
              type="button"
              className={`wasp-chip ${deliver}`}
              aria-haspopup="menu"
              aria-expanded={menu}
              onClick={() => setMenu(!menu)}
              title={labels.deliver[deliver].hint}
            >
              {labels.deliver[deliver].label}
              <ChevronUp />
            </button>
            {menu && (
              <div className="wasp-menu" role="menu">
                {ORDER.map((d) => (
                  <button
                    key={d}
                    type="button"
                    role="menuitemradio"
                    aria-checked={deliver === d}
                    className={deliver === d ? 'on' : ''}
                    onClick={() => {
                      setDeliver(d);
                      setMenu(false);
                      composerRef.current?.focus();
                    }}
                  >
                    <strong>{labels.deliver[d].label}</strong>
                    <span>{labels.deliver[d].hint}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <span className="wasp-spacer" />
        {showStop ? (
          <button
            type="button"
            className="wasp-action stop"
            onClick={() => void stop()}
            disabled={stopping}
            aria-label={labels.stop}
            title={`${labels.stop} (Esc)`}
          >
            {stopping ? <Spinner /> : <Stop />}
          </button>
        ) : (
          <button
            type="button"
            className="wasp-action send"
            onClick={() => void submit()}
            disabled={!hasText || sending}
            aria-label={labels.send}
            title={labels.send}
          >
            {sending ? <Spinner /> : <ArrowUp />}
          </button>
        )}
      </div>
    </div>
  );
}

/** The last error talking to the app's API; the next successful poll clears it. */
export function WaspError() {
  const { state } = useWasp();
  return state.error ? (
    <div className="wasp-error" role="alert">
      {state.error}
    </div>
  ) : null;
}

/** Messages waiting for the agent. Remove one, or take it back to edit it. */
export function WaspQueue() {
  const { state, session, labels, setDraft, composerRef } = useWasp();
  const [pending, setPending] = useState<string | null>(null);
  if (state.queue.length === 0) return null;

  const act = async (id: string, text: string, edit: boolean) => {
    setPending(id);
    try {
      const result = await session.cancel(id);
      // Only a message that really left the queue goes back to the input: if
      // the agent took it first, it is in the conversation already.
      if (edit && result === 'cancelled') {
        setDraft((current) => (current.trim() ? `${current}\n${text}` : text));
        composerRef.current?.focus();
      }
    } catch (error) {
      session.store.setState({
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="wasp-queue" aria-label={labels.queued(state.queue.length)}>
      <div className="wasp-queue-head">
        <Clock />
        {labels.queued(state.queue.length)}
      </div>
      <ul>
        {state.queue.map((m) => (
          <li key={m.id} className={pending === m.id ? 'pending' : undefined}>
            {/* "After this turn" only means something while a turn is running. */}
            {(m.deliver !== 'later' || state.state === 'working') && <span className={`wasp-badge ${m.deliver}`}>{labels.deliver[m.deliver].label}</span>}
            <span className="wasp-queue-text" title={m.text}>
              {m.text}
            </span>
            {pending === m.id ? (
              <Spinner />
            ) : (
              <>
                <button type="button" className="wasp-icon-btn" onClick={() => void act(m.id, m.text, true)} aria-label={labels.edit} title={labels.edit}>
                  <Pencil />
                </button>
                <button type="button" className="wasp-icon-btn" onClick={() => void act(m.id, m.text, false)} aria-label={labels.cancel} title={labels.cancel}>
                  <Close />
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
