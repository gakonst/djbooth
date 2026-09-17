import { planFastStart } from "../src/mp4-faststart.js";

export function join(...parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}
export function word(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}
export function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const payload = join(...parts);
  return join(word(payload.length + 8), new TextEncoder().encode(type), payload);
}
export function movie(offsets: bigint[], wide = false, extra?: Uint8Array): Uint8Array {
  const entries = new Uint8Array(offsets.length * (wide ? 8 : 4));
  const data = new DataView(entries.buffer);
  offsets.forEach((offset, i) =>
    wide ? data.setBigUint64(i * 8, offset) : data.setUint32(i * 4, Number(offset)),
  );
  const sample = new Uint8Array(28);
  new DataView(sample.buffer).setUint16(6, 1);
  return box(
    "moov",
    box("mvhd"),
    box(
      "trak",
      box("tkhd"),
      box(
        "mdia",
        box("mdhd"),
        box("hdlr"),
        box(
          "minf",
          box("smhd"),
          box("dinf", box("dref", word(0), word(1), box("url ", word(1)))),
          box(
            "stbl",
            box("stsd", word(0), word(1), box("mp4a", sample)),
            box(wide ? "co64" : "stco", word(0), word(offsets.length), entries),
          ),
        ),
      ),
    ),
    ...(extra ? [extra] : []),
  );
}
export const ftyp = box("ftyp", new TextEncoder().encode("M4A "), word(0));
export const free = box("free", new Uint8Array(8));
export const payload = Uint8Array.from({ length: 64 }, (_, i) => i + 1);
export function fixture(wide = false, offsets?: bigint[]) {
  const mediaStart = ftyp.length + free.length;
  const chunkOffsets = offsets ?? [BigInt(mediaStart + 8), BigInt(mediaStart + 40)];
  const moov = movie(chunkOffsets, wide);
  const bytes = join(ftyp, free, box("mdat", payload), moov, free);
  return { bytes, moov, mediaStart, chunkOffsets };
}
export async function plan(bytes: Uint8Array) {
  return planFastStart(bytes.length, async (offset, length) =>
    bytes.slice(offset, offset + length),
  );
}
export function tableOffset(bytes: Uint8Array, type: string) {
  const needle = new TextEncoder().encode(type);
  return bytes.findIndex((_, i) => needle.every((byte, n) => bytes[i + n] === byte)) + 12;
}
