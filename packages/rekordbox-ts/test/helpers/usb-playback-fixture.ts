import { spawnSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3-multiple-ciphers";

import { createDeviceLibraryFixture } from "./device-library-fixture.js";

const root = process.argv[2];
if (!root) throw new Error("Supply an isolated fixture directory");
const fixture = createDeviceLibraryFixture(root);
const database = new Database(fixture.databasePath);
try {
  for (const [index, path] of fixture.audioPaths.entries()) {
    const duration = 30 + index * 5;
    const result = spawnSync(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=${220 + index * 110}:sample_rate=44100`,
        "-t",
        String(duration),
        path,
      ],
      { stdio: "inherit" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error("Generating playable synthetic USB audio failed");
    database
      .prepare("UPDATE djmdContent SET Length = ?, FileSize = ? WHERE ID = ?")
      .run(duration, statSync(path).size, String(index + 1));
    // Deterministic synthetic analysis: exercise the real ANLZ export/read path.
    const beats = Buffer.alloc(24 + duration * 2 * 8);
    beats.write("PQTZ");
    beats.writeUInt32BE(24, 4);
    beats.writeUInt32BE(beats.length, 8);
    beats.writeUInt32BE(duration * 2, 20);
    for (let i = 0; i < duration * 2; i++) {
      beats.writeUInt16BE((i % 4) + 1, 24 + i * 8);
      beats.writeUInt16BE(12000, 26 + i * 8);
      beats.writeUInt32BE(i * 500, 28 + i * 8);
    }
    const wave = Buffer.alloc(420);
    wave.write("PWAV");
    wave.writeUInt32BE(20, 4);
    wave.writeUInt32BE(wave.length, 8);
    wave.writeUInt32BE(400, 12);
    for (let i = 0; i < 400; i++) wave[20 + i] = 5 + (i % 27);
    const pathToAnalysis = join(
      root,
      "share/PIONEER/USBANLZ",
      index === 0 ? "AAA/one" : "BBB/two",
      "ANLZ0000.DAT",
    );
    const data = Buffer.concat([readFileSync(pathToAnalysis), beats, wave]);
    data.writeUInt32BE(data.length, 8);
    writeFileSync(pathToAnalysis, data);
  }
} finally {
  database.close();
}
console.log(`Created playable synthetic USB source: ${fixture.databasePath}`);
