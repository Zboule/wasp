import type { WaspFile } from '@zboule/wasp-protocol';
import { useCallback, useMemo, useRef, useState } from 'react';

import type { WaspTransport } from '../core/session.ts';
import type { WaspLabels } from './labels.ts';

/** wasp-client's defaults. The API enforces its own; these only answer early. */
export type FileLimits = { maxFileBytes: number; maxFiles: number };
export const DEFAULT_FILE_LIMITS: FileLimits = { maxFileBytes: 25 * 1024 * 1024, maxFiles: 10 };

/** A file on its way into the next message. `ready` ones carry the ref `post` needs. */
export type PendingFile = {
  key: string;
  name: string;
  size: number;
  status: 'uploading' | 'ready' | 'error';
  progress: number;
  ref?: string;
  error?: string;
};

export type Attachments = {
  /** Whether the transport can upload at all. */
  enabled: boolean;
  items: PendingFile[];
  add: (files: File[]) => void;
  /** Puts files already uploaded back on the next message (editing a queued one). */
  restore: (files: WaspFile[]) => void;
  remove: (key: string) => void;
  clear: () => void;
  refs: string[];
  uploading: boolean;
};

/** Uploads as soon as a file is picked, so sending is instant. */
export function useAttachments(transport: WaspTransport, labels: WaspLabels, limits: FileLimits): Attachments {
  const [items, setItems] = useState<PendingFile[]>([]);
  const update = (key: string, change: Partial<PendingFile>) => setItems((all) => all.map((f) => (f.key === key ? { ...f, ...change } : f)));

  // The current list, for the limit check: uploads start outside setItems,
  // whose updater React may run twice.
  const latest = useRef(items);
  latest.current = items;

  const add = useCallback(
    (files: File[]) => {
      const upload = transport.upload?.bind(transport);
      if (!upload || files.length === 0) return;
      const room = Math.max(0, limits.maxFiles - latest.current.filter((f) => f.status !== 'error').length);
      const next = files.map((file, i): PendingFile => {
        const base = { key: `${Date.now()}-${i}-${file.name}`, name: file.name, size: file.size, progress: 0 };
        if (i >= room) return { ...base, status: 'error', error: labels.tooManyFiles(limits.maxFiles) };
        if (file.size > limits.maxFileBytes) return { ...base, status: 'error', error: labels.fileTooLarge(formatBytes(limits.maxFileBytes)) };
        if (file.size === 0) return { ...base, status: 'error', error: labels.fileEmpty };
        return { ...base, status: 'uploading' };
      });
      latest.current = [...latest.current, ...next];
      setItems((current) => [...current, ...next]);
      next.forEach((pending, i) => {
        if (pending.status !== 'uploading') return;
        const key = pending.key;
        upload(files[i]!, (progress) => update(key, { progress }))
          .then((ref) => update(key, { status: 'ready', progress: 1, ref }))
          .catch((error: unknown) => update(key, { status: 'error', error: error instanceof Error ? error.message : labels.uploadFailed }));
      });
    },
    [transport, labels, limits]
  );

  const restore = useCallback((files: WaspFile[]) => {
    setItems((current) => [
      ...current,
      ...files
        .filter((f) => !current.some((c) => c.ref === f.ref))
        .map((f): PendingFile => ({ key: f.ref, name: f.name, size: f.size, status: 'ready', progress: 1, ref: f.ref }))
    ]);
  }, []);

  const remove = useCallback((key: string) => setItems((all) => all.filter((f) => f.key !== key)), []);
  const clear = useCallback(() => setItems([]), []);

  return useMemo(
    () => ({
      enabled: Boolean(transport.upload),
      items,
      add,
      restore,
      remove,
      clear,
      refs: items.filter((f) => f.status === 'ready' && f.ref).map((f) => f.ref!),
      uploading: items.some((f) => f.status === 'uploading')
    }),
    [transport, items, add, restore, remove, clear]
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1).replace(/\.0$/, '') : Math.round(value)} ${units[unit]}`;
}
