import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Markdown } from './Markdown.tsx';

const text = 'See [the reel](https://app.example.com/reels/42), and [this](javascript:alert(1)).';

describe('Markdown links', () => {
  it('opens https links in a new tab, without access to this page, by default', () => {
    const html = renderToStaticMarkup(<Markdown text={text} />);
    expect(html).toContain('<a href="https://app.example.com/reels/42" target="_blank" rel="noopener noreferrer nofollow">the reel</a>');
    expect(html).not.toContain('javascript:');
  });

  it('lets the app draw each link, and still only gets https ones', () => {
    const seen: string[] = [];
    const Link = ({ href, children }: { href: string; children: ReactNode }) => {
      seen.push(href);
      return <button data-href={href}>{children}</button>;
    };
    const html = renderToStaticMarkup(<Markdown text={text} link={Link} />);
    expect(html).toContain('<button data-href="https://app.example.com/reels/42">the reel</button>');
    expect(seen).toEqual(['https://app.example.com/reels/42']);
  });
});
