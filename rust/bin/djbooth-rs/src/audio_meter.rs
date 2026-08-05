use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Sample as _, SampleFormat, Stream};
use tokio::sync::mpsc;

const PUBLISH_INTERVAL: Duration = Duration::from_millis(33);
const SILENCE_DBFS: f64 = -120.0;

#[derive(Clone, Debug)]
pub(crate) struct MeterFrame {
    pub(crate) pairs: Vec<StereoMeter>,
}

#[derive(Clone, Debug)]
pub(crate) struct StereoMeter {
    pub(crate) pair: u8,
    pub(crate) left_channel: u8,
    pub(crate) right_channel: u8,
    pub(crate) peak_dbfs: f64,
    pub(crate) rms_dbfs: f64,
    pub(crate) left_peak_dbfs: f64,
    pub(crate) right_peak_dbfs: f64,
    pub(crate) left_rms_dbfs: f64,
    pub(crate) right_rms_dbfs: f64,
}

pub(crate) fn connect_audio_meter(
    selector: &str,
) -> Result<(Stream, mpsc::UnboundedReceiver<MeterFrame>, String)> {
    let host = cpal::default_host();
    let selector_lower = selector.to_ascii_lowercase();
    let mut selected = None;
    for device in host.input_devices().context("list audio input devices")? {
        let description = device
            .description()
            .context("read audio device description")?;
        let name = description.name().to_string();
        if name.to_ascii_lowercase().contains(&selector_lower) {
            selected = Some((device, name));
            break;
        }
    }
    let Some((device, name)) = selected else {
        bail!("no audio input device matched '{selector}'");
    };
    let supported = device
        .default_input_config()
        .with_context(|| format!("read default input config for '{name}'"))?;
    let channels = supported.channels() as usize;
    if channels < 2 {
        bail!("audio input '{name}' exposes only {channels} channel(s)");
    }
    let config = supported.config();
    let (tx, rx) = mpsc::unbounded_channel();
    let stream = match supported.sample_format() {
        SampleFormat::F32 => {
            let error_name = name.clone();
            device.build_input_stream(
                config,
                meter_callback::<f32>(channels, tx),
                move |error| {
                    tracing::warn!(device = %error_name, %error, "audio_meter_stream_error");
                },
                None,
            )
        }
        SampleFormat::I16 => {
            let error_name = name.clone();
            device.build_input_stream(
                config,
                meter_callback::<i16>(channels, tx),
                move |error| {
                    tracing::warn!(device = %error_name, %error, "audio_meter_stream_error");
                },
                None,
            )
        }
        SampleFormat::U16 => {
            let error_name = name.clone();
            device.build_input_stream(
                config,
                meter_callback::<u16>(channels, tx),
                move |error| {
                    tracing::warn!(device = %error_name, %error, "audio_meter_stream_error");
                },
                None,
            )
        }
        format => bail!("unsupported audio sample format {format:?} for '{name}'"),
    }
    .with_context(|| format!("build audio meter stream for '{name}'"))?;
    stream
        .play()
        .with_context(|| format!("start audio meter stream for '{name}'"))?;
    tracing::info!(
        device = %name,
        channels,
        sample_rate = config.sample_rate,
        "audio_meter_connected"
    );
    Ok((stream, rx, name))
}

fn meter_callback<T>(
    channels: usize,
    tx: mpsc::UnboundedSender<MeterFrame>,
) -> impl FnMut(&[T], &cpal::InputCallbackInfo) + Send + 'static
where
    T: cpal::Sample + Send + 'static,
    f32: cpal::FromSample<T>,
{
    let mut peaks = vec![0.0f32; channels];
    let mut square_sums = vec![0.0f64; channels];
    let mut samples_per_channel = 0u64;
    let mut last_publish = Instant::now();
    move |data, _| {
        for frame in data.chunks_exact(channels) {
            for (channel, sample) in frame.iter().enumerate() {
                let value = f32::from_sample(*sample).clamp(-1.0, 1.0);
                peaks[channel] = peaks[channel].max(value.abs());
                square_sums[channel] += f64::from(value) * f64::from(value);
            }
            samples_per_channel += 1;
        }
        if last_publish.elapsed() < PUBLISH_INTERVAL || samples_per_channel == 0 {
            return;
        }
        let mut pairs = Vec::with_capacity(channels / 2);
        for pair_index in 0..channels / 2 {
            let left = pair_index * 2;
            let right = left + 1;
            let peak = peaks[left].max(peaks[right]);
            let left_mean_square = square_sums[left] / samples_per_channel as f64;
            let right_mean_square = square_sums[right] / samples_per_channel as f64;
            let mean_square =
                (square_sums[left] + square_sums[right]) / (2.0 * samples_per_channel as f64);
            pairs.push(StereoMeter {
                pair: pair_index as u8 + 1,
                left_channel: left as u8 + 1,
                right_channel: right as u8 + 1,
                peak_dbfs: amplitude_dbfs(f64::from(peak)),
                rms_dbfs: amplitude_dbfs(mean_square.sqrt()),
                left_peak_dbfs: amplitude_dbfs(f64::from(peaks[left])),
                right_peak_dbfs: amplitude_dbfs(f64::from(peaks[right])),
                left_rms_dbfs: amplitude_dbfs(left_mean_square.sqrt()),
                right_rms_dbfs: amplitude_dbfs(right_mean_square.sqrt()),
            });
        }
        peaks.fill(0.0);
        square_sums.fill(0.0);
        samples_per_channel = 0;
        last_publish = Instant::now();
        let _ = tx.send(MeterFrame { pairs });
    }
}

fn amplitude_dbfs(amplitude: f64) -> f64 {
    if amplitude <= 0.0 {
        SILENCE_DBFS
    } else {
        (20.0 * amplitude.log10()).max(SILENCE_DBFS)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_amplitude_to_dbfs() {
        assert!((amplitude_dbfs(1.0) - 0.0).abs() < 1e-9);
        assert!((amplitude_dbfs(0.5) + 6.020_599_913).abs() < 1e-6);
        assert_eq!(amplitude_dbfs(0.0), SILENCE_DBFS);
    }
}
