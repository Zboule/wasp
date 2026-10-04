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

## Files

The browser uploads straight to S3, so files never pass through your API (or its body size limit):

```ts
// 1. POST /threads/:id/uploads { name, mediaType, size }
const { ref, url, fields } = await wasp.upload(threadId, { name, mediaType, size });
// 2. the browser POSTs multipart form data to `url`: every entry of `fields`, then the file, last.
//    `size` is signed exactly: send the file's own byte count (File.size), or S3 refuses it
// 3. POST /threads/:id/messages { text, files: [ref] }
await wasp.post(threadId, { text, files: [ref] });
```

The agent finds each file at `files/<id>/<name>` in its working directory. In `feed`, attachments on queued
and delivered messages carry a `url` that downloads the file for 15 minutes. Limits default to 25 MB per file
and 10 files per message: `createWaspClient(Resource.Agent, { limits: { maxFileBytes, maxFiles } })`.
