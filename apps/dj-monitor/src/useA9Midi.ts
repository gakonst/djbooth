import { useEffect, useState } from "react";
import type { ControlState } from "./types.js";

import { createA9Decoder } from "./a9-midi.js";

/** Opt-in, read-only USB MIDI for a local HDMI browser. Never opens MIDI outputs. */
export function useA9Midi() {
  const [controls, setControls] = useState<Record<string, ControlState>>({});
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    if (
      !new URLSearchParams(location.search).has("hardwareMidi") ||
      new URLSearchParams(location.search).has("hardwareWs") ||
      !window.isSecureContext ||
      !navigator.requestMIDIAccess
    )
      return;
    let disposed = false;
    let access: MIDIAccess | undefined;
    let frame: number | undefined;
    let pending: Record<string, ControlState> = {};
    const inputs = new Set<MIDIInput>();
    const decode = createA9Decoder();
    const receive = (event: MIDIMessageEvent) => {
      const bytes = event.data;
      if (!bytes) return;
      const decoded = decode(bytes, event.timeStamp);
      if (!decoded) return;
      pending[decoded.name] = decoded.control;
      if (frame === undefined)
        frame = requestAnimationFrame(() => {
          const update = pending;
          pending = {};
          frame = undefined;
          if (!disposed) setControls((current) => ({ ...current, ...update }));
        });
    };
    const attach = () => {
      if (disposed || !access) return;
      for (const input of inputs) input.onmidimessage = null;
      inputs.clear();
      for (const input of access.inputs.values()) {
        if (!input.name?.includes("DJM-A9") || input.state !== "connected") continue;
        input.onmidimessage = receive;
        inputs.add(input);
      }
      setConnected(inputs.size > 0);
      if (!inputs.size) setControls({});
    };
    void navigator
      .requestMIDIAccess({ sysex: false })
      .then((result) => {
        if (disposed) return;
        access = result;
        access.onstatechange = attach;
        attach();
      })
      .catch(() => {
        if (!disposed) setConnected(false);
      });
    return () => {
      disposed = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (access) access.onstatechange = null;
      for (const input of inputs) {
        input.onmidimessage = null;
        void input.close();
      }
    };
  }, []);
  return { controls, connected };
}
