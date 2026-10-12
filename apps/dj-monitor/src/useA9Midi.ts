import { useEffect, useState } from "react";
import type { ControlState } from "./types.js";

// DJM-A9 continuous CC assignments, matching djtools-link/src/mixer.rs.
const CONTROLS: Record<number, string> = {
  0x01: "channel.1.trim",
  0x02: "channel.1.eq.high",
  0x03: "channel.1.eq.mid",
  0x04: "channel.1.eq.low",
  0x05: "channel.1.color",
  0x06: "channel.2.trim",
  0x07: "channel.2.eq.high",
  0x08: "channel.2.eq.mid",
  0x09: "channel.2.eq.low",
  0x0a: "channel.2.color",
  0x0b: "crossfader.position",
  0x0c: "channel.3.trim",
  0x0e: "channel.3.eq.high",
  0x0f: "channel.3.eq.mid",
  0x11: "channel.1.fader",
  0x12: "channel.2.fader",
  0x13: "channel.3.fader",
  0x14: "channel.4.fader",
  0x15: "channel.3.eq.low",
  0x16: "channel.3.color",
  0x18: "master.level",
  0x19: "booth.level",
  0x50: "channel.4.trim",
  0x51: "channel.4.eq.high",
  0x52: "channel.4.eq.low",
  0x53: "channel.4.color",
  0x5c: "channel.4.eq.mid",
  0x5b: "beatFx.levelDepth",
};

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
    const receive = (event: MIDIMessageEvent) => {
      const bytes = event.data;
      if (!bytes || bytes.length !== 3 || (bytes[0]! & 0xf0) !== 0xb0) return;
      const name = CONTROLS[bytes[1]!];
      if (!name) return;
      const value = bytes[2]!;
      pending[name] = {
        label: name,
        value,
        percent: (value / 127) * 100,
        state: null,
        raw: Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" "),
        changedAtUs: event.timeStamp * 1000,
      };
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
