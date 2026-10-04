# @zboule/wasp-client

What your API calls to use [wasp](https://github.com/Zboule/wasp).

```ts
import { createWaspClient } from '@zboule/wasp-client';
import { Resource } from 'sst';

const wasp = createWaspClient(Resource.Agent); // the linked WaspAgent

// After YOUR check that the user may access this thread:
await wasp.post(threadId, { text, deliver: 'asap' });
const { state, queue, entries, cursor } = await wasp.feed(threadId, { after });
await wasp.interrupt(threadId);
await wasp.cancel(threadId, messageId);
await wasp.deleteThread(threadId);
```

The client checks no permissions: thread ownership is your app's job. Thread ids are UUIDs.
