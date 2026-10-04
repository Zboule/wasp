import { createRoot } from 'react-dom/client';

import { httpTransport } from './core/session.ts';
import { WaspChat } from './react/WaspChat.tsx';
import css from './react/styles.css';

/**
 * For pages without a build step: one script tag, then
 *   WaspChat.mount(document.getElementById('chat'), { base: '/threads/<id>' })
 * where `base` is the app's thread routes (see httpTransport).
 */
export function mount(element: HTMLElement, { base, placeholder }: { base: string; placeholder?: string }) {
  if (!document.getElementById('wasp-styles')) {
    const style = document.createElement('style');
    style.id = 'wasp-styles';
    style.textContent = css;
    document.head.append(style);
  }
  const root = createRoot(element);
  root.render(<WaspChat transport={httpTransport(base)} {...(placeholder ? { placeholder } : {})} />);
  return () => root.unmount();
}
