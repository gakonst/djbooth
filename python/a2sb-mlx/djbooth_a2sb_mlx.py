"""Command-line boundary for the noncommercial A2SB MLX restoration backend."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import math
import platform
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import mlx.core as mx
import mlx.nn as nn
import numpy as np
import soundfile as sf
import torch
from huggingface_hub import hf_hub_download
from safetensors.numpy import save_file
from scipy.signal import resample_poly

from a2sb_mlx import (
    AttnUNetF,
    posterior_step,
    predicted_x0,
    standard_deviation_bridge,
    temporal_embedding,
)

MODEL_REPOSITORY = "nvidia/audio_to_audio_schrodinger_bridge"
MODEL_REVISION = "c3d0f52831b3c1c216ad98736dc9fd9253d38342"
MODEL_LICENSE = "NVIDIA Source Code License for A2SB (noncommercial)"
SAMPLE_RATE = 44_100
FFT_SIZE = 2_048
HOP_LENGTH = 512
WINDOW_FRAMES = 256


@dataclass(frozen=True)
class Checkpoint:
    name: str
    filename: str
    sha256: str
    minimum_t: float
    maximum_t: float

    @property
    def converted_name(self) -> str:
        return f"{self.name}-f16.safetensors"


@dataclass
class LoadedModel:
    checkpoint: Checkpoint
    model: AttnUNetF
    forward: Any


CHECKPOINTS = (
    Checkpoint(
        "onesplit",
        "ckpt/A2SB_onesplit_0.0_1.0_release.ckpt",
        "fc3dac27c63ce736f5f9e72e12420afb65d63e7899947e6280d132a8f833b8ad",
        0.0,
        1.0,
    ),
    Checkpoint(
        "twosplit-low",
        "ckpt/A2SB_twosplit_0.0_0.5_release.ckpt",
        "07ec74c7c2455383b39cdc3a214faf0857261b8d70cf58b1d351b1363a82b74b",
        0.0,
        0.5,
    ),
    Checkpoint(
        "twosplit-high",
        "ckpt/A2SB_twosplit_0.5_1.0_release.ckpt",
        "92950134c19ea9b74c637aa414d9e192de2913adbf39fefe35a661dbb2357907",
        0.5,
        1.0,
    ),
)


def default_cache_directory() -> Path:
    return Path.home() / "Library" / "Caches" / "rekordbox-ts" / "enhancement" / "a2sb"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def checkpoint_path(cache: Path, checkpoint: Checkpoint) -> Path:
    return cache / "source" / checkpoint.filename


def converted_path(cache: Path, checkpoint: Checkpoint) -> Path:
    return cache / "mlx" / checkpoint.converted_name


def selected_checkpoints(profile: str) -> tuple[Checkpoint, ...]:
    if profile == "one-split":
        return (CHECKPOINTS[0],)
    if profile == "two-split":
        return CHECKPOINTS[1:]
    if profile == "all":
        return CHECKPOINTS
    raise ValueError(f"Unknown model profile: {profile}")


def download_checkpoint(cache: Path, checkpoint: Checkpoint) -> Path:
    path = Path(
        hf_hub_download(
            repo_id=MODEL_REPOSITORY,
            filename=checkpoint.filename,
            revision=MODEL_REVISION,
            local_dir=cache / "source",
        )
    )
    actual = sha256(path)
    if actual != checkpoint.sha256:
        raise RuntimeError(
            f"Checkpoint hash mismatch for {checkpoint.filename}: {actual} != {checkpoint.sha256}"
        )
    return path


def mlx_key(torch_key: str) -> str:
    """Map the release module names onto the explicit MLX module tree."""
    key = torch_key
    key = re.sub(r"^(enc_blocks|dec_blocks)\.(\d+)\.(\d+)\.", r"\1.\2.layers.\3.", key)
    key = re.sub(r"^middle_block\.(\d+)\.", r"middle_block.layers.\1.", key)
    key = key.replace(".in_layers.0.", ".in_norm.norm.")
    key = key.replace(".in_layers.2.", ".in_conv.")
    key = key.replace(".emb_layers.1.", ".embedding_conv.")
    key = key.replace(".out_norm.", ".out_norm.norm.")
    key = key.replace(".out_rest.2.", ".out_conv.")
    key = key.replace(".gnorm.", ".gnorm.norm.")
    key = re.sub(r"^output_projection\.0\.", "output_norm.norm.", key)
    key = re.sub(r"^output_projection\.2\.", "output_conv.", key)
    return key


def convert_checkpoint(source: Path, destination: Path, checkpoint: Checkpoint) -> dict[str, Any]:
    destination.parent.mkdir(parents=True, exist_ok=True)
    loaded = torch.load(source, map_location="cpu", mmap=True, weights_only=True)
    state = loaded["state_dict"]
    converted: dict[str, np.ndarray] = {}
    source_count = 0
    for key, tensor in state.items():
        if not key.startswith("vf_model."):
            continue
        if key.endswith(".pos_emb.freqs"):
            # Fixed pixel frequencies are computed directly by the MLX attention layer.
            continue
        source_count += tensor.numel()
        key = mlx_key(key.removeprefix("vf_model."))
        value = tensor.detach()
        if value.ndim == 4:
            value = value.permute(0, 2, 3, 1)
        converted[key] = value.to(torch.float16).contiguous().numpy()
    metadata = {
        "architecture": "A2SB AttnUNetF",
        "checkpoint_sha256": checkpoint.sha256,
        "dtype": "float16",
        "license": MODEL_LICENSE,
        "model_repository": MODEL_REPOSITORY,
        "model_revision": MODEL_REVISION,
        "source_checkpoint": checkpoint.filename,
    }
    save_file(converted, destination, metadata=metadata)
    return {
        "parameterCount": source_count,
        "path": str(destination),
        "sha256": sha256(destination),
        "size": destination.stat().st_size,
    }


def model_flat_keys(model: nn.Module) -> set[str]:
    from mlx.utils import tree_flatten

    return {key for key, _ in tree_flatten(model.parameters())}


def validate_converted_weights(path: Path) -> int:
    weights = mx.load(str(path))
    model = AttnUNetF()
    expected = model_flat_keys(model)
    actual = set(weights)
    missing = sorted(expected - actual)
    extra = sorted(actual - expected)
    if missing or extra:
        raise RuntimeError(
            f"Converted weight tree mismatch: missing={missing[:8]}, extra={extra[:8]}"
        )
    model.load_weights(list(weights.items()), strict=True)
    parameters = sum(math.prod(value.shape) for value in weights.values())
    del model, weights
    mx.clear_cache()
    return parameters


def setup(cache: Path, profile: str, force: bool) -> dict[str, Any]:
    artifacts = []
    for checkpoint in selected_checkpoints(profile):
        source = download_checkpoint(cache, checkpoint)
        destination = converted_path(cache, checkpoint)
        converted_this_run = force or not destination.is_file()
        if converted_this_run:
            detail = convert_checkpoint(source, destination, checkpoint)
        else:
            detail = {
                "path": str(destination),
                "sha256": sha256(destination),
                "size": destination.stat().st_size,
            }
        detail["parameterCount"] = validate_converted_weights(destination)
        detail.update(
            {
                "checkpoint": checkpoint.name,
                "convertedThisRun": converted_this_run,
                "sourcePath": str(source),
            }
        )
        artifacts.append(detail)
    return {
        "backend": "mlx",
        "cacheDirectory": str(cache),
        "license": MODEL_LICENSE,
        "model": "NVIDIA A2SB",
        "profile": profile,
        "revision": MODEL_REVISION,
        "weights": artifacts,
    }


def doctor(cache: Path) -> dict[str, Any]:
    statuses = []
    for checkpoint in CHECKPOINTS:
        source = checkpoint_path(cache, checkpoint)
        converted = converted_path(cache, checkpoint)
        statuses.append(
            {
                "checkpoint": checkpoint.name,
                "convertedPath": str(converted),
                "convertedReady": converted.is_file(),
                "sourcePath": str(source),
                "sourceReady": source.is_file(),
            }
        )
    return {
        "architecture": platform.machine(),
        "backend": "mlx",
        "cacheDirectory": str(cache),
        "checkpoints": statuses,
        "device": str(mx.default_device()),
        "license": MODEL_LICENSE,
        "macOS": platform.mac_ver()[0],
        "mlxVersion": importlib.metadata.version("mlx"),
        "model": "NVIDIA A2SB",
        "modelRevision": MODEL_REVISION,
        "python": platform.python_version(),
        "pythonEnvironment": sys.prefix,
    }


def read_audio(path: Path) -> tuple[np.ndarray, int]:
    try:
        audio, sample_rate = sf.read(path, dtype="float32", always_2d=True)
    except (RuntimeError, sf.LibsndfileError):
        probe = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_entries",
                "stream=channels",
                "-of",
                "json",
                str(path),
            ],
            check=True,
            stdout=subprocess.PIPE,
        )
        details = json.loads(probe.stdout)
        channels = min(2, int(details["streams"][0]["channels"]))
        decoded = subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-i",
                str(path),
                "-map",
                "0:a:0",
                "-ac",
                str(channels),
                "-ar",
                str(SAMPLE_RATE),
                "-f",
                "f32le",
                "pipe:1",
            ],
            check=True,
            stdout=subprocess.PIPE,
        )
        audio = np.frombuffer(decoded.stdout, dtype="<f4").reshape(-1, channels)
        sample_rate = SAMPLE_RATE
    if audio.shape[1] > 2:
        audio = audio[:, :2]
    if sample_rate != SAMPLE_RATE:
        common = math.gcd(sample_rate, SAMPLE_RATE)
        audio = resample_poly(audio, SAMPLE_RATE // common, sample_rate // common, axis=0)
        sample_rate = SAMPLE_RATE
    return np.asarray(audio, dtype=np.float32), sample_rate


def channel_encode(audio: np.ndarray, mode: str) -> np.ndarray:
    if audio.shape[1] == 1:
        return audio.T
    if mode == "independent":
        return audio.T
    left, right = audio[:, 0], audio[:, 1]
    scale = math.sqrt(0.5)
    return np.stack(((left + right) * scale, (left - right) * scale))


def channel_decode(audio: np.ndarray, mode: str, channels: int) -> np.ndarray:
    if channels == 1:
        return audio[0, :, None]
    if mode == "independent":
        return audio.T
    middle, side = audio[0], audio[1]
    scale = math.sqrt(0.5)
    return np.stack(((middle + side) * scale, (middle - side) * scale), axis=1)


def stft_representation(audio: np.ndarray) -> tuple[np.ndarray, torch.Tensor]:
    waveform = torch.from_numpy(audio)
    window = torch.hann_window(FFT_SIZE, periodic=True)
    complex_spec = torch.stft(
        waveform,
        n_fft=FFT_SIZE,
        hop_length=HOP_LENGTH,
        win_length=FFT_SIZE,
        window=window,
        center=True,
        pad_mode="reflect",
        return_complex=True,
    )
    complex_spec = complex_spec[:, 1:, :]
    magnitude = complex_spec.abs()
    phase_cos = complex_spec.real / (magnitude + 1e-9)
    phase_sin = complex_spec.imag / (magnitude + 1e-9)
    representation = torch.stack((magnitude.pow(0.25), phase_cos, phase_sin), dim=-1)
    return representation.numpy(), waveform


def inverse_representation(representation: np.ndarray, length: int) -> np.ndarray:
    tensor = torch.from_numpy(representation).permute(0, 3, 1, 2)
    scaled_magnitude = tensor[:, 0]
    magnitude = scaled_magnitude * scaled_magnitude.abs().pow(4) / (scaled_magnitude.abs() + 1e-9)
    phase_cos = tensor[:, 1]
    phase_sin = tensor[:, 2]
    phase_norm = torch.sqrt(phase_cos.square() + phase_sin.square()).clamp_min(1e-9)
    complex_spec = torch.complex(
        magnitude * phase_cos / phase_norm, magnitude * phase_sin / phase_norm
    )
    dc = torch.zeros((complex_spec.shape[0], 1, complex_spec.shape[2]), dtype=complex_spec.dtype)
    complex_spec = torch.cat((dc, complex_spec), dim=1)
    waveform = torch.istft(
        complex_spec,
        n_fft=FFT_SIZE,
        hop_length=HOP_LENGTH,
        win_length=FFT_SIZE,
        window=torch.hann_window(FFT_SIZE, periodic=True),
        center=True,
        length=length,
    )
    return waveform.numpy()


def spectral_rolloff(representation: np.ndarray, percentile: float = 0.99) -> int:
    magnitude = np.maximum(representation[..., 0], 0) ** 4
    mono = magnitude.mean(axis=0)
    cumulative = np.cumsum(mono, axis=0)
    threshold = percentile * cumulative[-1]
    indices = np.argmax(cumulative >= threshold[None, :], axis=0) + 1
    return int(np.mean(indices * SAMPLE_RATE / FFT_SIZE))


def detect_bandwidth_cutoff(representation: np.ndarray) -> tuple[int, int, str]:
    """Prefer a codec low-pass edge; fall back to A2SB's official 99% rolloff heuristic."""
    rolloff = spectral_rolloff(representation)
    magnitude = np.maximum(representation[..., 0], 0) ** 4
    profile = 20 * np.log10(np.maximum(np.mean(magnitude, axis=(0, 2)), 1e-12))
    smooth = np.convolve(profile, np.ones(9) / 9, mode="same")
    span = 24
    centers = np.arange(span, len(profile) - span)
    drops = smooth[2 * span :] - smooth[: -2 * span]
    frequencies = centers * SAMPLE_RATE / FFT_SIZE
    candidates = (frequencies >= 8_000) & (frequencies <= 20_500)
    candidate_centers = centers[candidates]
    candidate_drops = drops[candidates]
    edge_index = int(candidate_centers[np.argmin(candidate_drops)])
    edge_drop = float(np.min(candidate_drops))
    if edge_drop <= -12:
        return int(edge_index * SAMPLE_RATE / FFT_SIZE), rolloff, "codec-edge"
    return rolloff, rolloff, "spectral-rolloff"


def pad_width(array: np.ndarray, width: int, hop: int, constant: float | None = None) -> np.ndarray:
    current = array.shape[2]
    target = width if current <= width else math.ceil((current - width) / hop) * hop + width
    amount = target - current
    if amount <= 0:
        return array.copy()
    padding = array[:, :, :amount].copy()
    if constant is not None:
        padding.fill(constant)
    return np.concatenate((array, padding), axis=2)


def multidiffusion_vector_field(
    model: LoadedModel,
    x_t: mx.array,
    t: float,
    *,
    hop: int,
    batch_size: int,
) -> mx.array:
    source_batch, height, width, channels = x_t.shape
    starts = list(range(0, width - WINDOW_FRAMES + 1, hop))
    accumulator = np.zeros(x_t.shape, dtype=np.float32)
    counts = np.zeros((1, 1, width, 1), dtype=np.float32)
    for offset in range(0, len(starts), batch_size):
        chunk_starts = starts[offset : offset + batch_size]
        windows = mx.concatenate(
            [x_t[:, :, start : start + WINDOW_FRAMES, :] for start in chunk_starts], axis=0
        )
        embedding = temporal_embedding(
            t, batch=source_batch * len(chunk_starts), dtype=windows.dtype
        )
        output = model.forward(windows, embedding)
        mx.eval(output)
        output_np = np.asarray(output, dtype=np.float32)
        for index, start in enumerate(chunk_starts):
            batch_start = index * source_batch
            batch_end = batch_start + source_batch
            accumulator[:, :, start : start + WINDOW_FRAMES, :] += output_np[batch_start:batch_end]
            counts[:, :, start : start + WINDOW_FRAMES, :] += 1
        del windows, embedding, output
        # The 2048-channel U-Net can otherwise grow Metal's reusable allocation cache until
        # unified memory starts compressing/swapping on 32 GB machines.
        mx.clear_cache()
    return mx.array(accumulator / counts, dtype=x_t.dtype)


def load_models(cache: Path, profile: str) -> list[LoadedModel]:
    models = []
    for checkpoint in selected_checkpoints(profile):
        path = converted_path(cache, checkpoint)
        if not path.is_file():
            raise FileNotFoundError(f"Converted model missing: {path}; run enhancement setup first")
        model = AttnUNetF()
        model.load_weights(str(path), strict=True)
        model.eval()
        models.append(LoadedModel(checkpoint, model, mx.compile(model.__call__)))
    return models


def model_for_t(models: list[LoadedModel], t: float) -> LoadedModel:
    eligible = [model for model in models if t >= model.checkpoint.minimum_t]
    if not eligible:
        return models[0]
    return max(eligible, key=lambda model: model.checkpoint.minimum_t)


def enhance(
    input_path: Path,
    output_path: Path,
    cache: Path,
    *,
    profile: str,
    steps: int,
    cutoff: int | None,
    channel_mode: str,
    ode: bool,
    seed: int,
    batch_size: int,
    overlap: bool,
    start_seconds: float,
    max_seconds: float | None,
    force: bool,
) -> dict[str, Any]:
    started = time.monotonic()
    input_path = input_path.resolve()
    output_path = output_path.resolve()
    if input_path == output_path:
        raise ValueError("A2SB output must not replace the source audio")
    if output_path.suffix.lower() not in {".wav", ".flac"}:
        raise ValueError("A2SB output must use a .wav or .flac extension")
    if output_path.exists() and not force:
        raise FileExistsError(f"Output already exists: {output_path}; pass --force to replace it")
    audio, sample_rate = read_audio(input_path)
    original_channels = audio.shape[1]
    start_frame = int(start_seconds * sample_rate)
    if start_frame >= len(audio):
        raise ValueError(f"Start time {start_seconds}s is beyond the end of the recording")
    audio = audio[start_frame:]
    if max_seconds is not None:
        audio = audio[: int(max_seconds * sample_rate)]
    encoded = channel_encode(audio, channel_mode)
    representation, waveform = stft_representation(encoded)
    detected_cutoff, detected_rolloff, cutoff_method = detect_bandwidth_cutoff(representation)
    cutoff_hz = cutoff or detected_cutoff
    cutoff_bin = max(1, min(representation.shape[1] - 1, int(FFT_SIZE * cutoff_hz / SAMPLE_RATE)))
    mask = np.zeros_like(representation, dtype=np.float16)
    mask[:, cutoff_bin:, :, :] = 1
    rng = np.random.default_rng(seed)
    corrupted = representation * (1 - mask) + rng.standard_normal(representation.shape) * 0.5 * mask
    hop = WINDOW_FRAMES // 2 if overlap else WINDOW_FRAMES
    original_width = representation.shape[2]
    x1_np = pad_width(corrupted.astype(np.float16), WINDOW_FRAMES, hop)
    mask_np = pad_width(mask, WINDOW_FRAMES, hop)
    x1 = mx.array(x1_np)
    mask_mx = mx.array(mask_np)
    x_t = x1
    models = load_models(cache, profile)
    mx.random.seed(seed)

    def random_normal(shape: tuple[int, ...]) -> mx.array:
        return mx.random.normal(shape=shape)

    time_steps = np.linspace(1.0, 0.05, steps, dtype=np.float64)
    for index in range(len(time_steps) - 1):
        t = float(time_steps[index])
        previous = float(time_steps[index + 1])
        model = model_for_t(models, t)
        vector_field = multidiffusion_vector_field(model, x_t, t, hop=hop, batch_size=batch_size)
        x0 = predicted_x0(t, x_t, vector_field)
        x0 = x0 * mask_mx + (1 - mask_mx) * x1
        x_previous = posterior_step(previous, t, x_t, x0, random_normal=random_normal, ode=ode)
        known = x1
        if not ode:
            known = known + standard_deviation_bridge(previous) * random_normal(known.shape).astype(
                known.dtype
            )
        x_t = (1 - mask_mx) * known + mask_mx * x_previous
        mx.eval(x_t)
        del vector_field, x0, x_previous, known
        mx.clear_cache()
        print(f"A2SB step {index + 1}/{len(time_steps) - 1}", file=sys.stderr, flush=True)

    restored_representation = np.asarray(x_t[:, :, :original_width, :], dtype=np.float32)
    restored_encoded = inverse_representation(restored_representation, waveform.shape[-1])
    restored = channel_decode(restored_encoded, channel_mode, original_channels)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    subtype = "FLOAT" if output_path.suffix.lower() == ".wav" else "PCM_24"
    sf.write(output_path, restored, SAMPLE_RATE, subtype=subtype)
    result_hash = sha256(output_path)
    return {
        "backend": "mlx",
        "channelMode": channel_mode if original_channels > 1 else "mono",
        "cutoffHz": cutoff_hz,
        "cutoffMethod": "explicit" if cutoff is not None else cutoff_method,
        "detectedCutoffHz": detected_cutoff,
        "detectedRolloffHz": detected_rolloff,
        "device": str(mx.default_device()),
        "durationSeconds": len(restored) / SAMPLE_RATE,
        "inputPath": str(input_path.resolve()),
        "model": "NVIDIA A2SB",
        "modelRevision": MODEL_REVISION,
        "ode": ode,
        "output": {
            "path": str(output_path.resolve()),
            "sha256": result_hash,
            "size": output_path.stat().st_size,
        },
        "processingSeconds": time.monotonic() - started,
        "profile": profile,
        "sampleRate": SAMPLE_RATE,
        "seed": seed,
        "startSeconds": start_seconds,
        "steps": steps,
    }


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--cache-directory", type=Path, default=default_cache_directory())
    subparsers = result.add_subparsers(dest="command", required=True)
    subparsers.add_parser("doctor")
    setup_parser = subparsers.add_parser("setup")
    setup_parser.add_argument(
        "--profile", choices=("one-split", "two-split", "all"), default="one-split"
    )
    setup_parser.add_argument("--force", action="store_true")
    enhance_parser = subparsers.add_parser("enhance")
    enhance_parser.add_argument("input", type=Path)
    enhance_parser.add_argument("output", type=Path)
    enhance_parser.add_argument(
        "--profile", choices=("one-split", "two-split"), default="one-split"
    )
    enhance_parser.add_argument("--steps", type=int, default=50)
    enhance_parser.add_argument("--cutoff-hz", type=int)
    enhance_parser.add_argument(
        "--channel-mode", choices=("mid-side", "independent"), default="mid-side"
    )
    enhance_parser.add_argument("--ode", action="store_true")
    enhance_parser.add_argument("--seed", type=int, default=0)
    enhance_parser.add_argument("--batch-size", type=int, choices=(1, 2), default=1)
    enhance_parser.add_argument("--no-overlap", action="store_true")
    enhance_parser.add_argument("--max-seconds", type=float)
    enhance_parser.add_argument("--start-seconds", type=float, default=0)
    enhance_parser.add_argument("--force", action="store_true")
    return result


def main() -> None:
    args = parser().parse_args()
    cache = args.cache_directory.resolve()
    if args.command == "doctor":
        result = doctor(cache)
    elif args.command == "setup":
        result = setup(cache, args.profile, args.force)
    else:
        result = enhance(
            args.input,
            args.output,
            cache,
            profile=args.profile,
            steps=args.steps,
            cutoff=args.cutoff_hz,
            channel_mode=args.channel_mode,
            ode=args.ode,
            seed=args.seed,
            batch_size=args.batch_size,
            overlap=not args.no_overlap,
            start_seconds=args.start_seconds,
            max_seconds=args.max_seconds,
            force=args.force,
        )
    json.dump(result, sys.stdout, sort_keys=True)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
