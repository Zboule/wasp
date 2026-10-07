import type { WaspFile } from '@zboule/wasp-protocol';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';

import { pendingMessages } from '../core/session.ts';
import type { TimelineItem, ToolItem } from '../core/timeline.ts';
import { formatArgs, parseArgs, toolLabel, toolSummary } from '../core/tools.ts';
import { useWasp } from './context.tsx';
import { formatBytes } from './attachments.ts';
import { Alert, ArrowDown, Check, Chevron, Download, FileIcon, Spinner, Stop } from './icons.tsx';
import { Markdown } from './Markdown.tsx';

/** How close to the bottom still counts as "following" the conversation. */
const STICK_PX = 96;

/** The conversation: messages, tool calls, notices, and what the agent is doing now. */
export function WaspTimeline() {
  const { state, labels, components, options, send } = useWasp();
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [behind, setBehind] = useState(false);

  // Follow the content as it grows (streamed text grows without new items),
  // unless the reader has scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
      else setBehind(true);
    });
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);

  const onScroll = () => {
    const el = scroller.current!;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
    if (stick.current) setBehind(false);
  };
  const jump = () => {
    const el = scroller.current!;
    stick.current = true;
    setBehind(false);
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  const { landing, waiting } = pendingMessages(state);
  const empty = state.loaded && state.timeline.length === 0 && landing.length === 0 && waiting.length === 0 && state.state === 'idle';
  // Idle with a message on its way: the API has it, or is about to, and the agent starts next.
  const starting = state.loaded && (state.state === 'waking_up' || (state.state === 'idle' && landing.length > 0));
  const Empty = components.Empty;
  const emptyBody = (
    <div className="wasp-empty">
      <p>{labels.empty}</p>
      {options.suggestions && options.suggestions.length > 0 && (
        <div className="wasp-suggestions">
          {options.suggestions.map((s) => (
            <button key={s} type="button" className="wasp-suggestion" onClick={() => void send(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="wasp-scroll" ref={scroller} onScroll={onScroll}>
      <div className="wasp-column wasp-timeline" ref={content} role="log" aria-live="polite" aria-relevant="additions">
        {!state.loaded && (
          <div className="wasp-status">
            <Spinner /> {labels.loading}
          </div>
        )}
        {state.loaded && options.intro && <div className="wasp-intro">{options.intro}</div>}
        {empty && (Empty ? <Empty>{emptyBody}</Empty> : emptyBody)}
        {groupTools(state.timeline).map((group) =>
          Array.isArray(group) ? (
            <div className="wasp-tools" key={`tools:${group[0]!.id}`}>
              {group.map((tool) => (
                <ToolCall key={tool.id} item={tool} />
              ))}
            </div>
          ) : (
            <Item key={`${group.kind}:${group.id}`} item={group} streaming={state.state === 'working'} />
          )
        )}
        {landing.map(({ id, text, deliver, attachments }) => (
          <Item key={`user:${id}`} item={{ kind: 'user', id, text, deliver, ...(attachments ? { attachments } : {}) }} streaming={false} pending />
        ))}
        {starting && (
          <div className="wasp-status">
            <Spinner /> {labels.wakingUp}
          </div>
        )}
        {state.state === 'working' && (
          <div className="wasp-status working">
            <span className="wasp-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            {labels.working}
          </div>
        )}
      </div>
      {behind && (
        <button type="button" className="wasp-jump" onClick={jump} aria-label={labels.latest} title={labels.latest}>
          <ArrowDown />
        </button>
      )}
    </div>
  );
}

/** Consecutive tool calls sit together, as one step of work. */
function groupTools(timeline: TimelineItem[]): (Exclude<TimelineItem, ToolItem> | ToolItem[])[] {
  const out: (Exclude<TimelineItem, ToolItem> | ToolItem[])[] = [];
  for (const item of timeline) {
    const last = out.at(-1);
    if (item.kind === 'tool' && Array.isArray(last)) last.push(item);
    else out.push(item.kind === 'tool' ? [item] : item);
  }
  return out;
}

/** `pending`: a message of the user's that the agent has not read yet. */
function Item({ item, streaming, pending }: { item: Exclude<TimelineItem, ToolItem>; streaming: boolean; pending?: boolean }) {
  const { labels, components } = useWasp();
  switch (item.kind) {
    case 'user': {
      const body = (
        <div className={`wasp-turn user${pending ? ' pending' : ''}`}>
          {item.attachments && item.attachments.length > 0 && <Attachments files={item.attachments} />}
          {item.text && <div className="wasp-bubble">{item.text}</div>}
          {!pending && item.deliver !== 'later' && <div className="wasp-meta">{labels.deliveredMidTurn[item.deliver]}</div>}
        </div>
      );
      const UserMessage = components.UserMessage;
      return UserMessage ? <UserMessage item={item}>{body}</UserMessage> : body;
    }
    case 'assistant': {
      if (!item.text) return null;
      const Md = components.Markdown;
      const body = (
        <div className="wasp-turn assistant">
          {Md ? <Md text={item.text} streaming={streaming} /> : <Markdown text={item.text} copyLabel={labels.copy} copiedLabel={labels.copied} {...(components.Link ? { link: components.Link } : {})} />}
        </div>
      );
      const AssistantMessage = components.AssistantMessage;
      return AssistantMessage ? <AssistantMessage item={item}>{body}</AssistantMessage> : body;
    }
    case 'notice':
      return (
        <div className={`wasp-notice ${item.code}`} role={item.code === 'interrupted' ? undefined : 'alert'}>
          {item.code === 'interrupted' ? <Stop /> : <Alert />}
          <span>
            {item.code === 'interrupted' ? labels.interrupted : item.code === 'undeliverable' ? labels.undeliverable : labels.runError}
            {item.detail && item.code !== 'interrupted' ? <span className="wasp-notice-detail">{item.detail}</span> : null}
          </span>
        </div>
      );
  }
}

function ToolCall({ item }: { item: ToolItem }) {
  const { labels, components, toolRenderer } = useWasp();
  const custom = toolRenderer(item.name);
  const [open, setOpen] = useState(custom?.open ?? false);
  const summary = custom?.summary ? custom.summary(parseArgs(item.args), item) : toolSummary(item.args);

  const body: ReactNode = custom?.render ? (
    custom.render(item)
  ) : (
    <>
      {item.args && (
        <section>
          <h4>{labels.toolArgs}</h4>
          <pre>{formatArgs(item.args)}</pre>
          {item.argsUrl && <SafeLink href={item.argsUrl}>{labels.fullArgs}</SafeLink>}
        </section>
      )}
      <section>
        <h4>{labels.toolResult}</h4>
        {item.result !== undefined ? <pre className="wasp-tool-out">{item.result || ' '}</pre> : <p className="wasp-muted">{labels.toolRunning}</p>}
        {item.resultUrl && <SafeLink href={item.resultUrl}>{labels.fullOutput}</SafeLink>}
      </section>
    </>
  );

  const view = (
    <div className={`wasp-tool ${item.status}${open ? ' open' : ''}`}>
      <button type="button" className="wasp-tool-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="wasp-tool-status">
          {item.status === 'running' ? <Spinner /> : item.status === 'error' ? <Alert /> : item.status === 'stopped' ? <Stop /> : <Check />}
        </span>
        {custom?.icon && <span className="wasp-tool-icon">{custom.icon}</span>}
        <span className="wasp-tool-name">{custom?.label ?? toolLabel(item.name)}</span>
        {summary && <span className="wasp-tool-summary">{summary}</span>}
        <span className="wasp-tool-caret">
          <Chevron />
        </span>
      </button>
      {open && <div className="wasp-tool-body">{body}</div>}
    </div>
  );
  const Tool = components.Tool;
  return Tool ? <Tool item={item}>{view}</Tool> : view;
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

/**
 * Files on a message, as downloads. The link is the app's (fresh on every click)
 * when the transport has one, else the feed's own, which expires; never inline.
 */
function Attachments({ files }: { files: WaspFile[] }) {
  const { options } = useWasp();
  return (
    <ul className="wasp-files">
      {files.map((file) => {
        const href = options.transport.fileHref?.(file) ?? file.url;
        const body = (
          <>
            <span className="wasp-file-icon">
              <FileIcon />
            </span>
            <span className="wasp-file-text">
              <span className="wasp-file-name">{file.name}</span>
              <span className="wasp-file-meta">{formatBytes(file.size)}</span>
            </span>
            {href && (
              <span className="wasp-file-get">
                <Download />
              </span>
            )}
          </>
        );
        return (
          <li key={file.ref}>
            {href && /^(https:\/\/|\/(?!\/))/.test(href) ? (
              <a className="wasp-file" href={href} target="_blank" rel="noopener noreferrer" download={file.name}>
                {body}
              </a>
            ) : (
              <span className="wasp-file">{body}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
