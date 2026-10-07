import { type ComponentType, Fragment, type ReactNode, useMemo, useState } from 'react';

import { type Block, type Inline, parseMarkdown } from '../core/markdown.ts';
import { Check, Copy } from './icons.tsx';

/** Draws one link of the agent's text. `href` is already checked: https only. */
export type LinkComponent = ComponentType<{ href: string; children: ReactNode }>;

/**
 * Agent text as Markdown, drawn as elements: no HTML is ever injected, links are
 * https only and open without access to this page, images are never fetched.
 * `link` draws the links instead (a button that opens your own view, say).
 */
export function Markdown({
  text,
  copyLabel = 'Copy',
  copiedLabel = 'Copied',
  link
}: {
  text: string;
  streaming?: boolean;
  copyLabel?: string;
  copiedLabel?: string;
  link?: LinkComponent;
}) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return <div className="wasp-md">{renderBlocks(blocks, { copyLabel, copiedLabel, Link: link ?? DefaultLink })}</div>;
}

function DefaultLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  );
}

type Labels = { copyLabel: string; copiedLabel: string; Link: LinkComponent };

function renderBlocks(blocks: Block[], labels: Labels): ReactNode {
  return blocks.map((block, i) => <Fragment key={i}>{renderBlock(block, labels)}</Fragment>);
}

function renderBlock(block: Block, labels: Labels): ReactNode {
  switch (block.type) {
    case 'paragraph':
      return <p>{renderInline(block.children, labels)}</p>;
    case 'heading': {
      const Tag = `h${Math.min(block.level + 2, 6)}` as 'h3';
      return <Tag className={`wasp-md-h${block.level}`}>{renderInline(block.children, labels)}</Tag>;
    }
    case 'code':
      return <CodeBlock lang={block.lang} text={block.text} {...labels} />;
    case 'list': {
      const items = block.items.map((item, i) => (
        // A tight item (one paragraph) is drawn without its paragraph margin.
        <li key={i}>{item.length === 1 && item[0]!.type === 'paragraph' ? renderInline(item[0]!.children, labels) : renderBlocks(item, labels)}</li>
      ));
      return block.ordered ? <ol start={block.start}>{items}</ol> : <ul>{items}</ul>;
    }
    case 'quote':
      return <blockquote>{renderBlocks(block.children, labels)}</blockquote>;
    case 'rule':
      return <hr />;
    case 'table':
      return (
        <div className="wasp-md-table">
          <table>
            <thead>
              <tr>
                {block.head.map((cell, c) => (
                  <th key={c} style={block.align[c] ? { textAlign: block.align[c]! } : undefined}>
                    {renderInline(cell, labels)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} style={block.align[c] ? { textAlign: block.align[c]! } : undefined}>
                      {renderInline(cell, labels)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

function renderInline(nodes: Inline[], labels: Labels): ReactNode {
  return nodes.map((node, i) => {
    switch (node.type) {
      case 'text':
        return <Fragment key={i}>{node.text}</Fragment>;
      case 'br':
        return <br key={i} />;
      case 'code':
        return <code key={i}>{node.text}</code>;
      case 'strong':
        return <strong key={i}>{renderInline(node.children, labels)}</strong>;
      case 'em':
        return <em key={i}>{renderInline(node.children, labels)}</em>;
      case 'del':
        return <del key={i}>{renderInline(node.children, labels)}</del>;
      case 'link':
        return (
          <labels.Link key={i} href={node.href}>
            {renderInline(node.children, labels)}
          </labels.Link>
        );
    }
  });
}

export function CodeBlock({ lang, text, copyLabel, copiedLabel }: { lang: string; text: string } & Labels) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access denied: nothing to do, the text is selectable.
    }
  };
  return (
    <div className="wasp-code">
      <div className="wasp-code-bar">
        <span>{lang}</span>
        <button
          type="button"
          className="wasp-icon-btn"
          onClick={() => void copy()}
          aria-label={copied ? copiedLabel : copyLabel}
          title={copied ? copiedLabel : copyLabel}
        >
          {copied ? <Check /> : <Copy />}
        </button>
      </div>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  );
}
