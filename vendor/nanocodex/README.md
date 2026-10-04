# Nanocodex embed packages

DJBooth consumes public `nanocodex-connect-embed` exports. The matching public npm
artifacts for the embed, terminal and headless React packages are checked in here
until that exact SDK revision is available from npm. `manifest.json` records the
upstream commit, each archive's SHA-256, and hashes for the native package files. Root pnpm overrides keep the three
packages on the same revision without dependencies on a developer's checkout.

After building the packages in a clean Nanocodex checkout:

```sh
node scripts/vendor-nanocodex.mjs /path/to/nanocodex
pnpm install --no-frozen-lockfile
pnpm --filter @gakonst/djbooth-cloud check
pnpm --filter @gakonst/djbooth-cloud build
```

`--allow-dirty` is only for local integration checks. A `dirty: true` manifest
must be regenerated from the committed upstream SDK before merging or release.
The published `nanocodex@0.6.6` Connect transport remains pinned separately.

The same revision supplies the portable Swift packages under `apple/`:
`NanocodexConnectEmbed`, `NanocodexUI`, `NanocodexRemote`, and `InboxCore`.
The generated DJBooth Xcode project uses the relative path
`../../vendor/nanocodex/apple/NanocodexConnectEmbed`. Package manifests, sources,
tests, resources, dependency resolutions, and upstream licenses are preserved;
local Swift build caches are excluded. `apple/MOBILE_DEPENDENCY_NOTICES.md`
retains upstream native dependency notices for inclusion in the app bundle. Native compilation requires an Apple
build environment and the external Swift dependencies declared by upstream.
