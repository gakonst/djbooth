import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { createDeviceLibraryFixture } from "../../../packages/rekordbox-ts/test/helpers/device-library-fixture.js";

const path = process.argv[2];
if (!path || existsSync(path)) throw new Error("Supply a new, isolated fixture directory");
const fixture = createDeviceLibraryFixture(resolve(path));
console.log(`Created synthetic Rekordbox master.db: ${fixture.databasePath}`);
