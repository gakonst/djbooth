"""MLX implementation of NVIDIA A2SB's attention U-Net and bridge sampler.

The architecture is adapted from NVIDIA's diffusion-audio-restoration project.
Copyright (c) 2025 NVIDIA CORPORATION. All rights reserved.
Licensed under the NVIDIA Source Code License for A2SB; see NVIDIA-A2SB-LICENSE.

The original architecture also incorporates MIT-licensed Guided Diffusion ideas.
This port keeps A2SB's numerical conventions while using channels-last MLX kernels.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Sequence

import mlx.core as mx
import mlx.nn as nn

HIDDEN_CHANNELS = (128, 256, 512, 768, 1024, 2048)
ATTENTION_LEVELS = frozenset((3, 4))


class GroupNorm32(nn.Module):
    """PyTorch-compatible GroupNorm with float32 statistics."""

    def __init__(self, channels: int):
        super().__init__()
        self.norm = nn.GroupNorm(32, channels, pytorch_compatible=True)

    def __call__(self, x: mx.array) -> mx.array:
        dtype = x.dtype
        return self.norm(x.astype(mx.float32)).astype(dtype)


class ConditionalSequential(nn.Module):
    def __init__(self, *layers: nn.Module):
        super().__init__()
        self.layers = list(layers)

    def __call__(self, x: mx.array, embedding: mx.array) -> mx.array:
        for layer in self.layers:
            if isinstance(layer, ResBlock):
                x = layer(x, embedding)
            else:
                x = layer(x)
        return x


class ResBlock(nn.Module):
    def __init__(self, channels: int, embedding_channels: int):
        super().__init__()
        self.in_norm = GroupNorm32(channels)
        self.in_conv = nn.Conv2d(channels, channels, 3, padding=1)
        self.embedding_conv = nn.Conv2d(embedding_channels, channels * 2, 1)
        self.out_norm = GroupNorm32(channels)
        self.out_conv = nn.Conv2d(channels, channels, 3, padding=1)

    def __call__(self, x: mx.array, embedding: mx.array) -> mx.array:
        h = self.in_conv(nn.silu(self.in_norm(x)))
        scale_shift = self.embedding_conv(nn.silu(embedding))
        scale, shift = mx.split(scale_shift, 2, axis=-1)
        h = self.out_norm(h) * (1 + scale) + shift
        # Dropout in the training graph is disabled for inference.
        h = self.out_conv(nn.silu(h))
        return x + h


class Downsample(nn.Module):
    def __init__(self, in_channels: int, out_channels: int):
        super().__init__()
        self.op = nn.Conv2d(in_channels, out_channels, 3, stride=2, padding=1)

    def __call__(self, x: mx.array) -> mx.array:
        return self.op(x)


class Upsample(nn.Module):
    def __init__(self, in_channels: int, out_channels: int):
        super().__init__()
        self.up = nn.Upsample(2, mode="nearest")
        self.conv = nn.Conv2d(in_channels, out_channels, 3, padding=1)

    def __call__(self, x: mx.array) -> mx.array:
        return self.conv(self.up(x))


def _rotate_half(x: mx.array) -> mx.array:
    paired = x.reshape(*x.shape[:-1], -1, 2)
    return mx.stack((-paired[..., 1], paired[..., 0]), axis=-1).reshape(x.shape)


def axial_pixel_frequencies(height: int, width: int, rotary_dim: int = 32) -> mx.array:
    """Match rotary-embedding-torch's pixel-mode ``get_axial_freqs`` exactly."""
    base = mx.linspace(1.0, 32.0, rotary_dim // 2, dtype=mx.float32) * math.pi
    y = mx.linspace(-1.0, 1.0, height, dtype=mx.float32)
    x = mx.linspace(-1.0, 1.0, width, dtype=mx.float32)
    y_freq = mx.repeat(y[:, None] * base[None, :], 2, axis=-1)
    x_freq = mx.repeat(x[:, None] * base[None, :], 2, axis=-1)
    y_grid = mx.broadcast_to(y_freq[:, None, :], (height, width, rotary_dim))
    x_grid = mx.broadcast_to(x_freq[None, :, :], (height, width, rotary_dim))
    return mx.concatenate((y_grid, x_grid), axis=-1)


def apply_rotary(x: mx.array, frequencies: mx.array) -> mx.array:
    rotary_channels = frequencies.shape[-1]
    middle = x[..., :rotary_channels].astype(mx.float32)
    rotated = middle * mx.cos(frequencies) + _rotate_half(middle) * mx.sin(frequencies)
    return mx.concatenate((rotated.astype(x.dtype), x[..., rotary_channels:]), axis=-1)


class RotaryAttention2d(nn.Module):
    def __init__(self, channels: int, num_heads: int = 8):
        super().__init__()
        self.gnorm = GroupNorm32(channels)
        self.q_proj = nn.Conv2d(channels, channels, 1)
        self.k_proj = nn.Conv2d(channels, channels, 1)
        self.v_proj = nn.Conv2d(channels, channels, 1)
        self.channels = channels
        self.num_heads = num_heads

    def __call__(self, x: mx.array) -> mx.array:
        x = self.gnorm(x)
        batch, height, width, _ = x.shape
        head_dim = self.channels // self.num_heads

        def heads(projection: nn.Conv2d) -> mx.array:
            value = projection(x).reshape(batch, height, width, self.num_heads, head_dim)
            return value.transpose(0, 3, 1, 2, 4)

        q = heads(self.q_proj)
        k = heads(self.k_proj)
        v = heads(self.v_proj)
        frequencies = axial_pixel_frequencies(height, width)
        q = apply_rotary(q, frequencies).reshape(batch, self.num_heads, height * width, head_dim)
        k = apply_rotary(k, frequencies).reshape(batch, self.num_heads, height * width, head_dim)
        v = v.reshape(batch, self.num_heads, height * width, head_dim)
        output = mx.fast.scaled_dot_product_attention(q, k, v, scale=head_dim**-0.5)
        return (
            output.reshape(batch, self.num_heads, height, width, head_dim)
            .transpose(0, 2, 3, 1, 4)
            .reshape(batch, height, width, self.channels)
        )


class AttnUNetF(nn.Module):
    """A2SB release architecture, represented as BHWC for MLX."""

    def __init__(
        self,
        hidden_channels: Sequence[int] = HIDDEN_CHANNELS,
        attention_levels: frozenset[int] = ATTENTION_LEVELS,
        num_res_blocks: int = 2,
        band_embedding_dim: int = 16,
        temporal_embedding_dim: int = 128,
        num_heads: int = 8,
    ):
        super().__init__()
        self.hidden_channels = tuple(hidden_channels)
        self.level_count = len(hidden_channels) - 1
        self.band_embedding_dim = band_embedding_dim
        embedding_channels = temporal_embedding_dim + band_embedding_dim
        self.input_projection = nn.Conv2d(3, hidden_channels[0], 3, padding=1)
        self.enc_blocks: list[ConditionalSequential] = []
        self.ds_layers: list[Downsample] = []
        self.us_layers: list[Upsample] = []
        self.dec_blocks: list[ConditionalSequential] = []

        decoder_attention_levels = {self.level_count - 1 - level for level in attention_levels}
        for level in range(self.level_count):
            enc_layers: list[nn.Module] = []
            for _ in range(num_res_blocks):
                enc_layers.append(ResBlock(hidden_channels[level], embedding_channels))
                if level in attention_levels:
                    enc_layers.append(RotaryAttention2d(hidden_channels[level], num_heads))
            self.enc_blocks.append(ConditionalSequential(*enc_layers))
            self.ds_layers.append(Downsample(hidden_channels[level], hidden_channels[level + 1]))

            decoder_channels = hidden_channels[self.level_count - level]
            dec_layers: list[nn.Module] = []
            for _ in range(num_res_blocks):
                dec_layers.append(ResBlock(decoder_channels, embedding_channels))
                if level in decoder_attention_levels:
                    dec_layers.append(RotaryAttention2d(decoder_channels, num_heads))
            self.dec_blocks.append(ConditionalSequential(*dec_layers))
            self.us_layers.append(
                Upsample(decoder_channels, hidden_channels[self.level_count - level - 1])
            )

        deepest = hidden_channels[-1]
        self.middle_block = ConditionalSequential(
            ResBlock(deepest, embedding_channels),
            RotaryAttention2d(deepest, num_heads),
            ResBlock(deepest, embedding_channels),
        )
        self.output_norm = GroupNorm32(hidden_channels[0])
        self.output_conv = nn.Conv2d(hidden_channels[0], 3, 3, padding=1)

    def band_embedding(self, bands: int, width: int, batch: int, dtype: mx.Dtype) -> mx.array:
        frequencies = mx.arange(1, self.band_embedding_dim // 2 + 1, dtype=mx.float32)
        coordinates = mx.arange(bands, dtype=mx.float32)
        angles = frequencies[:, None] * coordinates[None, :] * (2 * 3.14 / (3 * bands))
        embedding = mx.concatenate((mx.cos(angles), mx.sin(angles)), axis=0).T
        return mx.broadcast_to(
            embedding[None, :, None, :], (batch, bands, width, self.band_embedding_dim)
        ).astype(dtype)

    def broadcast_embedding(self, embedding: mx.array, h: mx.array) -> mx.array:
        batch, bands, width, _ = h.shape
        temporal = mx.broadcast_to(
            embedding[:, None, None, :], (batch, bands, width, embedding.shape[-1])
        )
        return mx.concatenate(
            (self.band_embedding(bands, width, batch, h.dtype), temporal.astype(h.dtype)), axis=-1
        )

    def __call__(self, x: mx.array, embedding: mx.array) -> mx.array:
        skips: list[mx.array] = []
        embeddings: list[mx.array] = []
        h = self.input_projection(x)
        for enc_block, downsample in zip(self.enc_blocks, self.ds_layers, strict=True):
            broadcast = self.broadcast_embedding(embedding, h)
            embeddings.append(broadcast)
            h = enc_block(h, broadcast)
            h = downsample(h)
            skips.append(h)
        embeddings.append(self.broadcast_embedding(embedding, h))
        h = self.middle_block(h, embeddings[-1])
        for dec_block, upsample in zip(self.dec_blocks, self.us_layers, strict=True):
            h = h + skips.pop()
            h = dec_block(h, embeddings.pop())
            h = upsample(h)
        return self.output_conv(nn.silu(self.output_norm(h)))


def temporal_embedding(t: float | mx.array, batch: int = 1, dtype=mx.float32) -> mx.array:
    values = mx.array([t], dtype=mx.float32) if isinstance(t, float) else t.astype(mx.float32)
    values = mx.broadcast_to(values.reshape(-1, 1), (batch, 1))
    multipliers = mx.linspace(0.5, 16.0, 64, dtype=mx.float32)[None, :]
    angles = values * multipliers
    return mx.concatenate((mx.sin(angles), mx.cos(angles)), axis=-1).astype(dtype)


def integrated_beta(t: float, beta_max: float = 1.0) -> float:
    full_integral = 2 * beta_max * (0.5**3) / 3
    if t > 0.5:
        return full_integral - beta_max * ((1 - t) ** 3) / 3
    return beta_max * (t**3) / 3


def standard_deviation_forward(t: float, beta_max: float = 1.0) -> float:
    return math.sqrt(integrated_beta(t, beta_max))


def standard_deviation_bridge(t: float, beta_max: float = 1.0) -> float:
    forward = standard_deviation_forward(t, beta_max)
    reverse = standard_deviation_forward(1 - t, beta_max)
    variance = (forward * forward * reverse * reverse) / (forward * forward + reverse * reverse)
    return math.sqrt(variance)


def predicted_x0(t: float, x_t: mx.array, vector_field: mx.array) -> mx.array:
    return x_t - standard_deviation_forward(t) * vector_field


def posterior_step(
    t_previous: float,
    t: float,
    x_t: mx.array,
    x0: mx.array,
    *,
    random_normal: Callable[[tuple[int, ...]], mx.array],
    ode: bool,
) -> mx.array:
    std_t = standard_deviation_forward(t)
    std_previous = standard_deviation_forward(t_previous)
    std_delta = math.sqrt(max(0.0, std_t * std_t - std_previous * std_previous))
    denominator = std_previous * std_previous + std_delta * std_delta
    x0_coefficient = (std_delta * std_delta) / denominator
    xt_coefficient = (std_previous * std_previous) / denominator
    variance = (std_previous * std_previous * std_delta * std_delta) / denominator
    result = x0_coefficient * x0 + xt_coefficient * x_t
    if not ode and t_previous > 0:
        result = result + math.sqrt(variance) * random_normal(result.shape).astype(result.dtype)
    return result
