import { useRef, useSyncExternalStore } from "react";
import { createWispClient } from "@wisp/core";

// Binds a Wisp client's headless store to React via useSyncExternalStore.
// Rendering layer only — all state lives in @wisp/core.
export function useWisp(config) {
  const ref = useRef(null);
  if (!ref.current) ref.current = createWispClient(config);
  const client = ref.current;
  const state = useSyncExternalStore(client.store.subscribe, client.store.getState, client.store.getState);
  return {
    ...state,
    send: client.send,
    approve: client.approve,
    deny: client.deny,
    interrupt: client.interrupt,
    reset: client.reset,
  };
}
