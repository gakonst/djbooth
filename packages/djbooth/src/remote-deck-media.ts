import { connect, type Socket } from "node:net";

type Field = number | string | Buffer;
export type RemoteDeckMedia = {
  title: string;
  artist: string;
  duration: number;
  waveform: {
    durationSeconds: number;
    peaks: number[];
    colors: number[][];
    beatGrid: { beat: number; timeSeconds: number }[];
    source: "rekordbox";
  };
};
function number(value: number, size = 4): Buffer {
  const data = Buffer.alloc(size + 1);
  data[0] = size === 4 ? 0x11 : size === 2 ? 0x10 : 0x0f;
  data.writeUIntBE(value >>> 0, 1, size);
  return data;
}
function message(tx: number, type: number, args: number[]): Buffer {
  const types = Buffer.alloc(12);
  types.fill(6, 0, args.length);
  return Buffer.concat([
    number(0x872349ae),
    number(tx),
    number(type, 2),
    number(args.length, 1),
    Buffer.from([0x14, 0, 0, 0, 12]),
    types,
    ...args.map((v) => number(v)),
  ]);
}
function reader(socket: Socket) {
  let buffer = Buffer.alloc(0);
  let wake: (() => void) | undefined;
  let error: Error | undefined;
  socket.on("data", (data) => {
    buffer = Buffer.concat([buffer, data]);
    wake?.();
  });
  socket.on("error", (e) => {
    error = e;
    wake?.();
  });
  socket.on("close", () => {
    error ??= new Error("RemoteDB disconnected");
    wake?.();
  });
  async function read(length: number): Promise<Buffer> {
    if (length > 8_000_000) throw new Error("RemoteDB field exceeds limit");
    while (buffer.length < length) {
      if (error) throw error;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    const result = buffer.subarray(0, length);
    buffer = buffer.subarray(length);
    return result;
  }
  async function field(): Promise<Field> {
    const kind = (await read(1))[0];
    if (kind === 0x0f || kind === 0x10 || kind === 0x11) {
      const size = kind === 0x11 ? 4 : kind === 0x10 ? 2 : 1;
      return (await read(size)).readUIntBE(0, size);
    }
    if (kind === 0x14 || kind === 0x26) {
      const length = (await read(4)).readUInt32BE();
      const data = await read(length * (kind === 0x26 ? 2 : 1));
      if (kind === 0x14) return data;
      return Buffer.from(data).swap16().toString("utf16le").replace(/\0+$/, "");
    }
    throw new Error(`Unknown RemoteDB field ${kind}`);
  }
  async function response() {
    if ((await field()) !== 0x872349ae) throw new Error("Invalid RemoteDB header");
    await field();
    const type = await field();
    const count = await field();
    const types = await field();
    if (typeof count !== "number" || count > 16 || !Buffer.isBuffer(types))
      throw new Error("Invalid RemoteDB arguments");
    const args: Field[] = [];
    for (let i = 0; i < count; i++)
      args.push(types[i] === 3 && args[i - 1] === 0 ? Buffer.alloc(0) : await field());
    return { type, args };
  }
  return { read, field, response };
}
/** Read-only RemoteDB queries. Source identity is kept outside the library's ID namespace. */
export async function readRemoteDeckMedia(
  ip: string,
  slot: number,
  trackId: number,
  requester = 18,
): Promise<RemoteDeckMedia> {
  const discovery = connect({ host: ip, port: 12523 });
  const discoveryReader = reader(discovery);
  const discoveryTimeout = setTimeout(
    () => discovery.destroy(new Error("RemoteDB discovery timeout")),
    3000,
  );
  let port: number;
  try {
    discovery.write(Buffer.from([0, 0, 0, 15, ...Buffer.from("RemoteDBServer"), 0]));
    port = (await discoveryReader.read(2)).readUInt16BE();
  } finally {
    clearTimeout(discoveryTimeout);
    discovery.destroy();
  }
  if (!port || port === 65535) throw new Error("Deck RemoteDB unavailable");
  const socket = connect({ host: ip, port });
  const input = reader(socket);
  const timeout = setTimeout(() => socket.destroy(new Error("RemoteDB media timeout")), 10000);
  let tx = 0;
  let stage = "greeting";
  try {
    socket.write(number(1));
    if ((await input.field()) !== 1) throw new Error("RemoteDB greeting rejected");
    stage = "setup";
    socket.write(message(0xfffffffe, 0, [requester]));
    const setup = await input.response();
    if (setup.type !== 0x4000) throw new Error("RemoteDB setup rejected");
    const rmst = ((requester << 24) | (1 << 16) | (slot << 8) | 1) >>> 0;
    stage = "metadata";
    socket.write(message(++tx, 0x2002, [rmst, trackId]));
    const available = await input.response();
    const count = available.args[1];
    if (available.type !== 0x4000 || typeof count !== "number" || count > 128)
      throw new Error("Remote metadata unavailable");
    stage = "menu rendering";
    socket.write(message(++tx, 0x3000, [rmst, 0, count, 0, count, 0]));
    let title = "",
      artist = "",
      duration = 0;
    for (let i = 0; i < count + 3; i++) {
      const item = await input.response();
      if (item.type === 0x4201) break;
      if (item.type !== 0x4101) continue;
      if (item.args[6] === 4) title = String(item.args[3]);
      if (item.args[6] === 7) artist = String(item.args[3]);
      if (item.args[6] === 11) duration = Number(item.args[1]);
    }
    const waveRmst = ((requester << 24) | (8 << 16) | (slot << 8) | 1) >>> 0;
    stage = "waveform";
    socket.write(message(++tx, 0x2904, [waveRmst, trackId, 0]));
    const wave = await input.response();
    const blob = wave.args.find((x) => Buffer.isBuffer(x) && x.length > 0);
    const peaks: number[] = [];
    const colors: number[][] = [];
    if (wave.type === 0x4a02 && Buffer.isBuffer(blob))
      for (const value of blob.subarray(19)) {
        peaks.push((value & 31) / 31);
        const intensity = (value >> 5) / 7;
        colors.push([30 + 140 * intensity, 100 + 100 * intensity, 255]);
      }
    stage = "RGB waveform";
    socket.write(
      message(++tx, 0x2c04, [
        waveRmst,
        trackId,
        Buffer.from("PWV5").readUInt32LE(),
        Buffer.from([69, 88, 84, 0]).readUInt32LE(),
      ]),
    );
    const rgb = await input.response();
    const rgbBlob = rgb.args.find((x) => Buffer.isBuffer(x) && x.length > 28);
    if (rgb.type === 0x4f02 && Buffer.isBuffer(rgbBlob)) {
      peaks.length = 0;
      colors.length = 0;
      for (let i = 28; i + 1 < rgbBlob.length; i += 2) {
        const v = rgbBlob.readUInt16BE(i);
        peaks.push(((v & 0x7c) >> 2) / 31);
        colors.push([
          (((v >> 13) & 7) * 255) / 7,
          (((v >> 10) & 7) * 255) / 7,
          (((v >> 7) & 7) * 255) / 7,
        ]);
      }
    }
    stage = "beat grid";
    socket.write(message(++tx, 0x2204, [waveRmst, trackId]));
    const grid = await input.response();
    const gridBlob = grid.args.find((x) => Buffer.isBuffer(x) && x.length >= 20);
    const beatGrid: { beat: number; timeSeconds: number }[] = [];
    if (grid.type === 0x4602 && Buffer.isBuffer(gridBlob)) {
      for (let i = 20; i + 15 < gridBlob.length; i += 16)
        beatGrid.push({
          beat: gridBlob.readUInt16LE(i),
          timeSeconds: gridBlob.readUInt32LE(i + 4) / 1000,
        });
    }
    if (!title) throw new Error("Remote metadata has no title");
    return {
      title,
      artist,
      duration,
      waveform: { durationSeconds: duration, peaks, colors, beatGrid, source: "rekordbox" },
    };
  } catch (error) {
    throw new Error(`RemoteDB ${stage}: ${error instanceof Error ? error.message : error}`);
  } finally {
    clearTimeout(timeout);
    socket.destroy();
  }
}
