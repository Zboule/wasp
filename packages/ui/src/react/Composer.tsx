import type { Deliver, QueuedMessage } from '@zboule/wasp-protocol';
import { type ClipboardEvent, type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { type PendingFile, formatBytes } from './attachments.ts';
import { useWasp } from './context.tsx';
import { Alert, ArrowUp, ChevronUp, Clock, Close, FileIcon, Paperclip, Pencil, Spinner, Stop } from './icons.tsx';

const ORDER: Deliver[] = ['asap', 'later', 'now'];

/**
 * The input, with its action inside it: send, or stop while the agent works
 * and nothing is typed. While it works, a chip picks how a message is
 * delivered: next step (the default), after the turn, or interrupting it.
 */
export function WaspComposer() {
  const { state, session, labels, defaultDeliver, draft, setDraft, composerRef, attachments, send } = useWasp();
  const [deliver, setDeliver] = useState<Deliver>(defaultDeliver);
  const [menu, setMenu] = useState(false);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const chip = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  const working = state.state === 'working';
  const busy = state.state !== 'idle';
  const hasText = draft.trim().length > 0;
  const hasFiles = attachments.refs.length > 0;
  // Files upload as soon as they are picked; a message waits for the last one.
  const canSend = (hasText || hasFiles) && !attachments.uploading && !sending;
  const showStop = working && !hasText && attachments.items.length === 0;

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
    if (!canSend) return;
    setSending(true);
    const ok = await send(draft, busy ? deliver : 'later', attachments.refs);
    setSending(false);
    if (ok) {
      setDraft('');
      attachments.clear();
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

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files);
    if (!attachments.enabled || files.length === 0) return;
    e.preventDefault();
    attachments.add(files);
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
      {attachments.items.length > 0 && (
        <ul className="wasp-chips">
          {attachments.items.map((f) => (
            <FileChip key={f.key} file={f} onRemove={() => attachments.remove(f.key)} />
          ))}
        </ul>
      )}
      <textarea
        ref={composerRef}
        className="wasp-input"
        value={draft}
        rows={1}
        placeholder={busy ? labels.placeholderBusy : labels.placeholder}
        aria-label={labels.placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
      <div className="wasp-composer-bar">
        {attachments.enabled && (
          <>
            <button
              type="button"
              className="wasp-icon-btn wasp-attach"
              onClick={() => picker.current?.click()}
              aria-label={labels.attach}
              title={labels.attach}
            >
              <Paperclip />
            </button>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                attachments.add(Array.from(e.target.files ?? []));
                e.target.value = '';
                composerRef.current?.focus();
              }}
            />
          </>
        )}
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
            disabled={!canSend}
            aria-label={labels.send}
            title={attachments.uploading ? labels.uploading : labels.send}
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
  const { state, session, labels, setDraft, composerRef, attachments } = useWasp();
  const [pending, setPending] = useState<string | null>(null);
  if (state.queue.length === 0) return null;

  const act = async (m: QueuedMessage, edit: boolean) => {
    setPending(m.id);
    try {
      const result = await session.cancel(m.id);
      // Only a message that really left the queue goes back to the input: if
      // the agent took it first, it is in the conversation already. Its files
      // were uploaded already, so they come back as they are.
      if (edit && result === 'cancelled') {
        if (m.text) setDraft((current) => (current.trim() ? `${current}\n${m.text}` : m.text));
        if (m.attachments?.length) attachments.restore(m.attachments);
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
            {/* A message of files alone is named by its files. */}
            <span className="wasp-queue-text" title={m.text || undefined}>
              {m.text || m.attachments?.map((f) => f.name).join(', ')}
            </span>
            {m.attachments && m.attachments.length > 0 && (
              <span className="wasp-queue-files" title={m.attachments.map((f) => f.name).join('\n')}>
                <Paperclip />
                {labels.attachments(m.attachments.length)}
              </span>
            )}
            {pending === m.id ? (
              <Spinner />
            ) : (
              <>
                <button type="button" className="wasp-icon-btn" onClick={() => void act(m, true)} aria-label={labels.edit} title={labels.edit}>
                  <Pencil />
                </button>
                <button type="button" className="wasp-icon-btn" onClick={() => void act(m, false)} aria-label={labels.cancel} title={labels.cancel}>
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

function FileChip({ file, onRemove }: { file: PendingFile; onRemove: () => void }) {
  const { labels } = useWasp();
  return (
    <li className={`wasp-file-chip ${file.status}`} title={file.error ?? file.name}>
      <span className="wasp-file-chip-icon">{file.status === 'uploading' ? <Spinner /> : file.status === 'error' ? <Alert /> : <FileIcon />}</span>
      <span className="wasp-file-chip-text">
        <span className="wasp-file-chip-name">{file.name}</span>
        <span className="wasp-file-chip-meta">
          {file.status === 'error' ? file.error : file.status === 'uploading' ? `${Math.round(file.progress * 100)}%` : formatBytes(file.size)}
        </span>
      </span>
      <button type="button" className="wasp-icon-btn" onClick={onRemove} aria-label={`${labels.removeFile} ${file.name}`} title={labels.removeFile}>
        <Close />
      </button>
      {file.status === 'uploading' && <span className="wasp-file-chip-bar" style={{ width: `${Math.round(file.progress * 100)}%` }} />}
    </li>
  );
}
