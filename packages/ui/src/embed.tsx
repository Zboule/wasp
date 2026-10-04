import { createRoot } from 'react-dom/client';

import { httpTransport } from './core/session.ts';
import { WaspChat, type WaspChatProps } from './react/WaspChat.tsx';
import { labelsEn, labelsFr } from './react/labels.ts';
import css from './react/styles.css';

export { labelsEn, labelsFr };

export type MountOptions = Omit<WaspChatProps, 'transport'> & {
  /** The app's thread routes (see httpTransport), e.g. `/api/threads/<id>`. */
  base: string;
  /**
   * The page's CSP nonce, for the injected stylesheet. Pages that link
   * styles.css themselves (`<link id="wasp-styles" …>`) need neither.
   */
  nonce?: string;
};

/**
 * For pages without a build step: one script tag, then
 *   WaspChat.mount(document.getElementById('chat'), { base: '/api/threads/<id>' })
 */
export function mount(element: HTMLElement, { base, nonce, ...options }: MountOptions) {
  if (!document.getElementById('wasp-styles')) {
    const style = document.createElement('style');
    style.id = 'wasp-styles';
    if (nonce) style.nonce = nonce;
    style.textContent = css;
    document.head.append(style);
  }
  const root = createRoot(element);
  root.render(<WaspChat transport={httpTransport(base)} {...options} />);
  return () => root.unmount();
}
