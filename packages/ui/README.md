# @zboule/wasp-ui

The chat for a [wasp](https://github.com/Zboule/wasp) thread: messages, tool calls with their output, the
queue (`later` / `asap` / `now`), cancel and interrupt.

```tsx
import { WaspChat, httpTransport } from '@zboule/wasp-ui';
import '@zboule/wasp-ui/styles.css';

<WaspChat transport={httpTransport(`/api/threads/${threadId}`)} />
```

No React? `createWaspSession(transport)` is the headless store underneath, and `@zboule/wasp-ui/embed` is a
one-file build: `WaspChat.mount(element, { base: '/api/threads/<id>' })`.

Agent output is rendered as text, never as HTML.
