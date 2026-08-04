# DJ Link native implementation provenance

- Imported: 2026-07-26
- Source: private `gakonst/djskills`
- Base commit: `42edcfc57cba0bc70dd9546a221eced8cfb79648`
- Source working-tree DJ Link diff SHA-256:
  `0990d0b9d218a37d05618a2597c832fb8013a992f794eae2d44b906ddc7f5d3e`
- Imported core/link tree SHA-256, before workspace formatting:
  `f4b3483fc87cc7a126613667b6a6b35efc1274c0fa5b942de2510e83b5f0d0c3`

The imported working tree passed all 82 `djtools-link` tests before migration.
The TypeScript package owns manifest projection and daemon lifecycle; this
native workspace retains the packet, RemoteDB, NFS, analysis, load, and
telemetry implementation.
