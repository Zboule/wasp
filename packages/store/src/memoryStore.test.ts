import { createMemoryStore } from './memoryStore.ts';
import { storeContract } from './testing/contract.ts';

storeContract('memory', async () => createMemoryStore());
