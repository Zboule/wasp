import type { WaspFile } from '@zboule/wasp-protocol';

import { localFilePath } from './files.ts';

/** The message as the agent reads it: the user's text, then where each attached file is. */
export function messageForAgent(text: string, attachments: WaspFile[] = []): string {
  if (attachments.length === 0) return text;
  const lines = attachments.map((f) => `- ${localFilePath(f)} (${f.mediaType}, ${formatSize(f.size)})`);
  const note = `[The user attached ${attachments.length === 1 ? 'a file' : `${attachments.length} files`}, in your working directory:\n${lines.join('\n')}]`;
  return text.trim() ? `${text}\n\n${note}` : note;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
