import type { ControlState } from "./types.js";

// A9 MIDI assignments and value thresholds mirror djtools-link/src/mixer.rs.
type Definition = [path: string, kind: string, ...options: string[]];
const NOTES: Record<number, Definition> = {
  0x01: ["beatFx.channel", "selector", "channel1"],
  0x02: ["beatFx.channel", "selector", "channel2"],
  0x03: ["beatFx.channel", "selector", "channel3"],
  0x04: ["beatFx.channel", "selector", "channel4"],
  0x05: ["beatFx.channel", "selector", "microphone"],
  0x06: ["beatFx.channel", "selector", "crossfaderA"],
  0x07: ["beatFx.channel", "selector", "crossfaderB"],
  0x08: ["beatFx.channel", "selector", "master"],
  0x0a: ["channel.1.cueA", "switch"],
  0x0b: ["channel.2.cueA", "switch"],
  0x0c: ["channel.3.cueA", "switch"],
  0x0d: ["channel.4.cueA", "switch"],
  0x0e: ["master.cueA", "switch"],
  0x0f: ["headphonesA.linkCue", "switch"],
  0x10: ["channel.1.cueB", "switch"],
  0x11: ["channel.2.cueB", "switch"],
  0x12: ["channel.3.cueB", "switch"],
  0x13: ["channel.4.cueB", "switch"],
  0x14: ["master.cueB", "switch"],
  0x15: ["headphonesB.linkCue", "switch"],
  0x21: ["headphonesA.monoSplit", "switch"],
  0x22: ["multiIo.sendChannel", "selector", "channel1"],
  0x23: ["multiIo.sendChannel", "selector", "channel2"],
  0x24: ["multiIo.sendChannel", "selector", "channel3"],
  0x25: ["multiIo.sendChannel", "selector", "channel4"],
  0x26: ["multiIo.sendChannel", "selector", "microphone"],
  0x27: ["multiIo.sendChannel", "selector", "crossfaderA"],
  0x28: ["multiIo.sendChannel", "selector", "crossfaderB"],
  0x29: ["multiIo.sendChannel", "selector", "master"],
  0x32: ["channel.1.input", "selector", "digital"],
  0x33: ["channel.1.input", "selector", "line"],
  0x34: ["channel.1.input", "selector", "phono"],
  0x35: ["channel.1.input", "selector", "a"],
  0x36: ["channel.2.input", "selector", "digital"],
  0x37: ["channel.2.input", "selector", "line"],
  0x38: ["channel.2.input", "selector", "phono"],
  0x39: ["channel.2.input", "selector", "a"],
  0x3a: ["channel.3.input", "selector", "digital"],
  0x3b: ["channel.3.input", "selector", "line"],
  0x3c: ["channel.3.input", "selector", "phono"],
  0x3d: ["channel.3.input", "selector", "a"],
  0x3e: ["channel.4.input", "selector", "digital"],
  0x3f: ["channel.4.input", "selector", "line"],
  0x40: ["channel.4.input", "selector", "phono"],
  0x41: ["channel.4.input", "selector", "a"],
  0x42: ["channel.1.input", "selector", "b"],
  0x43: ["channel.1.input", "selector", "return"],
  0x44: ["channel.2.input", "selector", "b"],
  0x45: ["channel.2.input", "selector", "return"],
  0x46: ["channel.3.input", "selector", "b"],
  0x47: ["channel.3.input", "selector", "return"],
  0x48: ["channel.4.input", "selector", "b"],
  0x49: ["channel.4.input", "selector", "return"],
  0x4a: ["channel.1.input", "selector", "usb"],
  0x4b: ["channel.2.input", "selector", "usb"],
  0x4c: ["channel.3.input", "selector", "usb"],
  0x4d: ["channel.4.input", "selector", "usb"],
  0x51: ["channel.1.input", "selector", "bluetooth"],
  0x52: ["channel.2.input", "selector", "bluetooth"],
  0x53: ["channel.3.input", "selector", "bluetooth"],
  0x54: ["channel.4.input", "selector", "bluetooth"],
  0x55: ["soundColorFx.effect", "selector", "space"],
  0x56: ["soundColorFx.effect", "selector", "noise"],
  0x57: ["soundColorFx.effect", "selector", "filter"],
  0x60: ["microphone.reverb", "switch"],
  0x61: ["microphone.talkOver", "switch"],
  0x62: ["microphone.on", "switch"],
  0x69: ["soundColorFx.effect", "selector", "dubEcho"],
  0x6a: ["soundColorFx.effect", "selector", "crush"],
  0x6b: ["soundColorFx.effect", "selector", "sweep"],
  0x6f: ["multiIo.insertSource", "two_position", "return", "usb"],
  0x70: ["bluetooth.on", "switch"],
  0x76: ["beatFx.quantize", "switch"],
};
const CC: Record<number, Definition> = {
  0x01: ["channel.1.trim", "continuous"],
  0x02: ["channel.1.eq.high", "continuous"],
  0x03: ["channel.1.eq.mid", "continuous"],
  0x04: ["channel.1.eq.low", "continuous"],
  0x05: ["channel.1.color", "continuous"],
  0x06: ["channel.2.trim", "continuous"],
  0x07: ["channel.2.eq.high", "continuous"],
  0x08: ["channel.2.eq.mid", "continuous"],
  0x09: ["channel.2.eq.low", "continuous"],
  0x0a: ["channel.2.color", "continuous"],
  0x0b: ["crossfader.position", "continuous"],
  0x0c: ["channel.3.trim", "continuous"],
  0x0e: ["channel.3.eq.high", "continuous"],
  0x0f: ["channel.3.eq.mid", "continuous"],
  0x11: ["channel.1.fader", "continuous"],
  0x12: ["channel.2.fader", "continuous"],
  0x13: ["channel.3.fader", "continuous"],
  0x14: ["channel.4.fader", "continuous"],
  0x15: ["channel.3.eq.low", "continuous"],
  0x16: ["channel.3.color", "continuous"],
  0x18: ["master.level", "continuous"],
  0x19: ["booth.level", "continuous"],
  0x1a: ["headphonesA.level", "continuous"],
  0x1b: ["headphonesA.mixing", "continuous"],
  0x1e: ["microphone.eq.high", "continuous"],
  0x1f: ["microphone.eq.low", "continuous"],
  0x21: ["eq.curve", "two_position", "isolator", "eq"],
  0x22: ["headphonesB.monoSplit", "switch"],
  0x2a: ["beatFx.effect", "selector", "delay"],
  0x2b: ["beatFx.effect", "selector", "spiral"],
  0x2e: ["beatFx.effect", "selector", "roll"],
  0x2f: ["beatFx.effect", "selector", "tripletRoll"],
  0x32: ["beatFx.effect", "selector", "flanger"],
  0x33: ["beatFx.effect", "selector", "pingPong"],
  0x35: ["beatFx.effect", "selector", "trans"],
  0x36: ["beatFx.effect", "selector", "reverb"],
  0x37: ["beatFx.effect", "selector", "echo"],
  0x39: ["beatFx.effect", "selector", "phaser"],
  0x3a: ["beatFx.effect", "selector", "tripletFilter"],
  0x3b: ["beatFx.effect", "selector", "filter"],
  0x3d: ["beatFx.effect", "selector", "mobius"],
  0x3e: ["beatFx.effect", "selector", "helix"],
  0x40: ["multiIo.insert", "switch"],
  0x41: ["channel.1.crossfaderAssign", "three_position", "a", "thru", "b"],
  0x42: ["channel.2.crossfaderAssign", "three_position", "a", "thru", "b"],
  0x43: ["channel.3.crossfaderAssign", "three_position", "a", "thru", "b"],
  0x44: ["channel.4.crossfaderAssign", "three_position", "a", "thru", "b"],
  0x45: ["beatFx.autoTap", "switch"],
  0x4c: ["beatFx.beatLeft", "switch"],
  0x4d: ["beatFx.beatRight", "switch"],
  0x4e: ["beatFx.tap", "switch"],
  0x50: ["channel.4.trim", "continuous"],
  0x51: ["channel.4.eq.high", "continuous"],
  0x52: ["channel.4.eq.low", "continuous"],
  0x53: ["channel.4.color", "continuous"],
  0x55: ["headphonesB.mixing", "continuous"],
  0x56: ["headphonesB.level", "continuous"],
  0x5b: ["beatFx.levelDepth", "continuous"],
  0x5c: ["channel.4.eq.mid", "continuous"],
  0x5e: ["channelFader.curve", "three_position", "left", "center", "right"],
  0x5f: ["crossfader.curve", "three_position", "left", "center", "right"],
  0x61: ["microphone.fx.echo", "switch"],
  0x62: ["microphone.fx.pitch", "switch"],
  0x63: ["microphone.fx.megaphone", "switch"],
  0x64: ["microphone.fx.parameter", "continuous"],
  0x65: ["microphone.reverbParameter", "continuous"],
  0x66: ["beatFx.frequency.high", "switch"],
  0x67: ["beatFx.frequency.mid", "switch"],
  0x68: ["beatFx.frequency.low", "switch"],
  0x6c: ["soundColorFx.parameter", "continuous"],
  0x6d: ["booth.eq.high", "continuous"],
  0x6e: ["booth.eq.low", "continuous"],
  0x71: ["multiIo.sendLevel", "continuous"],
  0x72: ["beatFx.on", "switch"],
  0x74: ["beatFx.xPad", "continuous"],
};

export function createA9Decoder() {
  let msb = 0,
    lsb = 0;
  return (bytes: Uint8Array, timestamp: number): { name: string; control: ControlState } | null => {
    if (bytes.length !== 3) return null;
    const status = bytes[0]! & 0xf0,
      cc = bytes[1]!,
      value = status === 0x80 ? 0 : bytes[2]!;
    if (status !== 0xb0 && status !== 0x90 && status !== 0x80) return null;
    let definition = (status === 0xb0 ? CC : NOTES)[cc];
    let decodedValue = value;
    if (status === 0xb0 && (cc === 0x0d || cc === 0x2d)) {
      if (cc === 0x0d) msb = value;
      else lsb = value;
      decodedValue = (msb << 7) | lsb;
      return {
        name: "beatFx.time",
        control: {
          label: "Beat FX time",
          value: decodedValue,
          percent: (decodedValue / 16383) * 100,
          state: null,
          raw: Array.from(bytes).join(" "),
          changedAtUs: timestamp * 1000,
        },
      };
    }
    if (!definition) return null;
    const [name, kind, low, middle, high] = definition;
    const state =
      kind === "switch"
        ? value
          ? "on"
          : "off"
        : kind === "selector"
          ? value
            ? low!
            : "off"
          : kind === "two_position"
            ? value < 64
              ? low!
              : middle!
            : kind === "three_position"
              ? value < 32
                ? low!
                : value < 96
                  ? middle!
                  : high!
              : null;
    return {
      name,
      control: {
        label: name,
        value,
        percent: kind === "continuous" ? (value / 127) * 100 : null,
        state,
        raw: Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" "),
        changedAtUs: timestamp * 1000,
      },
    };
  };
}
