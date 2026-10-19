/** Local-first browser workstation for agentic DJ workflows and compatible artifacts. */

export { libraryCli, runLibraryCli } from "./cli.js";
export {
  LibraryMutationConflictError,
  RekordboxLibraryService as DjBoothLibraryService,
  RekordboxLibraryService,
  type LibraryOptions,
  type TrackFilter,
  type TrackQuery,
} from "./server/library.js";
export {
  startLibraryServer,
  type LibraryApi,
  type LibraryServerOptions,
  type RunningLibraryServer,
} from "./server/server.js";
export { rotateLibraryPairing, type PairingDescriptor } from "./server/pairing.js";
export * from "./shared/types.js";
