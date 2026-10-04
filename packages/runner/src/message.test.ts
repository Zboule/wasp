import { describe, expect, it } from 'vitest';

import { messageForAgent } from './message.ts';

describe('messageForAgent', () => {
  it('leaves a message without files as it is', () => {
    expect(messageForAgent('hi')).toBe('hi');
  });

  it('lists every file under files/<id>/<name>', () => {
    const files = [
      { id: 'a', name: 'notes.txt', mediaType: 'text/plain', size: 12, ref: '' },
      { id: 'b', name: 'big.csv', mediaType: 'text/csv', size: 40_000, ref: '' }
    ];
    expect(messageForAgent('', files)).toBe(
      '[The user attached 2 files, in your working directory:\n- files/a/notes.txt (text/plain, 12 B)\n- files/b/big.csv (text/csv, 39.1 KB)]'
    );
  });
});
