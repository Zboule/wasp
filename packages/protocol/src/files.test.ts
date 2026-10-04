import { describe, expect, it } from 'vitest';

import { fileRef, isPayloadRef, parseFileRef, safeFileName } from './files.ts';

const T = '11111111-2222-4333-8444-555555555555';
const F = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

describe('file refs', () => {
  it('keeps readable names, including non-Latin letters and the extension', () => {
    expect(safeFileName('Q3 report (final).pdf')).toBe('Q3 report (final).pdf');
    expect(safeFileName('résumé.docx')).toBe('résumé.docx');
    expect(safeFileName(`${'x'.repeat(200)}.xlsx`)).toMatch(/^x{123}\.xlsx$/);
  });

  it('never yields a path separator, a dot file or an empty name', () => {
    expect(safeFileName('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(safeFileName('.env')).toBe('env');
    expect(safeFileName('a\u0000b\nc')).toBe('a_b_c');
    expect(safeFileName('...')).toBe('file');
  });

  it('always yields a name its own ref accepts, even cut at the limit inside non-BMP letters', () => {
    for (const name of [`${'𝒜'.repeat(200)}.txt`, '𝒜'.repeat(300), `${'é'.repeat(127)}𝒜𝒜`, '\u{1F600}.png', '', ' . ']) {
      expect(parseFileRef(T, fileRef(T, F, name)), name).not.toBeNull();
    }
  });

  it('round-trips a ref for its own thread only', () => {
    const ref = fileRef(T, F, 'notes.txt');
    expect(ref).toBe(`payloads/${T}/files/${F}/notes.txt`);
    expect(parseFileRef(T, ref)).toEqual({ id: F, name: 'notes.txt' });
    expect(parseFileRef('99999999-2222-4333-8444-555555555555', ref)).toBeNull();
  });

  it('rejects keys the agent could have planted under its own prefix', () => {
    for (const ref of [
      `payloads/${T}/files/${F}/../../x`,
      `payloads/${T}/files/${F}/a/b.txt`,
      `payloads/${T}/files/not-a-uuid/a.txt`,
      `payloads/${T}/files/${F}/.bashrc`,
      `payloads/${T}/other/${F}/a.txt`
    ]) {
      expect(parseFileRef(T, ref)).toBeNull();
    }
  });

  it('recognises this thread’s payloads only', () => {
    expect(isPayloadRef(T, `payloads/${T}/${F}.txt`)).toBe(true);
    expect(isPayloadRef(T, `payloads/${T}/../99999999-2222-4333-8444-555555555555/x.txt`)).toBe(false);
    expect(isPayloadRef(T, `sessions/${T}/x.jsonl`)).toBe(false);
    expect(isPayloadRef(T, `payloads/99999999-2222-4333-8444-555555555555/x.txt`)).toBe(false);
  });
});
