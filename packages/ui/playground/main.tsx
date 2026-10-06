import { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { WaspChat, type WaspChatProps, labelsFr } from '../src/index.ts';
import { mockTransport } from './mock.ts';

type Theme = 'wasp' | 'shadcn';
const params = new URLSearchParams(location.search);

function Playground() {
  const [theme, setTheme] = useState<Theme>((params.get('theme') as Theme) ?? 'wasp');
  const [scheme, setScheme] = useState<'auto' | 'light' | 'dark'>((params.get('scheme') as 'auto') ?? 'auto');
  const [lang, setLang] = useState(params.get('lang') ?? 'en');
  const [phone, setPhone] = useState(params.has('phone'));
  const [empty, setEmpty] = useState(params.has('empty'));
  const [panel, setPanel] = useState(params.has('panel'));
  const transport = useMemo(() => mockTransport({ seed: !empty }), [empty]);

  (document.getElementById('shadcn-theme') as HTMLLinkElement).disabled = theme !== 'shadcn';
  const host = theme === 'shadcn' ? `host-shadcn${scheme === 'dark' ? ' dark' : ''}` : '';
  const props: Omit<WaspChatProps, 'transport'> = {
    // A shadcn host decides light or dark itself; the theme follows its tokens.
    colorScheme: theme === 'shadcn' ? 'light' : scheme,
    layout: panel ? 'narrow' : 'wide',
    suggestions: ['What does the sandbox run on?', 'Do something long', 'Make it fail'],
    ...(lang === 'fr' ? { labels: labelsFr } : {})
  };

  return (
    <div className="pg">
      <div className="pg-bar">
        <strong>wasp-ui</strong>
        <label>
          theme
          <select value={theme} onChange={(e) => setTheme(e.target.value as Theme)}>
            <option value="wasp">wasp (default)</option>
            <option value="shadcn">shadcn host</option>
          </select>
        </label>
        <label>
          scheme
          <select value={scheme} onChange={(e) => setScheme(e.target.value as 'auto')}>
            <option>auto</option>
            <option>light</option>
            <option>dark</option>
          </select>
        </label>
        <label>
          lang
          <select value={lang} onChange={(e) => setLang(e.target.value)}>
            <option>en</option>
            <option>fr</option>
          </select>
        </label>
        <label>
          <input type="checkbox" checked={phone} onChange={(e) => setPhone(e.target.checked)} /> phone
        </label>
        <label>
          <input type="checkbox" checked={empty} onChange={(e) => setEmpty(e.target.checked)} /> empty thread
        </label>
        <label>
          <input type="checkbox" checked={panel} onChange={(e) => setPanel(e.target.checked)} /> side panel
        </label>
        <span>Say “long” for a slow turn, “fail” for errors. Attach, drop or paste files (a name with “fail” fails).</span>
      </div>
      <div className={`pg-stage ${host}`}>
        {panel ? (
          // What a host draws around a narrow chat: its own page, and a panel with its own header.
          <div className="pg-host">
            <div className="pg-host-page">
              <h1>Quarterly report</h1>
              <p>The host app's own page. The assistant sits beside it.</p>
            </div>
            <aside className="pg-panel">
              <header>Assistant</header>
              <WaspChat key={`${empty}`} transport={transport} {...props} />
            </aside>
          </div>
        ) : (
          <div className={`pg-frame${phone ? ' phone' : ''}`}>
            <WaspChat key={`${empty}`} transport={transport} {...props} />
          </div>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Playground />);
