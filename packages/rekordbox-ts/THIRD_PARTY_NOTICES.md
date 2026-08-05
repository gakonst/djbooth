# Third-party notices

## Empty legacy Device Library fixture

`src/devicelib/template.ts` contains a gzip-compressed copy of the empty
`PIONEER/rekordbox/export.pdb` fixture published by
[Holzhaus/rekordcrate](https://github.com/Holzhaus/rekordcrate) at commit-time source path
`data/complete_export/empty/PIONEER/rekordbox/export.pdb`.

rekordcrate is Copyright (c) 2026 Jan Holthuis and contributors and is distributed under the
Mozilla Public License, version 2.0. The fixture is retained unchanged and its SHA-256 is checked at
runtime. The surrounding exporter implementation is original music-ts code.

The MPL-2.0 text is available at <https://www.mozilla.org/MPL/2.0/>.

## Optional MLX stems runtime

The optional stems adapter installs `mlx-audio-separator` 0.1.5 from PyPI at runtime through the
checked-in uv lockfile. `mlx-audio-separator` is Copyright (c) ssmall256 and contributors and is
distributed under the MIT License. It incorporates MIT-licensed work from
`nomadkaraoke/python-audio-separator`, `lucidrains/BS-RoFormer`, and
`ZFTurbo/Music-Source-Separation-Training`. These Python packages are resolved into the user's uv
environment and are not copied into this npm package.

The adapter downloads `SYH99999/MelBandRoformer4StemFTLarge` revision
`62371baf060e8205915b4e6e3f9459fc016b6dd1` from Hugging Face. Its model card declares the
checkpoint Apache License 2.0. The 3,764,030,874-byte checkpoint is authenticated as SHA-256
`590358e6abe3255d87d7173ca2e4005de082f14cbb466ea4c5ffedbcc3964506`. Model weights remain in the
user's cache and are not redistributed with this project.

The MIT and Apache-2.0 license texts are available at <https://opensource.org/license/mit> and
<https://www.apache.org/licenses/LICENSE-2.0>.

## Optional A2SB MLX enhancement runtime

The optional enhancement adapter contains an MLX port of the `AttnUNetF` architecture and bridge
sampler from NVIDIA's `diffusion-audio-restoration` project. NVIDIA's implementation and the A2SB
model checkpoints are Copyright (c) 2025 NVIDIA Corporation and licensed under the NVIDIA Source
Code License for A2SB. That license limits the work and derivatives to noncommercial research or
evaluation. A complete copy is shipped with the standalone Python helper as
`NVIDIA-A2SB-LICENSE`.

The adapter downloads `nvidia/audio_to_audio_schrodinger_bridge` revision
`c3d0f52831b3c1c216ad98736dc9fd9253d38342` from Hugging Face and authenticates each release
checkpoint before conversion. Model weights remain in the user's cache and are not redistributed
with this package.
