# A2SB MLX

Apple-Silicon inference and checkpoint conversion for NVIDIA's Audio-to-Audio Schrödinger
Bridge (A2SB) music restoration model. This optional backend is restricted to noncommercial use
by NVIDIA's A2SB source and model license.

The helper keeps A2SB's 44.1 kHz, 2048-point STFT representation, rotary attention U-Net,
Schrödinger bridge sampler, and overlapping MultiDiffusion windows. Runtime neural-network
inference runs through MLX; PyTorch is used on CPU for checkpoint decoding and exact STFT/ISTFT
compatibility.

Use the typed `pnpm djbooth enhancement ...` workflow from the repository root rather than calling
this implementation helper directly.

The pinned release network contains 565,544,707 parameters. Setup authenticates NVIDIA's original
2.26 GB PyTorch checkpoint and converts convolution layouts and weights to a strict 1.13 GB float16
safetensors model. The default one-split checkpoint produced the closest high-band spectrum in the
local 128 kb/s AAC benchmark; the official time-partitioned two-split ensemble remains selectable.

Inference automatically looks for a sharp codec low-pass edge before falling back to A2SB's 99%
spectral-rolloff heuristic. Stereo is processed as mid/side by default, known bins stay conditioned
on the decoded source, and output is always a new float WAV or 24-bit FLAC. MLX graph compilation,
flash scaled-dot-product attention, float16 convolution weights, and bounded Metal-cache clearing
are tuned for a 32 GB M2 Max. A batch size of one temporal window is intentional: larger batches
increase unified-memory pressure enough to lose throughput on long recordings.
