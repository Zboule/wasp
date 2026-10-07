# @zboule/wasp-ui

The chat for a [wasp](https://github.com/Zboule/wasp) thread. It renders messages as Markdown, shows tool calls with their output, lists the queue (with cancel and edit), and puts send and stop in the input. Your design system can theme it, and you can swap any part of it.

```tsx
import { WaspChat, httpTransport } from '@zboule/wasp-ui';
import '@zboule/wasp-ui/styles.css';

<WaspChat transport={httpTransport(`/api/threads/${threadId}`)} />;
```

## How messages are delivered

A message shows in the conversation the moment it's sent, dimmed until the agent reads it. If the agent is
working, it waits in the queue until the turn ends (`later`). From the queue, **Send now** has the agent read it at
its next step without stopping (`asap`), and you can also edit or remove it. To pick a different default, pass
`defaultDeliver`.

When the input is empty, its button stops the agent; Esc does the same. A queued message then starts the next turn.

## In a side panel

Pass `layout="narrow"` when the chat sits in a side panel or a drawer, about 320–480px wide. It's denser, runs edge to
edge with no centred column, and stacks suggestions one per line. wasp doesn't draw the panel: your app does (its
header, its close button, how it opens). The chat fills whatever box you give it.

```tsx
<aside style={{ width: 380, height: '100vh', display: 'flex', flexDirection: 'column' }}>
  <header>Assistant</header>
  <div style={{ flex: 1, minHeight: 0 }}>
    <WaspChat transport={transport} layout="narrow" />
  </div>
</aside>
```

The chat takes its container's full height, so give that container one.

The default, `layout="wide"`, is for a page of its own: the conversation in a centred column.

## Files

When the transport can upload (`httpTransport` can), the input gets an attach button. Files also come in by
drag-and-drop anywhere on the chat, or by pasting. Each file uploads to storage as soon as it's picked, with its
progress shown. A message can be files alone, and it is sent once the last upload finishes. Editing a queued
message brings its files back. Files on a message show as download links. With `httpTransport`, each link asks
your API for a fresh download when clicked, so it never expires on a page left open.

## Theming

Everything is drawn from CSS variables. Set any of them on `.wasp` or on one of its ancestors:

| Variable | What it colours |
|---|---|
| `--wasp-bg`, `--wasp-surface` | the chat; cards and the input |
| `--wasp-ink`, `--wasp-muted` | text; secondary text |
| `--wasp-line`, `--wasp-soft` | borders; code and subtle fills |
| `--wasp-accent`, `--wasp-accent-ink` | the send button, links, focus; the icon drawn on the accent |
| `--wasp-user-bg`, `--wasp-user-ink` | your own messages |
| `--wasp-error`, `--wasp-focus`, `--wasp-shadow` | errors; the focus ring; elevation |
| `--wasp-font`, `--wasp-font-mono`, `--wasp-font-size` | type (the font is inherited by default) |
| `--wasp-radius`, `--wasp-max-width` | corner radius; the reading column |

Light and dark follow the system unless you pass `colorScheme="light" | "dark"`.

**shadcn/ui hosts** can import a theme that maps every variable to the host's own tokens (`--background`,
`--primary`, `--border`, `--radius`…). The chat then follows the host's brand and its own dark mode:

```ts
import '@zboule/wasp-ui/styles.css';
import '@zboule/wasp-ui/themes/shadcn.css';
```

The class names (`.wasp-*`) are stable too, if you need to restyle a detail.

## Plug points

```tsx
<WaspChat
  transport={transport}
  labels={labelsFr}                       // or any subset of WaspLabels: every string is replaceable
  defaultDeliver="asap"                   // `later` by default: after the running turn
  suggestions={['Summarise my week']}     // offered while the thread is empty
  intro={<p>Acts as you: what it changes is recorded as your action.</p>}  // at the start of the conversation, scrolls away with it
  tools={{
    Bash: { label: 'Shell' },
    'mcp__calendar__*': {                 // a trailing * matches a prefix
      label: 'Calendar',
      icon: <CalendarIcon />,
      summary: (args) => `${args?.from} → ${args?.to}`,
      render: (call) => <EventList json={call.result} />  // replaces the expanded body
    }
  }}
  components={{ Markdown: MyMarkdown, Empty: MyEmptyState, Link: MyLink }}
/>
```

`components` can replace `Markdown`, `UserMessage`, `AssistantMessage`, `Tool`, `Empty` and `Link`. Each wrapper
receives the item and the default rendering as `children`, so it can decorate the default or replace it.

`Link` draws each link in the agent's text. It gets the `href`, already checked to be https, and the link's text as
`children`. Use it to turn links to your own app into buttons that open a view in place, and fall back to a plain link
for the rest:

```tsx
function MyLink({ href, children }: { href: string; children: ReactNode }) {
  const id = href.match(/^https:\/\/app\.example\.com\/reels\/(\w+)$/)?.[1];
  if (id) return <button onClick={() => openReel(id)}>{children}</button>;
  return <a href={href} target="_blank" rel="noopener noreferrer nofollow">{children}</a>;
}
```

### Your own layout

`WaspChat` is three building blocks stacked. Place them yourself inside a `WaspRoot`:

```tsx
<WaspRoot transport={transport} labels={labels}>
  <Header />
  <WaspTimeline />
  <footer>
    <WaspError />
    <WaspQueue />
    <WaspComposer />
  </footer>
</WaspRoot>
```

`useWasp()` gives any component inside the session, its state and `send()`. Without React,
`createWaspSession(transport)` is the headless store underneath.

## The transport

`httpTransport(base)` calls your API, which checks the user and calls `@zboule/wasp-client`:

```
GET    {base}/feed?after=<cursor>   → wasp.feed(id, { after })
POST   {base}/messages              → wasp.post(id, { text, deliver })
POST   {base}/interrupt             → wasp.interrupt(id)
DELETE {base}/queue/{messageId}     → { result: wasp.cancel(id, messageId) }
POST   {base}/uploads               → wasp.upload(id, { name, mediaType, size })
GET    {base}/files?ref=            → redirect to wasp.download(id, ref)
```

`POST {base}/messages` also carries `files`, the refs from uploads, for `wasp.post`. An error answered as
`{ error }` is shown as it is. The browser sends the file itself straight to storage, to the URL that
`wasp.upload` signed, so a strict CSP must allow that origin in `connect-src`.

You can also write your own `WaspTransport`: four functions, plus `upload` and `fileHref` for files.

## No build step

`@zboule/wasp-ui/embed` is a single file for a plain HTML page. It bundles React and injects the styles:

```html
<script src="/wasp-chat.js"></script>
<script>
  WaspChat.mount(document.getElementById('chat'), { base: '/api/threads/<id>', labels: WaspChat.labelsFr });
</script>
```

Under a strict CSP, either link `styles.css` yourself as `<link id="wasp-styles" rel="stylesheet" …>`, or
pass `nonce`.

## Safety

The agent is untrusted, so its output never becomes HTML:

- Markdown is parsed into a tree and drawn as elements.
- Links open only for `https:` and `mailto:` URLs, in a new tab without access to the page.
- Images are never loaded. They show up as links, because loading one would let the agent send data to any URL without a click.

## Playground

```sh
pnpm --filter @zboule/wasp-ui playground   # http://localhost:5174
```

A scripted agent drives the real components with no AWS. Switch the theme, light or dark, language and width
from the bar at the top.
