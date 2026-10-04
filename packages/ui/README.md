# @zboule/wasp-ui

The chat for a [wasp](https://github.com/Zboule/wasp) thread. It renders messages as Markdown, shows tool calls with their output, lists the queue (with cancel and edit), and puts send and stop in the input. Your design system can theme it, and you can swap any part of it.

```tsx
import { WaspChat, httpTransport } from '@zboule/wasp-ui';
import '@zboule/wasp-ui/styles.css';

<WaspChat transport={httpTransport(`/api/threads/${threadId}`)} />;
```

## How messages are delivered

A message sent while the agent works goes **next** by default (`asap`): the agent reads it at its next step,
without stopping. A chip in the input picks the other two modes for one message:

- **After this turn** (`later`) waits until the agent is done.
- **Interrupt** (`now`) stops the agent and sends the message.

When the input is empty, its button stops the agent; Esc does the same.

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
  defaultDeliver="asap"
  suggestions={['Summarise my week']}     // offered while the thread is empty
  tools={{
    Bash: { label: 'Shell' },
    'mcp__calendar__*': {                 // a trailing * matches a prefix
      label: 'Calendar',
      icon: <CalendarIcon />,
      summary: (args) => `${args?.from} → ${args?.to}`,
      render: (call) => <EventList json={call.result} />  // replaces the expanded body
    }
  }}
  components={{ Markdown: MyMarkdown, Empty: MyEmptyState }}
/>
```

`components` can replace `Markdown`, `UserMessage`, `AssistantMessage`, `Tool` and `Empty`. Each wrapper
receives the item and the default rendering as `children`, so it can decorate the default or replace it.

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
```

You can also write your own `WaspTransport`: four functions.

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
