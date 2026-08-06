import json
import tempfile
import unittest
from pathlib import Path

from djbooth_muscriptor_mlx import (
    CARD,
    TOKEN_INDEX,
    VOCAB,
    EventDecoder,
    Note,
    forbidden_token_ids,
    write_events,
    write_midi,
)


class MuScriptorMLXTest(unittest.TestCase):
    def test_vocabulary_preserves_two_reserved_model_outputs(self) -> None:
        self.assertEqual(len(VOCAB), 1393)
        self.assertEqual(CARD, len(VOCAB) + 2)
        self.assertEqual(TOKEN_INDEX[("tie", 0)], 1134)

    def test_instrument_constraint_masks_other_programs_and_drums(self) -> None:
        forbidden = set(forbidden_token_ids(["electric_bass"]))
        self.assertNotIn(TOKEN_INDEX[("program", 33)], forbidden)
        self.assertIn(TOKEN_INDEX[("program", 32)], forbidden)
        self.assertIn(TOKEN_INDEX[("drum", 36)], forbidden)

    def test_decoder_reconstructs_tonal_note_and_drum_hit(self) -> None:
        decoder = EventDecoder()
        decoder.start_chunk(0.0, None)
        for event in [
            ("tie", 0),
            ("shift", 10),
            ("program", 33),
            ("velocity", 1),
            ("pitch", 36),
            ("drum", 36),
            ("shift", 30),
            ("velocity", 0),
            ("pitch", 36),
        ]:
            decoder.feed(TOKEN_INDEX[event])
        notes = decoder.finish()
        self.assertEqual(len(notes), 2)
        self.assertEqual((notes[0].program, notes[0].onset, notes[0].offset), (33, 0.1, 0.3))
        self.assertTrue(notes[1].is_drum)

    def test_writes_multitrack_midi_and_structured_events(self) -> None:
        notes = [
            Note(program=33, pitch=36, onset=0.0, offset=0.5),
            Note(program=128, pitch=36, onset=0.0, offset=0.01, is_drum=True),
        ]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            midi = root / "notes.mid"
            events = root / "notes.json"
            write_midi(notes, midi, 120.0)
            write_events(
                notes,
                events,
                source=root / "source.wav",
                start=0.0,
                duration=1.0,
                tempo_bpm=120.0,
            )
            payload = json.loads(events.read_text())
            self.assertGreater(midi.stat().st_size, 0)
            self.assertEqual(payload["schemaVersion"], 2)
            self.assertEqual(
                {track["name"] for track in payload["tracks"]}, {"drums", "electric_bass"}
            )


if __name__ == "__main__":
    unittest.main()
