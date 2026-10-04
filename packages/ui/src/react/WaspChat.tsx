import { WaspComposer, WaspError, WaspQueue } from './Composer.tsx';
import { type WaspOptions, WaspRoot } from './context.tsx';
import { WaspTimeline } from './Timeline.tsx';

export type WaspChatProps = WaspOptions;

/**
 * A chat on one wasp thread: the conversation, the queue and the input. For
 * another layout, put the same blocks in a `WaspRoot` yourself.
 * Everything the agent produces is drawn as text or as elements, never as
 * HTML: the agent is untrusted (see the wasp security model).
 */
export function WaspChat(props: WaspChatProps) {
  return (
    <WaspRoot {...props}>
      <WaspTimeline />
      <div className="wasp-column wasp-dock">
        <WaspError />
        <WaspQueue />
        <WaspComposer />
      </div>
    </WaspRoot>
  );
}
