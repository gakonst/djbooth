/**
 * TypeScript tools for reading and writing Rekordbox libraries and export formats.
 *
 * @packageDocumentation
 */

import { createRequire } from "node:module";

export const { version } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

export * from "./anlz/index.js";
export * from "./analyzer/index.js";
export * from "./config/index.js";
export { DeviceLibraryPlus, type DeviceLibraryPlusOptions } from "./devicelib-plus/index.js";
export * from "./masterdb/index.js";
export * from "./mysettings/index.js";
export * from "./utils.js";
export * from "./xml/index.js";
