import type { Deliver } from '@zboule/wasp-protocol';
import { type ComponentType, type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { type WaspSession, type WaspSessionState, type WaspTransport, createWaspSession } from '../core/session.ts';
import type { TimelineItem, ToolItem } from '../core/timeline.ts';
import { type Attachments, DEFAULT_FILE_LIMITS, type FileLimits, useAttachments } from './attachments.ts';
import { type WaspLabels, resolveLabels } from './labels.ts';

/**
 * How one tool's calls are shown. Keyed by tool name in `tools`; a key ending
 * in `*` matches a prefix (`mcp__calendar__*`).
 */
export type WaspToolRenderer = {
  /** Replaces the tool's name in the header. */
  label?: string;
  icon?: ReactNode;
  /** The one-line summary next to the name. Defaults to the argument people recognise it by. */
  summary?: (args: Record<string, unknown> | null, item: ToolItem) => string;
  /** Replaces the expanded body (input and output). */
  render?: (item: ToolItem) => ReactNode;
  /** Starts expanded. */
  open?: boolean;
};

/** Swap any part of the chat for your own. Each receives what the default would render. */
export type WaspComponents = {
  Markdown: ComponentType<{ text: string; streaming: boolean }>;
  UserMessage: ComponentType<{
    item: Extract<TimelineItem, { kind: 'user' }>;
    children: ReactNode;
  }>;
  AssistantMessage: ComponentType<{
    item: Extract<TimelineItem, { kind: 'assistant' }>;
    children: ReactNode;
  }>;
  Tool: ComponentType<{ item: ToolItem; children: ReactNode }>;
  Empty: ComponentType<{ children: ReactNode }>;
};

export type WaspOptions = {
  transport: WaspTransport;
  /** Any subset of the strings, to translate or reword them (`labelsFr` is built in). */
  labels?: Partial<WaspLabels>;
  /** `auto` follows the system. Themes that map to the host's tokens follow the host instead. */
  colorScheme?: 'auto' | 'light' | 'dark';
  /** How a message is delivered while the agent works. `asap`: it reads it at its next step. */
  defaultDeliver?: Deliver;
  /** Prompts offered while the thread is empty. */
  suggestions?: string[];
  tools?: Record<string, WaspToolRenderer>;
  components?: Partial<WaspComponents>;
  /** Checked before uploading, for an early answer; the API enforces its own. Defaults to wasp-client's. */
  fileLimits?: Partial<FileLimits>;
  className?: string;
};

type WaspContextValue = {
  session: WaspSession;
  state: WaspSessionState;
  labels: WaspLabels;
  options: WaspOptions;
  defaultDeliver: Deliver;
  components: Partial<WaspComponents>;
  toolRenderer: (name: string) => WaspToolRenderer | undefined;
  draft: string;
  setDraft: (text: string | ((current: string) => string)) => void;
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
  /** Files on their way into the next message (when the transport can upload). */
  attachments: Attachments;
  /** Sends a message; resolves false if it could not be sent. */
  send: (text: string, deliver?: Deliver, files?: string[]) => Promise<boolean>;
};

const WaspContext = createContext<WaspContextValue | null>(null);

export function useWasp(): WaspContextValue {
  const value = useContext(WaspContext);
  if (!value) throw new Error('wasp: use this inside <WaspRoot> or <WaspChat>');
  return value;
}

/** The headless session for one thread, as React state. Build any UI on it. */
export function useWaspSession(transport: WaspTransport): {
  session: WaspSession;
  state: WaspSessionState;
} {
  const session = useMemo(() => createWaspSession(transport), [transport]);
  const state = useSyncExternalStore(session.store.subscribe, session.store.getState, session.store.getState);
  useEffect(() => {
    session.start();
    return () => session.stop();
  }, [session]);
  return { session, state };
}

/**
 * Holds a thread's session and the chat's options, and draws the themed
 * container. Put the building blocks (`WaspTimeline`, `WaspQueue`,
 * `WaspComposer`) inside in any layout; `WaspChat` is just the three stacked.
 */
export function WaspRoot({ children, ...options }: WaspOptions & { children: ReactNode }) {
  const { session, state } = useWaspSession(options.transport);
  const labels = useMemo(() => resolveLabels(options.labels), [options.labels]);
  const [draft, setDraft] = useState('');
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const defaultDeliver = options.defaultDeliver ?? 'asap';
  const limits = useMemo(() => ({ ...DEFAULT_FILE_LIMITS, ...options.fileLimits }), [options.fileLimits]);
  const attachments = useAttachments(options.transport, labels, limits);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  const toolRenderer = useCallback(
    (name: string) => {
      const tools = options.tools;
      if (!tools) return undefined;
      if (tools[name]) return tools[name];
      const prefix = Object.keys(tools)
        .filter((k) => k.endsWith('*') && name.startsWith(k.slice(0, -1)))
        .sort((a, b) => b.length - a.length)[0];
      return prefix ? tools[prefix] : undefined;
    },
    [options.tools]
  );

  const send = useCallback(
    async (text: string, deliver: Deliver = defaultDeliver, files: string[] = []) => {
      const message = text.trim();
      if (!message && files.length === 0) return false;
      try {
        await session.post(message, deliver, files);
        return true;
      } catch (error) {
        session.store.setState({
          error: error instanceof Error ? error.message : String(error)
        });
        return false;
      }
    },
    [session, defaultDeliver]
  );

  const value: WaspContextValue = {
    session,
    state,
    labels,
    options,
    defaultDeliver,
    components: options.components ?? {},
    toolRenderer,
    draft,
    setDraft,
    composerRef,
    attachments,
    send
  };

  // Files dropped anywhere on the chat join the next message.
  const hasFiles = (e: React.DragEvent) => attachments.enabled && Array.from(e.dataTransfer.types).includes('Files');
  const drop = {
    onDragEnter: (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current++;
      setDragging(true);
    },
    onDragOver: (e: React.DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    },
    onDrop: (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      attachments.add(Array.from(e.dataTransfer.files));
      composerRef.current?.focus();
    }
  };

  return (
    <WaspContext.Provider value={value}>
      <div
        className={`wasp${options.className ? ` ${options.className}` : ''}`}
        data-scheme={options.colorScheme ?? 'auto'}
        data-state={state.state}
        data-dragging={dragging || undefined}
        {...drop}
      >
        {children}
        {dragging && (
          <div className="wasp-drop" aria-hidden="true">
            <span>{labels.dropFiles}</span>
          </div>
        )}
      </div>
    </WaspContext.Provider>
  );
}
