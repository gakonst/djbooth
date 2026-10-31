import { useCallback, useEffect, useRef, useState } from "react";
import type { ControlState } from "./types.js";
import { createA9Decoder } from "./a9-midi.js";

type MidiStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "waiting"
  | "blocked"
  | "unsupported"
  | "error";
type MidiState = {
  controls: Record<string, ControlState>;
  connected: boolean;
  status: MidiStatus;
  devices: string[];
  lastControl: string;
  messages: number;
};
const empty = (): MidiState => ({
  controls: {},
  connected: false,
  status: "idle",
  devices: [],
  lastControl: "",
  messages: 0,
});

/** Read-only A9 input. The owning page shares these controls with its visuals and overlays. */
export function useA9Midi(enabled = new URLSearchParams(location.search).has("hardwareMidi")) {
  const [state, setState] = useState<MidiState>(empty);
  const session = useRef<{ dispose(): void } | null>(null);
  const generation = useRef(0);
  const disconnect = useCallback(() => {
    generation.current++;
    session.current?.dispose();
    session.current = null;
  }, []);
  const connect = useCallback(async () => {
    disconnect();
    const token = generation.current;
    if (!window.isSecureContext || !navigator.requestMIDIAccess) {
      setState({ ...empty(), status: "unsupported" });
      return;
    }
    setState({ ...empty(), status: "connecting" });
    try {
      // No SysEx, MIDI outputs, transport commands or device writes.
      const access = await navigator.requestMIDIAccess({ sysex: false });
      if (generation.current !== token) return;
      const bindings = new Map<
        MIDIInput,
        { receive: (event: MIDIMessageEvent) => void; controls: Record<string, ControlState> }
      >();
      let frame: number | undefined;
      let messages = 0;
      let lastControl = "";
      let failed = false;
      const publish = () => {
        frame = undefined;
        if (generation.current !== token) return;
        const inputs = [...bindings.keys()].filter(
          (input) => input.state === "connected" && input.connection === "open",
        );
        setState({
          connected: inputs.length > 0,
          status: inputs.length ? "connected" : failed ? "error" : "waiting",
          devices: inputs.map((input) => input.name ?? "DJM-A9"),
          controls: Object.assign(
            {},
            ...inputs.map((input) => bindings.get(input)!.controls),
          ) as Record<string, ControlState>,
          messages,
          lastControl,
        });
      };
      const schedule = () => {
        if (frame === undefined) frame = requestAnimationFrame(publish);
      };
      const attach = () => {
        if (generation.current !== token) return;
        for (const [input, binding] of bindings) {
          if (input.state === "connected" && access.inputs.has(input.id)) continue;
          input.removeEventListener("midimessage", binding.receive);
          bindings.delete(input);
          void input.close().catch(() => {});
        }
        for (const input of access.inputs.values()) {
          // CDJs use Pro DJ Link; their USB messages are not A9 mixer assignments.
          if (
            !/DJM[- ]?A9/i.test(input.name ?? "") ||
            input.state !== "connected" ||
            bindings.has(input)
          )
            continue;
          const decode = createA9Decoder();
          const controls: Record<string, ControlState> = {};
          const receive = (event: MIDIMessageEvent) => {
            if (generation.current !== token || !event.data) return;
            const decoded = decode(event.data, event.timeStamp);
            if (!decoded) return;
            controls[decoded.name] = decoded.control;
            lastControl = decoded.name;
            messages++;
            schedule();
          };
          bindings.set(input, { receive, controls });
          input.addEventListener("midimessage", receive);
          void input
            .open()
            .then(schedule)
            .catch(() => {
              failed = true;
              schedule();
            });
        }
        schedule();
      };
      session.current = {
        dispose() {
          if (frame !== undefined) cancelAnimationFrame(frame);
          access.removeEventListener("statechange", attach);
          for (const [input, binding] of bindings) {
            input.removeEventListener("midimessage", binding.receive);
            void input.close().catch(() => {});
          }
          bindings.clear();
        },
      };
      access.addEventListener("statechange", attach);
      attach();
    } catch (error) {
      if (generation.current !== token) return;
      const blocked =
        error instanceof DOMException &&
        (error.name === "NotAllowedError" || error.name === "SecurityError");
      setState({ ...empty(), status: blocked ? "blocked" : "error" });
    }
  }, [disconnect]);

  useEffect(() => {
    if (enabled && !new URLSearchParams(location.search).has("hardwareWs")) void connect();
    else {
      disconnect();
      setState(empty());
    }
    return disconnect;
  }, [enabled, connect, disconnect]);
  return { ...state, connect };
}
