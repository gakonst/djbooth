import unittest

import numpy as np

from a2sb_mlx import axial_pixel_frequencies, temporal_embedding
from djbooth_a2sb_mlx import (
    FFT_SIZE,
    SAMPLE_RATE,
    detect_bandwidth_cutoff,
    inverse_representation,
    mlx_key,
    stft_representation,
)


class A2SBMlxTest(unittest.TestCase):
    def test_release_weight_names_map_to_the_mlx_tree(self):
        self.assertEqual(
            mlx_key("enc_blocks.3.2.out_rest.2.weight"),
            "enc_blocks.3.layers.2.out_conv.weight",
        )
        self.assertEqual(
            mlx_key("middle_block.1.gnorm.weight"),
            "middle_block.layers.1.gnorm.norm.weight",
        )
        self.assertEqual(
            mlx_key("output_projection.0.bias"),
            "output_norm.norm.bias",
        )

    def test_temporal_embedding_matches_the_release_formula(self):
        actual = np.asarray(temporal_embedding(0.73))
        frequencies = np.linspace(0.5, 16.0, 64, dtype=np.float32)
        expected = np.concatenate((np.sin(0.73 * frequencies), np.cos(0.73 * frequencies)))[None, :]
        np.testing.assert_allclose(actual, expected, atol=2e-6, rtol=2e-6)

    def test_axial_rotary_pixel_coordinates_cover_both_axes(self):
        frequencies = np.asarray(axial_pixel_frequencies(3, 5))
        self.assertEqual(frequencies.shape, (3, 5, 64))
        np.testing.assert_allclose(
            frequencies[0, :, :32], np.broadcast_to(frequencies[0, 0, :32], (5, 32))
        )
        np.testing.assert_allclose(
            frequencies[:, 0, 32:], np.broadcast_to(frequencies[0, 0, 32:], (3, 32))
        )
        self.assertGreater(float(np.max(np.abs(frequencies))), 90)

    def test_stft_representation_round_trips_audio(self):
        time = np.arange(SAMPLE_RATE, dtype=np.float32) / SAMPLE_RATE
        waveform = np.stack(
            (0.2 * np.sin(2 * np.pi * 440 * time), 0.1 * np.sin(2 * np.pi * 997 * time))
        ).astype(np.float32)
        representation, _ = stft_representation(waveform)
        restored = inverse_representation(representation, waveform.shape[-1])
        error = restored - waveform
        snr = 10 * np.log10(np.mean(waveform**2) / np.mean(error**2))
        # A2SB intentionally drops DC and applies an epsilon-stabilized 1/4 power transform.
        self.assertGreater(snr, 45)

    def test_codec_edge_detector_finds_a_sharp_16khz_lowpass(self):
        representation = np.zeros((2, FFT_SIZE // 2, 64, 3), dtype=np.float32)
        cutoff_bin = int(FFT_SIZE * 16_000 / SAMPLE_RATE)
        representation[:, :cutoff_bin, :, 0] = 1
        representation[:, cutoff_bin:, :, 0] = 1e-4
        cutoff, _, method = detect_bandwidth_cutoff(representation)
        self.assertEqual(method, "codec-edge")
        self.assertLess(abs(cutoff - 16_000), 700)


if __name__ == "__main__":
    unittest.main()
