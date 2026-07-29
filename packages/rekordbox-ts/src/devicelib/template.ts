import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

const EMPTY_EXPORT_PDB_BYTES = 167_936;
const EMPTY_EXPORT_PDB_SHA256 = "aa22564888963e1ad1771b20cc858a3dc36b235a4463309da244d6894d605a09";

/*
 * Gzip-compressed empty legacy Device Library exported by Rekordbox.
 *
 * Source:
 * https://github.com/Holzhaus/rekordcrate/blob/main/data/complete_export/empty/
 *   PIONEER/rekordbox/export.pdb
 *
 * The fixture is distributed by rekordcrate under MPL-2.0. See
 * packages/rekordbox-ts/THIRD_PARTY_NOTICES.md. It contains the empty DeviceSQL
 * table scaffold and the standard color/menu/column rows; generated track and
 * playlist data is appended by this package.
 */
const EMPTY_EXPORT_PDB_GZIP_BASE64 =
  "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";

const emptyTemplate = gunzipSync(Buffer.from(EMPTY_EXPORT_PDB_GZIP_BASE64, "base64"));
if (emptyTemplate.length !== EMPTY_EXPORT_PDB_BYTES)
  throw new Error(
    `Embedded empty export.pdb has ${String(emptyTemplate.length)} bytes, expected ${String(EMPTY_EXPORT_PDB_BYTES)}`,
  );
const emptyTemplateHash = createHash("sha256").update(emptyTemplate).digest("hex");
if (emptyTemplateHash !== EMPTY_EXPORT_PDB_SHA256)
  throw new Error(`Embedded empty export.pdb failed its SHA-256 integrity check`);

/** Return a private mutable copy of the empty legacy Device Library database. */
export function createEmptyLegacyDevicePdb(): Buffer {
  return Buffer.from(emptyTemplate);
}
