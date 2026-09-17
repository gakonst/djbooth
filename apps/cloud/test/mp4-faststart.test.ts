import { describe, expect, it } from "vitest";
import { planFastStart } from "../src/mp4-faststart.js";

import {
  join,
  word,
  box,
  movie,
  ftyp,
  payload,
  fixture,
  plan,
  tableOffset,
} from "./mp4-fixture.js";

describe("virtual MP4 faststart planning", () => {
  for (const wide of [false, true]) {
    it(`moves movie metadata and patches ${wide ? "co64" : "stco"} without changing media`, async () => {
      const source = fixture(wide);
      const original = source.bytes.slice();
      const result = await plan(source.bytes);
      expect(result).not.toBeNull();
      expect(source.bytes).toEqual(original);
      const value = result!;
      const virtual = join(
        source.bytes.slice(0, value.insertionOffset),
        value.moov,
        source.bytes.slice(value.insertionOffset, value.moovOffset),
        source.bytes.slice(value.moovOffset + value.moovSize),
      );
      expect(virtual.length).toBe(source.bytes.length);
      expect(value.insertionOffset).toBe(source.mediaStart);
      const at = tableOffset(value.moov, wide ? "co64" : "stco");
      const index = new DataView(value.moov.buffer);
      source.chunkOffsets.forEach((offset, n) => {
        const patched = wide ? index.getBigUint64(at + n * 8) : BigInt(index.getUint32(at + n * 4));
        expect(patched).toBe(offset + BigInt(value.moovSize));
        expect(virtual[Number(patched)]).toBe(original[Number(offset)]);
      });
      expect(await plan(virtual)).toBeNull();
    });
  }
  it("rejects out-of-payload sample offsets and incomplete tables", async () => {
    const source = fixture();
    for (const offset of [
      0n,
      BigInt(source.mediaStart),
      BigInt(source.mediaStart + 8 + payload.length),
    ]) {
      expect(await plan(fixture(false, [offset]).bytes)).toBeNull();
    }
    const bytes = fixture().bytes;
    const at = tableOffset(bytes, "stco");
    new DataView(bytes.buffer).setUint32(at - 4, 3);
    expect(await plan(bytes)).toBeNull();
  });
  it("rejects fragments, compressed movie indexes, duplicate media/movie, and unsupported boxes", async () => {
    const source = fixture();
    for (const suffix of [
      box("moof"),
      box("mdat", payload),
      source.moov,
      box("sidx"),
      box("uuid"),
    ]) {
      expect(await plan(join(source.bytes, suffix))).toBeNull();
    }
    for (const extra of [box("mvex"), box("cmov")]) {
      expect(await plan(join(ftyp, box("mdat", payload), movie([24n], false, extra)))).toBeNull();
    }
  });
  it("rejects truncation, invalid sizes, missing ftyp, and short range reads", async () => {
    const { bytes } = fixture();
    expect(await plan(bytes.slice(0, -1))).toBeNull();
    expect(await plan(bytes.slice(ftyp.length))).toBeNull();
    for (const badSize of [0, 4, 0xffffffff]) {
      const malformed = bytes.slice();
      new DataView(malformed.buffer).setUint32(0, badSize);
      expect(await plan(malformed)).toBeNull();
    }
    expect(
      await planFastStart(bytes.length, async (offset, length) =>
        bytes.slice(offset, offset + length - 1),
      ),
    ).toBeNull();
  });
  it("bounds metadata and atom traversal without reading media payloads", async () => {
    const source = fixture();
    const reads: [number, number][] = [];
    expect(
      await planFastStart(source.bytes.length, async (offset, length) => {
        reads.push([offset, length]);
        return source.bytes.slice(offset, offset + length);
      }),
    ).not.toBeNull();
    expect(reads.every(([offset, length]) => offset !== source.mediaStart || length <= 16)).toBe(
      true,
    );
    expect(
      await plan(
        join(
          ftyp,
          ...Array.from({ length: 130 }, () => box("free")),
          box("mdat", payload),
          source.moov,
        ),
      ),
    ).toBeNull();
    expect(
      await plan(join(ftyp, box("mdat", payload), box("moov", new Uint8Array(2 * 1024 * 1024)))),
    ).toBeNull();
  });
  it("rejects stco overflow while preserving a large co64 offset", async () => {
    const mediaStart = ftyp.length;
    const mediaSize = 0x100000100;
    const header = join(word(1), new TextEncoder().encode("mdat"), new Uint8Array(8));
    new DataView(header.buffer).setBigUint64(8, BigInt(mediaSize));
    for (const wide of [false, true]) {
      const moov = movie([0xfffffff0n], wide);
      const moovStart = mediaStart + mediaSize;
      const result = await planFastStart(moovStart + moov.length, async (offset, length) => {
        if (offset === 0) return ftyp.slice(0, length);
        if (offset === mediaStart) return header.slice(0, length);
        if (offset === moovStart) return moov.slice(0, length);
        throw new Error("unexpected media read");
      });
      if (wide) {
        expect(result).not.toBeNull();
        expect(
          new DataView(result!.moov.buffer).getBigUint64(tableOffset(result!.moov, "co64")),
        ).toBe(0xfffffff0n + BigInt(moov.length));
      } else expect(result).toBeNull();
    }
  });
  it("preserves common keyed metadata while rejecting external or encrypted audio", async () => {
    const metadata = box(
      "udta",
      box("meta", word(0), box("hdlr"), box("keys", word(0), word(0)), box("ilst")),
    );
    expect(
      await plan(join(ftyp, box("mdat", payload), movie([24n], false, metadata))),
    ).not.toBeNull();
    const encrypted = fixture().bytes;
    const sampleType = tableOffset(encrypted, "mp4a") - 12;
    encrypted.set(new TextEncoder().encode("enca"), sampleType);
    expect(await plan(encrypted)).toBeNull();
    const external = fixture().bytes;
    const dataReference = tableOffset(external, "url ") - 8;
    new DataView(external.buffer).setUint32(dataReference, 0);
    expect(await plan(external)).toBeNull();
  });
  it("rejects malformed nested and extended-size atoms", async () => {
    const nested = fixture().bytes;
    const tableStart = tableOffset(nested, "stco") - 16;
    new DataView(nested.buffer).setUint32(tableStart, 0xffffffff);
    expect(await plan(nested)).toBeNull();
    const extended = join(word(1), new TextEncoder().encode("ftyp"), new Uint8Array(16));
    new DataView(extended.buffer).setBigUint64(8, BigInt(Number.MAX_SAFE_INTEGER) + 1n);
    expect(await plan(extended)).toBeNull();
  });
  it("propagates reader failures separately from unsupported layouts", async () => {
    await expect(
      planFastStart(100, async () => {
        throw new Error("R2 unavailable");
      }),
    ).rejects.toThrow("R2 unavailable");
  });
});
