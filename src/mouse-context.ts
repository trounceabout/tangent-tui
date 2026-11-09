// src/mouse-context.ts
// How components get at mouse events: a React context holding the MouseInput, and a hook
// to listen. Without a provider (as in most tests) the context is inert: nothing fires.

import { createContext, useContext, useEffect, useRef } from "react";
import type { MouseEvent, MouseInput } from "./mouse.ts";

// What components may use of the MouseInput. `supported` is false when there is no mouse
// pipeline at all (for example in most tests), so the app can tell "mouse is off" from
// "there is no mouse".
export type MouseApi = Pick<MouseInput, "subscribe" | "enabled" | "setEnabled"> & { supported: boolean };

const INERT: MouseApi = {
  subscribe: () => () => {},
  enabled: () => false,
  setEnabled: () => {},
  supported: false,
};

// The API components see, for a real MouseInput.
export const mouseApiFor = (input: MouseInput): MouseApi => ({
  subscribe: input.subscribe,
  enabled: input.enabled,
  setEnabled: input.setEnabled,
  supported: true,
});

// How many lines one notch of the mouse wheel scrolls.
export const WHEEL_LINES = 3;

export const MouseContext = createContext<MouseApi>(INERT);
export const useMouseApi = (): MouseApi => useContext(MouseContext);

// Listen for mouse events while `active` is true. The handler may change on every render
// (it sees the latest props and state); we keep the subscription itself steady.
export function useMouse(handler: (event: MouseEvent) => void, active = true): void {
  const { subscribe } = useMouseApi();
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    if (!active) return;
    return subscribe((event) => latest.current(event));
  }, [subscribe, active]);
}
