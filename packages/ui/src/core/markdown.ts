/**
 * A small Markdown parser for agent replies, to a tree the UI renders as
 * elements. It never produces HTML: the agent is untrusted (see the wasp
 * security model), so raw HTML stays text, links are kept only when they are
 * https, and images become links, because rendering one would make the browser
 * fetch an agent-chosen URL without anyone clicking.
 *
 * Replies stream in, so it must cope with half a document: an unclosed code
 * fence runs to the end, an unclosed `**` is just text until it closes.
 */

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong' | 'em' | 'del'; children: Inline[] }
  | { type: 'link'; href: string; children: Inline[] }
  | { type: 'br' };

export type Align = 'left' | 'center' | 'right' | null;

export type Block =
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'heading'; level: number; children: Inline[] }
  | { type: 'code'; lang: string; text: string; open: boolean }
  | { type: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { type: 'quote'; children: Block[] }
  | { type: 'rule' }
  | { type: 'table'; align: Align[]; head: Inline[][]; rows: Inline[][][] };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const indentOf = (line: string) => /^\s*/.exec(line)![0].replace(/\t/g, '    ').length;
const blank = (line: string | undefined) => line === undefined || !line.trim();

function isTableStart(lines: string[], i: number) {
  return lines[i]!.includes('|') && lines[i + 1] !== undefined && TABLE_RULE.test(lines[i + 1]!) && lines[i + 1]!.includes('-');
}

function startsBlock(lines: string[], i: number) {
  const line = lines[i]!;
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || (ITEM.test(line) && indentOf(line) < 4) || isTableStart(lines, i);
}

function cells(row: string): string[] {
  let r = row.trim();
  if (r.startsWith('|')) r = r.slice(1);
  if (r.endsWith('|') && !r.endsWith('\\|')) r = r.slice(0, -1);
  return r.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

export function parseMarkdown(source: string): Block[] {
  return parseBlocks(source.replace(/\r\n?/g, '\n').split('\n'));
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const body: string[] = [];
      i++;
      let open = true;
      while (i < lines.length) {
        const close = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`);
        if (close.test(lines[i]!)) {
          open = false;
          i++;
          break;
        }
        body.push(lines[i]!);
        i++;
      }
      blocks.push({
        type: 'code',
        lang: fence[2] ?? '',
        text: body.join('\n'),
        open
      });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        type: 'heading',
        level: heading[1]!.length,
        children: parseInline(heading[2]!)
      });
      i++;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ type: 'rule' });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && !blank(lines[i]) && (QUOTE.test(lines[i]!) || !startsBlock(lines, i))) {
        body.push(lines[i]!.replace(QUOTE, ''));
        i++;
      }
      blocks.push({ type: 'quote', children: parseBlocks(body) });
      continue;
    }

    if (isTableStart(lines, i)) {
      const head = cells(line);
      const align: Align[] = cells(lines[i + 1]!).map((c) =>
        c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null
      );
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && !blank(lines[i]) && lines[i]!.includes('|')) {
        const row = cells(lines[i]!);
        rows.push(head.map((_, c) => parseInline(row[c] ?? '')));
        i++;
      }
      blocks.push({
        type: 'table',
        align: head.map((_, c) => align[c] ?? null),
        head: head.map((h) => parseInline(h)),
        rows
      });
      continue;
    }

    const item = ITEM.exec(line);
    if (item && indentOf(line) < 4) {
      const base = indentOf(line);
      const ordered = /\d/.test(item[2]!);
      const start = ordered ? Number.parseInt(item[2]!, 10) : 1;
      const items: string[][] = [];
      let contentIndent = 0;
      while (i < lines.length) {
        const current = lines[i]!;
        const m = ITEM.exec(current);
        if (m && indentOf(current) === base && /\d/.test(m[2]!) === ordered) {
          items.push([m[3]!]);
          contentIndent = base + m[2]!.length + 1;
          i++;
          continue;
        }
        if (blank(current)) {
          const next = lines[i + 1];
          const nextItem = next !== undefined ? ITEM.exec(next) : null;
          if (next !== undefined && !blank(next) && (indentOf(next) > base || (nextItem && indentOf(next) === base && /\d/.test(nextItem[2]!) === ordered))) {
            items.at(-1)!.push('');
            i++;
            continue;
          }
          break;
        }
        if (indentOf(current) > base) {
          const strip = Math.min(indentOf(current), contentIndent);
          items.at(-1)!.push(current.replace(/\t/g, '    ').slice(strip));
          i++;
          continue;
        }
        // A lazy continuation of the item's paragraph.
        if (!blank(lines[i - 1]) && !startsBlock(lines, i)) {
          items.at(-1)!.push(current.trim());
          i++;
          continue;
        }
        break;
      }
      blocks.push({
        type: 'list',
        ordered,
        start,
        items: items.map((body) => parseBlocks(body))
      });
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length && !blank(lines[i]) && (paragraph.length === 0 || !startsBlock(lines, i))) {
      paragraph.push(lines[i]!.trim());
      i++;
    }
    blocks.push({
      type: 'paragraph',
      children: parseInline(paragraph.join('\n'))
    });
  }
  return blocks;
}

/** Links the UI may follow: the agent's text is untrusted, so https and mailto only. */
export function safeHref(href: string): string | null {
  return /^(https:\/\/|mailto:)/i.test(href.trim()) ? href.trim() : null;
}

type Rule = { re: RegExp; make: (m: RegExpExecArray) => Inline };

const INLINE: Rule[] = [
  {
    re: /(`+)([^`\n]|[^`\n][^\n]*?[^`\n])\1(?!`)/,
    make: (m) => ({
      type: 'code',
      text: m[2]!.length > 2 && m[2]!.startsWith(' ') && m[2]!.endsWith(' ') ? m[2]!.slice(1, -1) : m[2]!
    })
  },
  // An image is never fetched: it becomes a link to it, labelled with its alt text.
  {
    re: /!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"\n]*")?\)/,
    make: (m) => link(m[2]!, m[1] || m[2]!)
  },
  {
    re: /\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"\n]*")?\)/,
    make: (m) => link(m[2]!, m[1]!)
  },
  { re: /<(https:\/\/[^>\s]+)>/, make: (m) => link(m[1]!, m[1]!, false) },
  {
    re: /https:\/\/[^\s<]*[^\s<.,;:!?'")\]*_~`]/,
    make: (m) => link(m[0], m[0], false)
  },
  {
    re: /\*\*(?=\S)([^\n]*?\S)\*\*/,
    make: (m) => ({ type: 'strong', children: parseInline(m[1]!) })
  },
  {
    re: /(?<!\w)__(?=\S)([^\n]*?\S)__(?!\w)/,
    make: (m) => ({ type: 'strong', children: parseInline(m[1]!) })
  },
  {
    re: /~~(?=\S)([^\n]*?\S)~~/,
    make: (m) => ({ type: 'del', children: parseInline(m[1]!) })
  },
  {
    re: /\*([^\s*](?:[^*\n]*[^\s*])?)\*/,
    make: (m) => ({ type: 'em', children: parseInline(m[1]!) })
  },
  {
    re: /(?<!\w)_([^\s_](?:[^_\n]*[^\s_])?)_(?!\w)/,
    make: (m) => ({ type: 'em', children: parseInline(m[1]!) })
  },
  { re: /\n/, make: () => ({ type: 'br' }) }
];

/**
 * A link's text keeps its styles but not links of its own (an anchor cannot
 * hold one); a bare URL's text is left as is, since it would only match itself.
 */
function link(href: string, text: string, styled = true): Inline {
  const safe = safeHref(href);
  if (!safe) return { type: 'text', text };
  return { type: 'link', href: safe, children: styled ? unlink(parseInline(text)) : [{ type: 'text', text }] };
}

function unlink(nodes: Inline[]): Inline[] {
  return nodes.flatMap((n) => (n.type === 'link' ? n.children : 'children' in n ? [{ ...n, children: unlink(n.children) }] : [n]));
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const push = (node: Inline) => {
    const last = out.at(-1);
    if (node.type === 'text' && last?.type === 'text') last.text += node.text;
    else out.push(node);
  };
  let rest = text;
  while (rest) {
    let best: { m: RegExpExecArray; rule: Rule } | null = null;
    for (const rule of INLINE) {
      const m = rule.re.exec(rest);
      if (m && (!best || m.index < best.m.index)) best = { m, rule };
    }
    if (!best) {
      push({ type: 'text', text: rest });
      break;
    }
    if (best.m.index > 0) push({ type: 'text', text: rest.slice(0, best.m.index) });
    push(best.rule.make(best.m));
    rest = rest.slice(best.m.index + best.m[0].length);
  }
  return out;
}
