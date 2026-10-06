import type { QueuedMessage, WaspFile } from '@zboule/wasp-protocol';
import { type ClipboardEvent, type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { pendingMessages } from '../core/session.ts';
import { type PendingFile, formatBytes } from './attachments.ts';
import { useWasp } from './context.tsx';
import { Alert, ArrowUp, Clock, Close, FileIcon, Paperclip, Pencil, Spinner, Stop } from './icons.tsx';

/**
 * The input, with its action inside it: send, or stop while the agent works
 * and nothing is typed. A message sent while the agent works waits for its
 * turn to end; the queue can send it now.
 */
export function WaspComposer() {
  const { state, session, labels, defaultDeliver, draft, setDraft, composerRef, attachments, send } = useWasp();
  const [stopping, setStopping] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  const working = state.state === 'working';
  const busy = state.state !== 'idle';
  const hasText = draft.trim().length > 0;
  const hasFiles = attachments.refs.length > 0;
  // Files upload as soon as they are picked; a message waits for the last one.
  const canSend = (hasText || hasFiles) && !attachments.uploading;
  const showStop = working && !hasText && attachments.items.length === 0;

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

  // The input clears at once: the message shows where it is going while the
  // API takes it, and comes back here only if the API refuses it.
  const submit = async () => {
    if (!canSend) return;
    const text = draft;
    const files = attachments.items.flatMap((f): WaspFile[] => (f.status === 'ready' && f.ref ? [{ id: f.key, name: f.name, mediaType: '', size: f.size, ref: f.ref }] : []));
    setDraft('');
    attachments.clear();
    composerRef.current?.focus();
    if (!(await send(text, defaultDeliver, files.map((f) => f.ref), files))) {
      setDraft((current) => (current.trim() ? `${text}\n${current}` : text));
      attachments.restore(files);
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
    } else if (e.key === 'Escape' && working && !hasText) {
      void stop();
    }
  };

  return (
    <div className="wasp-composer">
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
            <ArrowUp />
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

/**
 * Messages waiting behind the running turn. Send one now (the agent reads it at
 * its next step), take it back to edit it, or remove it.
 */
export function WaspQueue() {
  const { state, session, labels, setDraft, composerRef, attachments } = useWasp();
  const [pending, setPending] = useState<string | null>(null);
  const { waiting } = pendingMessages(state);
  if (waiting.length === 0) return null;

  const act = async (m: QueuedMessage, action: 'now' | 'edit' | 'remove') => {
    setPending(m.id);
    // Only a message that really left the queue goes back to the input: if the
    // agent took it first, it is in the conversation already. Its files were
    // uploaded already, so they come back as they are.
    const takeBack = () => {
      if (m.text) setDraft((current) => (current.trim() ? `${current}\n${m.text}` : m.text));
      if (m.attachments?.length) attachments.restore(m.attachments);
      composerRef.current?.focus();
    };
    try {
      if (action === 'now') {
        // Out of the queue, but not sent again: it must not be lost.
        if ((await session.sendNow(m)) === 'unsent') takeBack();
      } else if ((await session.cancel(m.id)) === 'cancelled' && action === 'edit') {
        takeBack();
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
    <div className="wasp-queue" aria-label={labels.queued(waiting.length)}>
      <div className="wasp-queue-head">
        <Clock />
        {labels.queued(waiting.length)}
      </div>
      <ul>
        {waiting.map((p) => {
          const queued = state.queue.find((q) => q.id === p.id);
          const busy = p.sending || !queued || pending === p.id;
          return (
            <li key={p.id} className={busy ? 'pending' : undefined}>
              {p.deliver !== 'later' && <span className={`wasp-badge ${p.deliver}`}>{labels.deliver[p.deliver].label}</span>}
              {/* A message of files alone is named by its files. */}
              <span className="wasp-queue-text" title={p.text || undefined}>
                {p.text || p.attachments?.map((f) => f.name).join(', ')}
              </span>
              {p.attachments && p.attachments.length > 0 && (
                <span className="wasp-queue-files" title={p.attachments.map((f) => f.name).join('\n')}>
                  <Paperclip />
                  {labels.attachments(p.attachments.length)}
                </span>
              )}
              {busy ? (
                <Spinner />
              ) : (
                <>
                  {queued.deliver === 'later' && (
                    <button type="button" className="wasp-send-now" onClick={() => void act(queued, 'now')} title={labels.sendNowHint}>
                      {labels.sendNow}
                    </button>
                  )}
                  <button type="button" className="wasp-icon-btn" onClick={() => void act(queued, 'edit')} aria-label={labels.edit} title={labels.edit}>
                    <Pencil />
                  </button>
                  <button type="button" className="wasp-icon-btn" onClick={() => void act(queued, 'remove')} aria-label={labels.cancel} title={labels.cancel}>
                    <Close />
                  </button>
                </>
              )}
            </li>
          );
        })}
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
