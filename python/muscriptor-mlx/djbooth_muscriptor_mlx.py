#!/usr/bin/env python3
"""MLX-native inference for the MuScriptor audio-to-MIDI model.

The architecture and event decoder are adapted from MuScriptor (MIT):
https://github.com/muscriptor/muscriptor
"""

from __future__ import annotations

import argparse
import json
import math
import platform
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np

MODEL_REPOSITORY = "MuScriptor/muscriptor-large"
MODEL_REVISION = "8809fdfbed2affa7ade94a7059e746e3880720e7"
MODEL_FILENAME = "model.safetensors"
MLX_MODEL_FILENAME = "model-mlx-fp16.safetensors"
MODEL_LICENSE = "CC-BY-NC-4.0"
SAMPLE_RATE = 16_000
SEGMENT_SECONDS = 5.0
SEGMENT_SAMPLES = int(SAMPLE_RATE * SEGMENT_SECONDS)
FRAME_RATE = 100
CARD = 1395
DIM = 1536
NUM_HEADS = 24
NUM_LAYERS = 48
HEAD_DIM = DIM // NUM_HEADS
MAX_GEN_LEN = 2000
INITIAL_TOKEN = CARD
EOS_TOKEN = 1
DRUM_PROGRAM = 128
MIN_NOTE_SECONDS = 0.01


INSTRUMENT_GROUPS: dict[str, tuple[int, tuple[int, ...]]] = {
    "acoustic_piano": (0, (0, 1, 3, 6, 7)),
    "electric_piano": (1, (2, 4, 5)),
    "chromatic_percussion": (2, tuple(range(8, 16))),
    "organ": (3, tuple(range(16, 24))),
    "acoustic_guitar": (4, (24, 25)),
    "clean_electric_guitar": (5, (26, 27, 28)),
    "distorted_electric_guitar": (6, (29, 30, 31)),
    "acoustic_bass": (7, (32, 35)),
    "electric_bass": (8, (33, 34, 36, 37, 38, 39)),
    "violin": (9, (40,)),
    "viola": (10, (41,)),
    "cello": (11, (42,)),
    "contrabass": (12, (43,)),
    "orchestral_harp": (13, (46,)),
    "timpani": (14, (47,)),
    "string_ensemble": (15, (48, 49, 44, 45)),
    "synth_strings": (16, (50, 51)),
    "voice": (17, (52, 53, 54)),
    "orchestra_hit": (18, (55,)),
    "trumpet": (19, (56, 59)),
    "trombone": (20, (57,)),
    "tuba": (21, (58,)),
    "french_horn": (22, (60,)),
    "brass_section": (23, (61, 62, 63)),
    "soprano_and_alto_sax": (24, (64, 65)),
    "tenor_sax": (25, (66,)),
    "baritone_sax": (26, (67,)),
    "oboe": (27, (68,)),
    "english_horn": (28, (69,)),
    "bassoon": (29, (70,)),
    "clarinet": (30, (71,)),
    "flutes": (31, tuple(range(72, 80))),
    "synth_lead": (32, tuple(range(80, 88))),
    "synth_pad": (33, tuple(range(88, 96))),
    "drums": (36, (DRUM_PROGRAM,)),
}
PROGRAM_NAMES = {
    programs[0]: name for name, (_, programs) in INSTRUMENT_GROUPS.items() if name != "drums"
}


@dataclass(frozen=True)
class Event:
    type: str
    value: int


@dataclass
class Note:
    program: int
    pitch: int
    onset: float
    offset: float
    is_drum: bool = False
    source_chunk: int = 0


def build_vocab() -> list[Event]:
    vocab = [Event("PAD", 0), Event("EOS", 0), Event("UNK", 0)]
    vocab.extend(Event("shift", value) for value in range(1001))
    vocab.extend(Event("pitch", value) for value in range(128))
    vocab.extend(Event("velocity", value) for value in range(2))
    vocab.append(Event("tie", 0))
    vocab.extend(Event("program", value) for value in range(130))
    vocab.extend(Event("drum", value) for value in range(128))
    return vocab


VOCAB = build_vocab()
TOKEN_INDEX = {(event.type, event.value): index for index, event in enumerate(VOCAB)}


def default_cache_directory() -> Path:
    return Path.home() / "Library" / "Caches" / "djbooth" / "muscriptor-mlx" / "large"


def require_apple_silicon() -> None:
    if sys.platform != "darwin" or platform.machine() != "arm64":
        raise RuntimeError("MuScriptor MLX requires macOS on Apple Silicon")


def setup_model(cache_directory: Path) -> Path:
    from huggingface_hub import hf_hub_download

    cache_directory.mkdir(parents=True, exist_ok=True)
    try:
        weights = Path(
            hf_hub_download(
                repo_id=MODEL_REPOSITORY,
                filename=MODEL_FILENAME,
                revision=MODEL_REVISION,
                local_dir=cache_directory,
            )
        )
        config = Path(
            hf_hub_download(
                repo_id=MODEL_REPOSITORY,
                filename="config.json",
                revision=MODEL_REVISION,
                local_dir=cache_directory,
            )
        )
    except Exception as error:
        raise RuntimeError(
            "MuScriptor-large is gated. Accept its terms at "
            "https://huggingface.co/MuScriptor/muscriptor-large and run `hf auth login`."
        ) from error

    mlx_weights, converted = convert_checkpoint(weights, cache_directory)
    manifest = {
        "backend": "mlx",
        "checkpoint": str(mlx_weights.resolve()),
        "config": json.loads(config.read_text(encoding="utf-8")),
        "converted": converted,
        "license": MODEL_LICENSE,
        "model": MODEL_REPOSITORY,
        "revision": MODEL_REVISION,
        "sourceCheckpoint": str(weights.resolve()),
        "sourceSize": weights.stat().st_size,
        "size": mlx_weights.stat().st_size,
    }
    (cache_directory / "mlx-import.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    return mlx_weights


def locate_weights(cache_directory: Path) -> Path:
    converted = cache_directory / MLX_MODEL_FILENAME
    if converted.is_file():
        return converted
    source = cache_directory / MODEL_FILENAME
    if source.is_file():
        return convert_checkpoint(source, cache_directory)[0]
    return setup_model(cache_directory)


def remap_weights(weights: dict[str, object]) -> dict[str, object]:
    result = {}
    for key, value in weights.items():
        if key.startswith("emb.0."):
            key = "emb." + key.removeprefix("emb.0.")
        elif key.startswith("linears.0."):
            key = "linear." + key.removeprefix("linears.0.")
        result[key] = value
    return result


def convert_checkpoint(source: Path, cache_directory: Path) -> tuple[Path, bool]:
    """Persist the same mixed precision used by MuScriptor's Apple backend."""
    import mlx.core as mx

    destination = cache_directory / MLX_MODEL_FILENAME
    if destination.is_file():
        return destination, False
    loaded = remap_weights(mx.load(str(source)))
    converted = {
        key: value.astype(mx.float32 if key.startswith("condition_provider.") else mx.float16)
        for key, value in loaded.items()
    }
    mx.eval(converted)
    temporary = destination.with_suffix(".incomplete.safetensors")
    mx.save_safetensors(
        temporary,
        converted,
        metadata={
            "backend": "mlx",
            "model": MODEL_REPOSITORY,
            "precision": "fp16-transformer-fp32-conditioners",
            "revision": MODEL_REVISION,
        },
    )
    temporary.replace(destination)
    return destination, True


class KVCache:
    def __init__(self, batch: int, max_length: int, dtype: object):
        import mlx.core as mx

        shape = (batch, NUM_HEADS, max_length, HEAD_DIM)
        self.keys = mx.zeros(shape, dtype=dtype)
        self.values = mx.zeros(shape, dtype=dtype)

    def update(self, keys: object, values: object, offset: int) -> tuple[object, object]:
        length = keys.shape[2]
        self.keys[:, :, offset : offset + length, :] = keys
        self.values[:, :, offset : offset + length, :] = values
        return (
            self.keys[:, :, : offset + length, :],
            self.values[:, :, : offset + length, :],
        )


class MuScriptorMLX:
    def __init__(self, weights_path: Path):
        import mlx.core as mx

        loaded = remap_weights(mx.load(str(weights_path)))
        self.weights = loaded
        required = {
            "emb.weight",
            "linear.weight",
            "out_norm.weight",
            "condition_provider.conditioners.self_wav.output_proj.weight",
            "condition_provider.conditioners.self_wav.mel_spec_transform.mel_scale.fb",
        }
        missing = sorted(required - loaded.keys())
        if missing:
            raise RuntimeError(f"Checkpoint is missing required tensors: {missing}")
        if loaded["emb.weight"].shape != (CARD + 1, DIM):
            raise RuntimeError(f"Not a MuScriptor-large checkpoint: {loaded['emb.weight'].shape}")
        self.dtype = loaded["emb.weight"].dtype
        mx.eval(self.weights)

    def weight(self, name: str) -> object:
        try:
            return self.weights[name]
        except KeyError as error:
            raise RuntimeError(f"Checkpoint tensor not found: {name}") from error

    @staticmethod
    def linear(x: object, weight: object, bias: object | None = None) -> object:
        output = x @ weight.T
        return output if bias is None else output + bias

    def layer_norm(self, x: object, prefix: str) -> object:
        import mlx.core as mx

        return mx.fast.layer_norm(
            x,
            self.weight(f"{prefix}.weight"),
            self.weight(f"{prefix}.bias"),
            1e-5,
        )

    @staticmethod
    def positional_embedding(offset: int, length: int) -> object:
        import mlx.core as mx

        positions = mx.arange(offset, offset + length, dtype=mx.float32).reshape(1, length, 1)
        dimensions = mx.arange(DIM // 2, dtype=mx.float32).reshape(1, 1, -1)
        phase = positions / (10_000.0 ** (dimensions / (DIM // 2 - 1)))
        return mx.concatenate([mx.cos(phase), mx.sin(phase)], axis=-1)

    def mel_condition(self, waveform: np.ndarray) -> object:
        import mlx.core as mx

        prefix = "condition_provider.conditioners.self_wav"
        window = np.asarray(
            self.weight(f"{prefix}.mel_spec_transform.spectrogram.window"), dtype=np.float32
        )
        filterbank = np.asarray(
            self.weight(f"{prefix}.mel_spec_transform.mel_scale.fb"), dtype=np.float32
        )
        padded = np.pad(waveform.astype(np.float32), (1024, 1024), mode="reflect")
        frames = np.lib.stride_tricks.sliding_window_view(padded, 2048)[::160]
        magnitude = np.abs(np.fft.rfft(frames * window, axis=-1)).astype(np.float32)
        mel = magnitude @ filterbank
        log_mel = np.log(mel + 1e-6, dtype=np.float32)[None, :, :]
        projection = self.weight(f"{prefix}.output_proj.weight")
        bias = self.weight(f"{prefix}.output_proj.bias")
        condition = self.linear(mx.array(log_mel), projection, bias)
        return condition.astype(self.dtype)

    def class_condition(self, name: str, values: list[int] | None) -> object:
        import mlx.core as mx

        # Upstream tokenization applies +1 before ClassConditioner applies +1.
        indices = [1] if values is None else [value + 2 for value in values]
        embedding = self.weight(f"condition_provider.conditioners.{name}.embed.weight")
        return embedding[mx.array(indices, dtype=mx.int32)][None, :, :].astype(self.dtype)

    def conditions(self, waveform: np.ndarray, instruments: list[str] | None) -> object:
        import mlx.core as mx

        group_ids = None
        if instruments:
            group_ids = [INSTRUMENT_GROUPS[name][0] for name in instruments]
        result = mx.concatenate(
            [
                self.mel_condition(waveform),
                self.class_condition("instrument_group", group_ids),
                self.class_condition("dataset_name", None),
            ],
            axis=1,
        )
        mx.eval(result)
        return result

    def transformer(
        self,
        x: object,
        caches: list[KVCache],
        offset: int,
    ) -> object:
        import mlx.core as mx

        batch, length, _ = x.shape
        x = x + self.positional_embedding(offset, length).astype(x.dtype)
        causal_mask = "causal" if length > 1 else None
        scale = HEAD_DIM**-0.5
        for layer_index, cache in enumerate(caches):
            prefix = f"transformer.layers.{layer_index}"
            normalized = self.layer_norm(x, f"{prefix}.norm1")
            packed = self.linear(normalized, self.weight(f"{prefix}.self_attn.in_proj_weight"))
            packed = packed.reshape(batch, length, 3, NUM_HEADS, HEAD_DIM)
            query = mx.transpose(packed[:, :, 0], (0, 2, 1, 3))
            keys = mx.transpose(packed[:, :, 1], (0, 2, 1, 3))
            values = mx.transpose(packed[:, :, 2], (0, 2, 1, 3))
            keys, values = cache.update(keys, values, offset)
            attended = mx.fast.scaled_dot_product_attention(
                query, keys, values, scale=scale, mask=causal_mask
            )
            attended = mx.transpose(attended, (0, 2, 1, 3)).reshape(batch, length, DIM)
            x = x + self.linear(attended, self.weight(f"{prefix}.self_attn.out_proj.weight"))
            normalized = self.layer_norm(x, f"{prefix}.norm2")
            hidden = self.linear(normalized, self.weight(f"{prefix}.linear1.weight"))
            hidden = 0.5 * hidden * (1.0 + mx.erf(hidden / math.sqrt(2.0)))
            x = x + self.linear(hidden, self.weight(f"{prefix}.linear2.weight"))
        return x

    def logits(
        self,
        token_ids: list[int],
        condition: object,
        caches: list[KVCache],
        offset: int,
        first_step: bool,
    ) -> object:
        import mlx.core as mx

        tokens = mx.array(token_ids, dtype=mx.int32)[None, :]
        x = self.weight("emb.weight")[tokens]
        if first_step:
            x = mx.concatenate([condition, x], axis=1)
        x = self.transformer(x, caches, offset)
        x = self.layer_norm(x, "out_norm")
        if first_step:
            x = x[:, -len(token_ids) :, :]
        return self.linear(x[:, -1:, :], self.weight("linear.weight"))[:, -1, :]

    def generate(
        self,
        waveform: np.ndarray,
        prompt: list[int],
        instruments: list[str] | None,
        max_gen_len: int = MAX_GEN_LEN,
    ) -> list[int]:
        import mlx.core as mx

        condition = self.conditions(waveform, instruments)
        initial = [INITIAL_TOKEN, *prompt]
        max_cache = condition.shape[1] + max_gen_len + 1
        caches = [KVCache(1, max_cache, self.dtype) for _ in range(NUM_LAYERS)]
        logits = self.logits(initial, condition, caches, 0, True)
        offset = condition.shape[1] + len(initial)
        output = list(prompt)
        forbidden = forbidden_token_ids(instruments)
        logit_mask = np.zeros(CARD, dtype=np.float32)
        logit_mask[1393:] = -np.inf
        logit_mask[forbidden] = -np.inf
        mask = mx.array(logit_mask)

        while len(output) < max_gen_len:
            token = int(mx.argmax(logits.astype(mx.float32) + mask, axis=-1).item())
            output.append(token)
            if token == EOS_TOKEN:
                break
            logits = self.logits([token], condition, caches, offset, False)
            offset += 1
            mx.eval(logits, [cache.keys for cache in caches], [cache.values for cache in caches])
        return output


def forbidden_token_ids(instruments: list[str] | None) -> list[int]:
    if not instruments:
        return []
    allowed_programs = {INSTRUMENT_GROUPS[name][1][0] for name in instruments if name != "drums"}
    allow_drums = "drums" in instruments
    return [
        token_id
        for token_id, event in enumerate(VOCAB)
        if (event.type == "program" and event.value not in allowed_programs)
        or (event.type == "drum" and not allow_drums)
    ]


class EventDecoder:
    def __init__(self) -> None:
        self.open: dict[tuple[int, int], tuple[float, int]] = {}
        self.notes: list[Note] = []
        self.seek_time = 0.0
        self.next_seek_time: float | None = None
        self.start_tick = 0
        self.tick = 0
        self.program: int | None = None
        self.velocity: int | None = None
        self.in_prologue = True
        self.tie_set: set[tuple[int, int]] = set()
        self.skip_rest = False
        self.started = False
        self.chunk_index = 0

    def close(self, key: tuple[int, int], when: float) -> None:
        onset, source_chunk = self.open.pop(key)
        self.notes.append(
            Note(
                key[0],
                key[1],
                onset,
                max(when, onset + MIN_NOTE_SECONDS),
                source_chunk=source_chunk,
            )
        )

    def start_chunk(
        self, seek_time: float, next_seek_time: float | None, chunk_index: int = 0
    ) -> None:
        if self.started and self.in_prologue:
            for key in list(self.open):
                self.close(key, self.seek_time)
        self.seek_time = seek_time
        self.next_seek_time = next_seek_time
        self.start_tick = round(seek_time * FRAME_RATE)
        self.tick = self.start_tick
        self.program = None
        self.velocity = None
        self.in_prologue = True
        self.tie_set = set()
        self.skip_rest = False
        self.started = True
        self.chunk_index = chunk_index

    def feed(self, token: int) -> None:
        event = VOCAB[token]
        if self.in_prologue:
            if event.type == "tie":
                self.in_prologue = False
                for key in [key for key in self.open if key not in self.tie_set]:
                    self.close(key, self.seek_time)
            elif event.type == "shift":
                self.in_prologue = False
                self.skip_rest = True
                for key in list(self.open):
                    self.close(key, self.seek_time)
            elif event.type == "program":
                self.program = event.value
            elif event.type == "pitch" and self.program is not None:
                self.tie_set.add((self.program, event.value))
            return
        if self.skip_rest:
            return
        if event.type == "shift" and event.value > 0:
            self.tick = self.start_tick + event.value
        elif event.type == "program":
            self.program = event.value
        elif event.type == "velocity":
            self.velocity = event.value
        elif event.type == "drum":
            when = self.tick / FRAME_RATE
            if self.next_seek_time is None or when < self.next_seek_time:
                self.notes.append(
                    Note(
                        DRUM_PROGRAM,
                        event.value,
                        when,
                        when + MIN_NOTE_SECONDS,
                        True,
                        self.chunk_index,
                    )
                )
        elif event.type == "pitch" and self.program is not None and self.velocity is not None:
            when = self.tick / FRAME_RATE
            if self.next_seek_time is not None and when >= self.next_seek_time:
                return
            key = (self.program, event.value)
            if key in self.open:
                self.close(key, when)
            if self.velocity > 0:
                self.open[key] = (when, self.chunk_index)

    def tie_prompt(self) -> list[int]:
        result = []
        current_program = None
        for program, pitch in sorted(self.open):
            if program != current_program:
                result.append(TOKEN_INDEX[("program", program)])
                current_program = program
            result.append(TOKEN_INDEX[("pitch", pitch)])
        result.append(TOKEN_INDEX[("tie", 0)])
        return result

    def finish(self) -> list[Note]:
        if self.started and self.in_prologue:
            for key in list(self.open):
                self.close(key, self.seek_time)
        else:
            for key, (onset, _) in list(self.open.items()):
                self.close(key, onset + MIN_NOTE_SECONDS)
        return sorted(self.notes, key=lambda note: (note.onset, note.program, note.pitch))


def load_audio(path: Path, start: float = 0.0, duration: float | None = None) -> np.ndarray:
    import soundfile as sf
    from scipy.signal import resample_poly

    info = sf.info(path)
    start_frame = round(start * info.samplerate)
    frames = -1 if duration is None else round(duration * info.samplerate)
    audio, sample_rate = sf.read(path, start=start_frame, frames=frames, dtype="float32")
    if audio.ndim == 2:
        audio = audio.mean(axis=1)
    if sample_rate != SAMPLE_RATE:
        divisor = math.gcd(sample_rate, SAMPLE_RATE)
        audio = resample_poly(audio, SAMPLE_RATE // divisor, sample_rate // divisor)
    return np.asarray(audio, dtype=np.float32)


def validate_instruments(instruments: list[str] | None) -> list[str] | None:
    if not instruments:
        return None
    unknown = sorted(set(instruments) - INSTRUMENT_GROUPS.keys())
    if unknown:
        raise ValueError(
            f"Unknown instruments: {', '.join(unknown)}. Choose from {', '.join(INSTRUMENT_GROUPS)}"
        )
    return list(dict.fromkeys(instruments))


def write_midi(notes: list[Note], output: Path, tempo_bpm: float = 120.0) -> None:
    from mido import Message, MetaMessage, MidiFile, MidiTrack, second2tick

    tempo = round(60_000_000 / tempo_bpm)
    ticks_per_beat = 480
    midi = MidiFile(type=1, ticks_per_beat=ticks_per_beat)
    conductor = MidiTrack()
    conductor.append(MetaMessage("set_tempo", tempo=tempo, time=0))
    midi.tracks.append(conductor)
    groups: dict[int, list[Note]] = {}
    for note in notes:
        groups.setdefault(note.program, []).append(note)
    channels = iter([*range(9), *range(10, 16)])
    for program, program_notes in groups.items():
        is_drum = program == DRUM_PROGRAM
        channel = 9 if is_drum else next(channels, 15)
        track = MidiTrack()
        name = "drums" if is_drum else PROGRAM_NAMES.get(program, f"program_{program}")
        track.append(MetaMessage("track_name", name=name, time=0))
        track.append(Message("program_change", program=0 if is_drum else program, channel=channel))
        events = []
        for note in program_notes:
            events.append((note.onset, True, note.pitch))
            events.append((note.offset, False, note.pitch))
        events.sort(key=lambda item: (item[0], item[1]))
        previous_tick = 0
        for event_time, is_on, pitch in events:
            tick = round(second2tick(event_time, ticks_per_beat, tempo))
            track.append(
                Message(
                    "note_on" if is_on else "note_off",
                    note=pitch,
                    velocity=100 if is_on else 0,
                    channel=channel,
                    time=max(0, tick - previous_tick),
                )
            )
            previous_tick = tick
        midi.tracks.append(track)
    output.parent.mkdir(parents=True, exist_ok=True)
    midi.save(output)


def instrument_name(note: Note) -> str:
    if note.is_drum:
        return "drums"
    return PROGRAM_NAMES.get(note.program, f"program_{note.program}")


def max_polyphony(notes: list[Note]) -> int:
    events = []
    for note in notes:
        events.append((note.onset, 1))
        events.append((note.offset, -1))
    active = 0
    maximum = 0
    for _, delta in sorted(events, key=lambda item: (item[0], item[1])):
        active += delta
        maximum = max(maximum, active)
    return maximum


def write_events(
    notes: list[Note],
    output: Path,
    *,
    source: Path,
    start: float,
    duration: float,
    tempo_bpm: float,
    chunks: list[dict[str, object]] | None = None,
) -> None:
    chunks = chunks or []
    untrusted_chunks = {int(chunk["index"]) for chunk in chunks if bool(chunk.get("suspicious"))}
    trusted_notes = [note for note in notes if note.source_chunk not in untrusted_chunks]
    grouped: dict[str, list[Note]] = {}
    for note in trusted_notes:
        grouped.setdefault(instrument_name(note), []).append(note)
    seconds_per_beat = 60.0 / tempo_bpm
    tracks = []
    for name, track_notes in grouped.items():
        pitches = np.asarray([note.pitch for note in track_notes])
        durations = np.asarray([note.offset - note.onset for note in track_notes])
        onsets = np.asarray(sorted({note.onset for note in track_notes}))
        intervals = np.diff(onsets)
        tracks.append(
            {
                "name": name,
                "notes": len(track_notes),
                "densityPerSecond": len(track_notes) / max(duration, 1e-9),
                "pitchMin": int(pitches.min()),
                "pitchMax": int(pitches.max()),
                "pitchMedian": float(np.median(pitches)),
                "durationMedianSeconds": float(np.median(durations)),
                "interOnsetMedianSeconds": float(np.median(intervals)) if len(intervals) else None,
                "maxPolyphony": max_polyphony(track_notes),
            }
        )
    payload = {
        "schemaVersion": 2,
        "backend": "mlx",
        "model": MODEL_REPOSITORY,
        "source": str(source.resolve()),
        "startSeconds": start,
        "durationSeconds": duration,
        "tempoBpm": tempo_bpm,
        "chunks": chunks,
        "rawNoteCount": len(notes),
        "trustedNoteCount": len(trusted_notes),
        "tracks": sorted(tracks, key=lambda track: track["name"]),
        "notes": [
            {
                "instrument": instrument_name(note),
                "program": note.program,
                "pitch": note.pitch,
                "onsetSeconds": note.onset,
                "offsetSeconds": note.offset,
                "durationSeconds": note.offset - note.onset,
                "onsetBeats": (note.onset - start) / seconds_per_beat,
                "durationBeats": (note.offset - note.onset) / seconds_per_beat,
                "isDrum": note.is_drum,
                "sourceChunk": note.source_chunk,
                "trusted": note.source_chunk not in untrusted_chunks,
            }
            for note in notes
        ],
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def transcribe(args: argparse.Namespace) -> dict[str, object]:
    require_apple_silicon()
    instruments = validate_instruments(args.instrument)
    weights = locate_weights(args.cache_directory)
    started = time.perf_counter()
    model = MuScriptorMLX(weights)
    audio = load_audio(args.input, args.start, args.duration)
    decoder = EventDecoder()
    chunk_count = math.ceil(len(audio) / SEGMENT_SAMPLES)
    generation_seconds = 0.0
    chunks = []
    for chunk_index in range(chunk_count):
        chunk_start = chunk_index * SEGMENT_SAMPLES
        chunk = audio[chunk_start : chunk_start + SEGMENT_SAMPLES]
        if len(chunk) < SEGMENT_SAMPLES:
            chunk = np.pad(chunk, (0, SEGMENT_SAMPLES - len(chunk)))
        seek_time = args.start + chunk_index * SEGMENT_SECONDS
        next_time = seek_time + SEGMENT_SECONDS if chunk_index + 1 < chunk_count else None
        decoder.start_chunk(seek_time, next_time, chunk_index)
        prompt = decoder.tie_prompt() if chunk_index else []
        chunk_started = time.perf_counter()
        tokens = model.generate(chunk, prompt, instruments, args.max_tokens)
        generation_seconds += time.perf_counter() - chunk_started
        emitted_eos = bool(tokens) and tokens[-1] == EOS_TOKEN
        suspicious = (not emitted_eos and len(tokens) >= args.max_tokens) or len(tokens) > 400
        chunks.append(
            {
                "index": chunk_index,
                "startSeconds": seek_time,
                "tokenCount": len(tokens),
                "promptTokenCount": len(prompt),
                "emittedEos": emitted_eos,
                "suspicious": suspicious,
            }
        )
        for token in tokens:
            if token == EOS_TOKEN:
                break
            decoder.feed(token)
        print(
            f"[muscriptor-mlx] chunk {chunk_index + 1}/{chunk_count}: {len(tokens)} tokens",
            file=sys.stderr,
        )
    notes = decoder.finish()
    suspicious_chunks = {chunk["index"] for chunk in chunks if chunk["suspicious"]}
    trusted_notes = [note for note in notes if note.source_chunk not in suspicious_chunks]
    write_midi(trusted_notes, args.output, args.tempo)
    events_output = args.events or args.output.with_suffix(".events.json")
    write_events(
        notes,
        events_output,
        source=args.input,
        start=args.start,
        duration=len(audio) / SAMPLE_RATE,
        tempo_bpm=args.tempo,
        chunks=chunks,
    )
    result = {
        "audioSeconds": len(audio) / SAMPLE_RATE,
        "backend": "mlx",
        "chunks": chunk_count,
        "generationSeconds": generation_seconds,
        "instruments": instruments,
        "events": str(events_output.resolve()),
        "model": MODEL_REPOSITORY,
        "notes": len(trusted_notes),
        "rawNotes": len(notes),
        "output": str(args.output.resolve()),
        "realtimeFactor": generation_seconds / max(len(audio) / SAMPLE_RATE, 1e-9),
        "totalSeconds": time.perf_counter() - started,
    }
    print(json.dumps(result, indent=2))
    return result


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    root.set_defaults(cache_directory=default_cache_directory())
    subcommands = root.add_subparsers(dest="command", required=True)
    setup = subcommands.add_parser("setup", help="download and register MuScriptor-large")
    setup.add_argument("--cache-directory", type=Path, default=default_cache_directory())
    transcribe_parser = subcommands.add_parser("transcribe", help="transcribe audio to MIDI")
    transcribe_parser.add_argument("input", type=Path)
    transcribe_parser.add_argument("--output", "-o", type=Path, required=True)
    transcribe_parser.add_argument(
        "--cache-directory", type=Path, default=default_cache_directory()
    )
    transcribe_parser.add_argument("--start", type=float, default=0.0)
    transcribe_parser.add_argument("--duration", type=float)
    transcribe_parser.add_argument("--events", type=Path)
    transcribe_parser.add_argument("--instrument", action="append")
    transcribe_parser.add_argument("--max-tokens", type=int, default=MAX_GEN_LEN)
    transcribe_parser.add_argument("--tempo", type=float, default=120.0)
    return root


def main() -> None:
    args = parser().parse_args()
    if args.command == "setup":
        weights = setup_model(args.cache_directory)
        print(
            json.dumps(
                {
                    "backend": "mlx",
                    "checkpoint": str(weights.resolve()),
                    "model": MODEL_REPOSITORY,
                    "size": weights.stat().st_size,
                },
                indent=2,
            )
        )
    else:
        transcribe(args)


if __name__ == "__main__":
    main()
