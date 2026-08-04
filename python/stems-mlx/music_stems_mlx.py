#!/usr/bin/env python3
"""MLX-backed four-source separation with Rekordbox-compatible recombination."""

from __future__ import annotations

import argparse
import gc
import hashlib
import importlib.metadata
import json
import logging
import os
import platform
import shutil
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

MODEL_REPOSITORY = "SYH99999/MelBandRoformer4StemFTLarge"
MODEL_REVISION = "62371baf060e8205915b4e6e3f9459fc016b6dd1"
MODEL_FILENAME = "MelBandRoformer4StemFTLarge.ckpt"
MODEL_SHA256 = "590358e6abe3255d87d7173ca2e4005de082f14cbb466ea4c5ffedbcc3964506"
MODEL_SIZE = 3_764_030_874
SAFETENSORS_SHA256 = "9d2817f7f0f5b002a89dcc4d0d50b9469d3acb92fab2cdfd869523945a2d4f86"
SAFETENSORS_SIZE = 3_763_491_360
CONFIG_FILENAME = "config.yaml"
CONFIG_SHA256 = "78e7b1da662fce6045fc5d8737e940e5f25c4c4045ca9e0458de1606a93df479"
MODEL_LICENSE = "Apache-2.0"
SAMPLE_RATE = 44_100
LAYOUT_STEMS = {
    "rekordbox": ("instrumental", "vocals", "drums"),
    "four-stem": ("drums", "bass", "other", "vocals"),
}


def default_cache_directory() -> Path:
    """Return the persistent model cache used on macOS."""
    return (
        Path.home()
        / "Library"
        / "Caches"
        / "rekordbox-ts"
        / "stems"
        / "mel-band-roformer-4stem-ft-large"
    )


def sha256_file(path: Path) -> str:
    """Hash a file without retaining it in memory."""
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def model_paths(cache_directory: Path) -> tuple[Path, Path, Path]:
    checkpoint = cache_directory / MODEL_FILENAME
    config = cache_directory / CONFIG_FILENAME
    converted = checkpoint.with_suffix(".safetensors")
    return checkpoint, config, converted


def verified(path: Path, expected_size: int | None, expected_sha256: str) -> bool:
    marker = path.with_name(f"{path.name}.verified.json")
    if not path.is_file() or (expected_size is not None and path.stat().st_size != expected_size):
        return False
    if marker.is_file():
        try:
            payload = json.loads(marker.read_text(encoding="utf-8"))
            if (
                payload.get("sha256") == expected_sha256
                and payload.get("size") == path.stat().st_size
                and payload.get("mtimeNs") == path.stat().st_mtime_ns
            ):
                return True
        except (OSError, ValueError):
            pass
    actual = sha256_file(path)
    if actual != expected_sha256:
        raise RuntimeError(f"SHA-256 mismatch for {path}: expected {expected_sha256}, got {actual}")
    marker.write_text(
        json.dumps(
            {
                "mtimeNs": path.stat().st_mtime_ns,
                "sha256": actual,
                "size": path.stat().st_size,
            }
        )
        + "\n",
        encoding="utf-8",
    )
    return True


def require_apple_silicon() -> None:
    if sys.platform != "darwin" or platform.machine() != "arm64":
        raise RuntimeError("The MLX stems backend requires macOS on Apple Silicon")


def download_model(cache_directory: Path) -> tuple[Path, Path, Path]:
    """Fetch and authenticate the pinned model artifacts."""
    from huggingface_hub import hf_hub_download

    cache_directory.mkdir(parents=True, exist_ok=True)
    checkpoint, config, converted = model_paths(cache_directory)
    if not verified(config, None, CONFIG_SHA256):
        hf_hub_download(
            repo_id=MODEL_REPOSITORY,
            filename=CONFIG_FILENAME,
            revision=MODEL_REVISION,
            local_dir=cache_directory,
        )
        verified(config, None, CONFIG_SHA256)
    if not converted.is_file() and not verified(checkpoint, MODEL_SIZE, MODEL_SHA256):
        hf_hub_download(
            repo_id=MODEL_REPOSITORY,
            filename=MODEL_FILENAME,
            revision=MODEL_REVISION,
            local_dir=cache_directory,
        )
        verified(checkpoint, MODEL_SIZE, MODEL_SHA256)
    return checkpoint, config, converted


def patch_skip_connected_mel_roformer() -> None:
    """Restore ZFTurbo's skip-connected transformer schedule in the MLX port."""
    import mlx.core as mx
    from mlx_audio_separator.separator.models.roformer.bs_roformer import (
        pack,
        rearrange,
        unpack,
    )
    from mlx_audio_separator.separator.models.roformer.mel_band_roformer import (
        MelBandRoformerMLX,
    )

    if getattr(MelBandRoformerMLX, "_rekordbox_skip_patch", False):
        return

    def forward_transformers(self: Any, x: Any) -> Any:
        stored: list[Any] = []
        for index in range(self.depth):
            block = getattr(self, f"layers_{index}")
            if block.has_linear:
                x, packed_shape = pack([x], "b * d")
                x = block.linear_transformer(x)
                (x,) = unpack(x, packed_shape, "b * d")

            for previous in stored:
                x = x + previous

            x = rearrange(x, "b t f d -> b f t d")
            x, packed_shape = pack([x], "* t d")
            x = block.time_transformer(x)
            (x,) = unpack(x, packed_shape, "* t d")

            x = rearrange(x, "b f t d -> b t f d")
            x, packed_shape = pack([x], "* f d")
            x = block.freq_transformer(x)
            (x,) = unpack(x, packed_shape, "* f d")
            stored.append(x)
        return x

    MelBandRoformerMLX._forward_transformers = forward_transformers
    MelBandRoformerMLX._rekordbox_skip_patch = True
    # The factory compiles this patched method after constructing the model.
    os.environ.setdefault("MLX_ENABLE_COMPILE", "1")
    os.environ.setdefault("MLX_USE_FAST_SDP", "1")
    mx.set_default_device(mx.gpu)


def load_config(config_path: Path) -> dict[str, Any]:
    import yaml

    with config_path.open(encoding="utf-8") as source:
        config = yaml.load(source, Loader=yaml.FullLoader)
    if not isinstance(config, dict):
        raise RuntimeError(f"Invalid model config: {config_path}")
    config["is_roformer"] = True
    return config


def convert_model(cache_directory: Path) -> dict[str, Any]:
    """Convert the pinned PyTorch checkpoint once for MLX-native future loads."""
    require_apple_silicon()
    checkpoint, config_path, converted = download_model(cache_directory)
    if verified(converted, SAFETENSORS_SIZE, SAFETENSORS_SHA256):
        return setup_result(cache_directory, converted=False)

    patch_skip_connected_mel_roformer()
    from mlx_audio_separator.separator.models.roformer.loader import load_roformer_model

    os.environ["MLX_SAVE_SAFETENSORS"] = "1"
    logging.getLogger(__name__).info("Converting the pinned checkpoint to MLX safetensors")
    model, _ = load_roformer_model(str(checkpoint), load_config(config_path))
    del model
    gc.collect()
    if not verified(converted, SAFETENSORS_SIZE, SAFETENSORS_SHA256):
        raise RuntimeError(f"MLX conversion did not create {converted}")
    return setup_result(cache_directory, converted=True)


def setup_result(cache_directory: Path, *, converted: bool) -> dict[str, Any]:
    checkpoint, config, safetensors = model_paths(cache_directory)
    return {
        "backend": "mlx",
        "cacheDirectory": str(cache_directory.resolve()),
        "checkpoint": artifact_result(checkpoint),
        "config": artifact_result(config),
        "converted": safetensors.is_file(),
        "convertedThisRun": converted,
        "model": MODEL_REPOSITORY,
        "modelLicense": MODEL_LICENSE,
        "revision": MODEL_REVISION,
        "safetensors": artifact_result(safetensors),
    }


def artifact_result(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    return {"path": str(path.resolve()), "size": path.stat().st_size}


def separator_for(
    checkpoint: Path,
    config_path: Path,
    output_directory: Path,
) -> Any:
    patch_skip_connected_mel_roformer()
    from mlx_audio_separator.separator.architectures.mdxc_separator import MDXCSeparator

    model_data = load_config(config_path)
    model_config = model_data["model"]
    inference_config = model_data["inference"]
    chunk_samples = model_config["stft_hop_length"] * (inference_config["dim_t"] - 1)
    overlap_seconds = (
        chunk_samples / inference_config.get("num_overlap", 4) / model_data["audio"]["sample_rate"]
    )
    common_config = {
        "amplification_threshold": 0.0,
        "invert_using_spec": False,
        "log_level": logging.INFO,
        "logger": logging.getLogger("music-stems-mlx"),
        "model_data": model_data,
        "model_name": "mel-band-roformer-4stem-ft-large",
        "model_path": str(checkpoint),
        "normalization_threshold": 1.0,
        "output_bitrate": None,
        "output_dir": str(output_directory),
        "output_format": "WAV",
        "output_single_stem": None,
        "performance_params": {
            "cache_clear_policy": "deferred",
            "speed_mode": "latency_safe",
            "write_workers": 1,
        },
        "sample_rate": SAMPLE_RATE,
    }
    return MDXCSeparator(
        common_config=common_config,
        arch_config={
            "batch_size": 1,
            "overlap": overlap_seconds,
            "override_model_segment_size": False,
            "pitch_shift": 0,
            "segment_size": 256,
        },
    )


def align_stem(stem: Any, mixture: Any) -> Any:
    import numpy as np

    stem = np.asarray(stem, dtype=np.float32)
    if stem.shape[-1] > mixture.shape[-1]:
        return stem[..., : mixture.shape[-1]]
    if stem.shape[-1] < mixture.shape[-1]:
        return np.pad(stem, ((0, 0), (0, mixture.shape[-1] - stem.shape[-1])))
    return stem


def output_sources(layout: str, mixture: Any, sources: dict[str, Any]) -> dict[str, Any]:
    import numpy as np

    aligned = {name: align_stem(value, mixture) for name, value in sources.items()}
    expected = {"bass", "drums", "other", "vocals"}
    if set(aligned) != expected:
        raise RuntimeError(f"Model returned unexpected stems: {sorted(aligned)}")
    if layout == "four-stem":
        return {name: aligned[name] for name in ("drums", "bass", "other", "vocals")}
    instrumental = aligned["bass"] + aligned["other"]
    vocals = aligned["vocals"]
    drums = np.asarray(mixture - instrumental - vocals, dtype=np.float32)
    return {"instrumental": instrumental, "vocals": vocals, "drums": drums}


def requested_stems(layout: str, stems: list[str] | None) -> tuple[str, ...]:
    available = LAYOUT_STEMS[layout]
    if not stems:
        return available
    selected = tuple(dict.fromkeys(stems))
    invalid = sorted(set(selected) - set(available))
    if invalid:
        raise ValueError(
            f"Stem(s) {', '.join(invalid)} are unavailable in {layout} layout; "
            f"choose from {', '.join(available)}"
        )
    return selected


def write_outputs(
    output_directory: Path,
    sources: dict[str, Any],
    *,
    force: bool,
) -> list[dict[str, Any]]:
    import mlx_audio_io as audio_io
    import numpy as np

    output_directory.mkdir(parents=True, exist_ok=True)
    destinations = {name: output_directory / f"{name}.wav" for name in sources}
    existing = [path for path in destinations.values() if path.exists()]
    if existing and not force:
        raise FileExistsError(f"Refusing to replace existing stem: {existing[0]}")

    staging = Path(tempfile.mkdtemp(prefix=".stems-", dir=output_directory))
    try:
        for name, source in sources.items():
            frames_channels = np.asarray(source, dtype=np.float32).T
            audio_io.save(
                str(staging / f"{name}.wav"),
                frames_channels,
                SAMPLE_RATE,
                encoding="float32",
            )
        for name, destination in destinations.items():
            os.replace(staging / f"{name}.wav", destination)
    finally:
        shutil.rmtree(staging, ignore_errors=True)

    return [
        {
            "channels": int(sources[name].shape[0]),
            "frames": int(sources[name].shape[-1]),
            "path": str(path.resolve()),
            "sha256": sha256_file(path),
            "size": path.stat().st_size,
            "stem": name,
        }
        for name, path in destinations.items()
    ]


def refuse_existing_outputs(
    output_directory: Path,
    layout: str,
    stems: list[str] | None,
    *,
    force: bool,
) -> None:
    if force:
        return
    names = requested_stems(layout, stems)
    existing = [output_directory / f"{name}.wav" for name in names]
    existing = [path for path in existing if path.exists()]
    if existing:
        raise FileExistsError(f"Refusing to replace existing stem: {existing[0]}")


def separate(
    audio_path: Path,
    output_directory: Path,
    cache_directory: Path,
    *,
    force: bool,
    layout: str,
    stems: list[str] | None,
) -> dict[str, Any]:
    require_apple_silicon()
    if not audio_path.is_file():
        raise FileNotFoundError(f"Audio file does not exist: {audio_path}")
    refuse_existing_outputs(output_directory, layout, stems, force=force)
    convert_model(cache_directory)
    checkpoint, config_path, _ = model_paths(cache_directory)

    started = time.perf_counter()
    separator = separator_for(checkpoint, config_path, output_directory)
    result = separate_loaded(
        separator,
        audio_path,
        output_directory,
        force=force,
        layout=layout,
        stems=stems,
    )
    result["processingSeconds"] = time.perf_counter() - started
    import mlx.core as mx

    del separator
    mx.clear_cache()
    gc.collect()
    return result


def separate_loaded(
    separator: Any,
    audio_path: Path,
    output_directory: Path,
    *,
    force: bool,
    layout: str,
    stems: list[str] | None,
) -> dict[str, Any]:
    import mlx.core as mx
    import numpy as np

    started = time.perf_counter()
    mixture = np.asarray(separator.prepare_mix(str(audio_path)), dtype=np.float32)
    sources = separator._demix_mlx(mixture)
    all_outputs = output_sources(layout, mixture, sources)
    reconstruction = sum(all_outputs.values())
    error = np.asarray(reconstruction - mixture, dtype=np.float64)
    selected_names = requested_stems(layout, stems)
    selected_outputs = {name: all_outputs[name] for name in selected_names}
    outputs = write_outputs(output_directory, selected_outputs, force=force)
    elapsed = time.perf_counter() - started
    del sources, all_outputs, selected_outputs
    return {
        "audioPath": str(audio_path.resolve()),
        "backend": "mlx",
        "device": str(mx.default_device()),
        "durationSeconds": mixture.shape[-1] / SAMPLE_RATE,
        "layout": layout,
        "model": MODEL_REPOSITORY,
        "modelRevision": MODEL_REVISION,
        "outputDirectory": str(output_directory.resolve()),
        "outputs": outputs,
        "processingSeconds": elapsed,
        "reconstruction": {
            "peakError": float(np.max(np.abs(error))),
            "rmsError": float(np.sqrt(np.mean(error * error))),
        },
        "sampleRate": SAMPLE_RATE,
        "selectedStems": list(selected_names),
    }


def separate_batch(
    request_path: Path,
    cache_directory: Path,
    *,
    force: bool,
    layout: str,
    stems: list[str] | None,
) -> dict[str, Any]:
    require_apple_silicon()
    payload = json.loads(request_path.read_text(encoding="utf-8"))
    if not isinstance(payload, list) or not payload:
        raise ValueError("Batch request must contain at least one job")

    jobs: list[tuple[Path, Path]] = []
    destinations: set[Path] = set()
    for index, job in enumerate(payload):
        if not isinstance(job, dict):
            raise ValueError(f"Batch job {index} must be an object")
        audio_path = Path(job.get("audioPath", ""))
        output_directory = Path(job.get("outputDirectory", ""))
        if not audio_path.is_file():
            raise FileNotFoundError(f"Audio file does not exist: {audio_path}")
        destination = output_directory.resolve()
        if destination in destinations:
            raise ValueError(f"Multiple batch jobs target {destination}")
        destinations.add(destination)
        refuse_existing_outputs(output_directory, layout, stems, force=force)
        jobs.append((audio_path, output_directory))

    convert_model(cache_directory)
    checkpoint, config_path, _ = model_paths(cache_directory)
    started = time.perf_counter()
    load_started = time.perf_counter()
    separator = separator_for(checkpoint, config_path, jobs[0][1])
    model_load_seconds = time.perf_counter() - load_started
    results = []
    try:
        for audio_path, output_directory in jobs:
            results.append(
                separate_loaded(
                    separator,
                    audio_path,
                    output_directory,
                    force=force,
                    layout=layout,
                    stems=stems,
                )
            )
    finally:
        import mlx.core as mx

        del separator
        mx.clear_cache()
        gc.collect()

    return {
        "backend": "mlx",
        "layout": layout,
        "model": MODEL_REPOSITORY,
        "modelLoadSeconds": model_load_seconds,
        "modelRevision": MODEL_REVISION,
        "processingSeconds": time.perf_counter() - started,
        "results": results,
        "selectedStems": list(requested_stems(layout, stems)),
        "trackCount": len(results),
    }


def doctor(cache_directory: Path) -> dict[str, Any]:
    require_apple_silicon()
    import mlx.core as mx

    checkpoint, config, converted = model_paths(cache_directory)
    return {
        "architecture": platform.machine(),
        "backend": "mlx",
        "cacheDirectory": str(cache_directory.resolve()),
        "checkpointReady": checkpoint.is_file(),
        "configReady": config.is_file(),
        "convertedReady": converted.is_file(),
        "device": str(mx.default_device()),
        "macOS": platform.mac_ver()[0],
        "mlxAudioSeparatorVersion": importlib.metadata.version("mlx-audio-separator"),
        "mlxVersion": importlib.metadata.version("mlx"),
        "model": MODEL_REPOSITORY,
        "modelRevision": MODEL_REVISION,
        "python": platform.python_version(),
        "pythonEnvironment": os.environ.get("VIRTUAL_ENV", ""),
    }


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    root.add_argument("--cache-directory", type=Path, default=default_cache_directory())
    commands = root.add_subparsers(dest="command", required=True)
    commands.add_parser("doctor")
    commands.add_parser("setup")
    separate_parser = commands.add_parser("separate")
    separate_parser.add_argument("audio_path", type=Path)
    separate_parser.add_argument("output_directory", type=Path)
    separate_parser.add_argument("--force", action="store_true")
    separate_parser.add_argument(
        "--layout", choices=("rekordbox", "four-stem"), default="rekordbox"
    )
    separate_parser.add_argument(
        "--stem", action="append", choices=sorted(set(sum(LAYOUT_STEMS.values(), ())))
    )
    batch_parser = commands.add_parser("batch")
    batch_parser.add_argument("request_path", type=Path)
    batch_parser.add_argument("--force", action="store_true")
    batch_parser.add_argument("--layout", choices=("rekordbox", "four-stem"), default="rekordbox")
    batch_parser.add_argument(
        "--stem", action="append", choices=sorted(set(sum(LAYOUT_STEMS.values(), ())))
    )
    return root


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="[stems] %(message)s", stream=sys.stderr)
    arguments = parser().parse_args()
    try:
        if arguments.command == "doctor":
            result = doctor(arguments.cache_directory)
        elif arguments.command == "setup":
            result = convert_model(arguments.cache_directory)
        elif arguments.command == "separate":
            result = separate(
                arguments.audio_path,
                arguments.output_directory,
                arguments.cache_directory,
                force=arguments.force,
                layout=arguments.layout,
                stems=arguments.stem,
            )
        else:
            result = separate_batch(
                arguments.request_path,
                arguments.cache_directory,
                force=arguments.force,
                layout=arguments.layout,
                stems=arguments.stem,
            )
        print(json.dumps(result, sort_keys=True))
        return 0
    except Exception as error:
        logging.error("%s: %s", type(error).__name__, error)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
