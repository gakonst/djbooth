/** A virtual, same-length view of an immutable MP4 with its movie index first. */
export interface FastStartPlan {
  size: number;
  insertionOffset: number;
  moovOffset: number;
  moovSize: number;
  moov: Uint8Array;
}

const MAX_METADATA = 2 * 1024 * 1024;
const MAX_TOP_ATOMS = 128;
const MAX_MOVIE_ATOMS = 4096;
class UnsupportedMP4 extends Error {}
function requireMP4(condition: unknown): asserts condition {
  if (!condition) throw new UnsupportedMP4();
}
interface Atom {
  type: string;
  start: number;
  size: number;
  header: number;
}
function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
function atom(bytes: Uint8Array, start: number, end: number): Atom {
  requireMP4(start >= 0 && end - start >= 8 && bytes.length >= 8);
  const data = view(bytes);
  const shortSize = data.getUint32(0);
  const header = shortSize === 1 ? 16 : 8;
  requireMP4(bytes.length >= header);
  const wideSize = shortSize === 1 ? data.getBigUint64(8) : BigInt(shortSize);
  // Size-zero (to EOF) atoms are not movable without changing their header.
  requireMP4(wideSize >= BigInt(header) && wideSize <= BigInt(Number.MAX_SAFE_INTEGER));
  const size = Number(wideSize);
  requireMP4(size <= end - start);
  return { type: String.fromCharCode(...bytes.subarray(4, 8)), start, size, header };
}

/**
 * Plan only classic, self-contained audio MP4s. Unsupported/malformed layouts
 * return null. Read failures propagate so the caller can choose its I/O fallback.
 * No media payload is downloaded or rewritten; offsets in a copied moov change.
 */
export async function planFastStart(
  size: number,
  read: (offset: number, length: number) => Promise<Uint8Array>,
): Promise<FastStartPlan | null> {
  try {
    requireMP4(Number.isSafeInteger(size) && size >= 24);
    let metadataRead = 0;
    async function exact(offset: number, length: number): Promise<Uint8Array> {
      metadataRead += length;
      requireMP4(metadataRead <= MAX_METADATA);
      const bytes = await read(offset, length);
      requireMP4(bytes.length === length);
      return bytes;
    }
    const top: Atom[] = [];
    for (let offset = 0; offset < size; ) {
      requireMP4(top.length < MAX_TOP_ATOMS);
      const header = await exact(offset, Math.min(16, size - offset));
      const current = atom(header, offset, size);
      requireMP4(["ftyp", "free", "skip", "wide", "mdat", "moov"].includes(current.type));
      top.push(current);
      offset += current.size;
    }
    requireMP4(
      top[0]?.type === "ftyp" &&
        top[0].size >= top[0].header + 8 &&
        top.filter((a) => a.type === "ftyp").length === 1,
    );
    requireMP4(top.filter((a) => a.type === "moov").length === 1);
    requireMP4(top.filter((a) => a.type === "mdat").length === 1);
    const movie = top.find((a) => a.type === "moov")!;
    const media = top.find((a) => a.type === "mdat")!;
    requireMP4(movie.start > media.start && media.size > media.header);
    const insertionOffset = media.start;
    const moov = (await exact(movie.start, movie.size)).slice();
    const data = view(moov);
    let atoms = 0;
    let tables = 0;
    function children(start: number, end: number): Atom[] {
      const found: Atom[] = [];
      for (let offset = start; offset < end; ) {
        requireMP4(++atoms <= MAX_MOVIE_ATOMS);
        const current = atom(moov.subarray(offset, Math.min(offset + 16, end)), offset, end);
        found.push(current);
        offset += current.size;
      }
      return found;
    }
    function patch(table: Atom): void {
      const start = table.start + table.header;
      const end = table.start + table.size;
      requireMP4(end - start >= 8 && data.getUint32(start) === 0);
      const count = data.getUint32(start + 4);
      const width = table.type === "stco" ? 4 : 8;
      requireMP4(count > 0 && end - start - 8 === count * width);
      for (let i = 0; i < count; i++) {
        const at = start + 8 + i * width;
        const original = width === 4 ? BigInt(data.getUint32(at)) : data.getBigUint64(at);
        requireMP4(original >= BigInt(media.start + media.header));
        requireMP4(original < BigInt(media.start + media.size));
        const shifted = original + BigInt(movie.size);
        if (width === 4) {
          requireMP4(shifted <= 0xffffffffn);
          data.setUint32(at, Number(shifted));
        } else {
          data.setBigUint64(at, shifted);
        }
      }
      tables++;
    }
    function inspect(parent: string, start: number, end: number): void {
      const members = children(start, end);
      const allowed: Record<string, readonly string[]> = {
        moov: ["mvhd", "trak", "udta", "free"],
        trak: ["tkhd", "edts", "mdia", "udta", "free"],
        edts: ["elst"],
        mdia: ["mdhd", "hdlr", "minf"],
        minf: ["smhd", "dinf", "stbl"],
        dinf: ["dref"],
        stbl: [
          "stsd",
          "stts",
          "ctts",
          "stsc",
          "stsz",
          "stz2",
          "stss",
          "sdtp",
          "sgpd",
          "sbgp",
          "stco",
          "co64",
        ],
        udta: ["meta", "chpl"],
        meta: ["hdlr", "keys", "ilst", "free"],
      };
      requireMP4(members.every((member) => allowed[parent]?.includes(member.type)));
      if (parent === "moov") requireMP4(members.some((member) => member.type === "trak"));
      const requiredChild: Record<string, string> = { trak: "mdia", mdia: "minf", minf: "stbl" };
      if (requiredChild[parent]) {
        requireMP4(members.filter((member) => member.type === requiredChild[parent]).length === 1);
      }
      if (parent === "minf")
        requireMP4(members.filter((member) => member.type === "dinf").length === 1);
      if (parent === "dinf")
        requireMP4(members.filter((member) => member.type === "dref").length === 1);
      if (parent === "stbl") {
        requireMP4(members.filter((member) => ["stco", "co64"].includes(member.type)).length === 1);
        requireMP4(members.filter((member) => member.type === "stsd").length === 1);
      }
      for (const member of members) {
        const payload = member.start + member.header;
        const limit = member.start + member.size;
        if (member.type === "stco" || member.type === "co64") patch(member);
        else if (member.type === "stsd" || member.type === "dref") {
          requireMP4(limit - payload >= 8 && data.getUint32(payload) === 0);
          const entries = children(payload + 8, limit);
          requireMP4(entries.length > 0 && entries.length === data.getUint32(payload + 4));
          for (const entry of entries) {
            const entryPayload = entry.start + entry.header;
            if (member.type === "stsd") {
              requireMP4(["mp4a", "alac"].includes(entry.type) && entry.size - entry.header >= 28);
              // Sample entries reference a self-contained data reference.
              requireMP4(data.getUint16(entryPayload + 6) === 1);
            } else {
              requireMP4(
                entries.length === 1 && entry.type === "url " && entry.size - entry.header === 4,
              );
              requireMP4(data.getUint32(entryPayload) === 1);
            }
          }
        } else if (allowed[member.type]) {
          const skip = member.type === "meta" ? 4 : 0;
          requireMP4(limit - payload >= skip);
          if (skip) requireMP4(data.getUint32(payload) === 0);
          inspect(member.type, payload + skip, limit);
        }
      }
    }
    inspect("moov", movie.header, moov.length);
    requireMP4(tables > 0);
    return { size, insertionOffset, moovOffset: movie.start, moovSize: movie.size, moov };
  } catch (error) {
    if (error instanceof UnsupportedMP4) return null;
    throw error;
  }
}
