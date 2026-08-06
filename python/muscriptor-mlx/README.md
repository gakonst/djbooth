# MuScriptor MLX

MLX-native inference for the 1.4B-parameter `MuScriptor/muscriptor-large`
audio-to-MIDI model. Transformer inference and its KV cache run on Apple
Silicon through MLX; no PyTorch runtime is used.

The model weights are licensed CC BY-NC 4.0 and require accepting the model
terms on Hugging Face. Authenticate once with `hf auth login`, then:

```sh
uv run djbooth-muscriptor-mlx setup
uv run djbooth-muscriptor-mlx transcribe input.wav --output output.mid
```

`setup` pins the upstream safetensors and writes a one-time MLX checkpoint
using the same mixed precision as MuScriptor's Apple backend: fp16 transformer
weights and fp32 audio/class conditioners.
