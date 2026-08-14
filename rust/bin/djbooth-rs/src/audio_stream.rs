use std::convert::Infallible;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use anyhow::{Context, Result, bail};
use bytes::Bytes;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::{broadcast, mpsc};
use tokio_stream::wrappers::ReceiverStream;

const PCM_BUFFER_CHUNKS: usize = 256;
const MP3_BUFFER_CHUNKS: usize = 64;

#[derive(Clone, Debug)]
pub(crate) struct PcmChunk {
    pub(crate) sample_rate: u32,
    pub(crate) bytes: Bytes,
}

#[derive(Clone, Debug)]
pub(crate) struct AudioStreamSource {
    inner: Arc<AudioStreamInner>,
}

#[derive(Debug)]
struct AudioStreamInner {
    connected: AtomicBool,
    sample_rate: AtomicU32,
    pcm: broadcast::Sender<PcmChunk>,
}

impl AudioStreamSource {
    pub(crate) fn new() -> Self {
        let (pcm, _) = broadcast::channel(PCM_BUFFER_CHUNKS);
        Self {
            inner: Arc::new(AudioStreamInner {
                connected: AtomicBool::new(false),
                sample_rate: AtomicU32::new(0),
                pcm,
            }),
        }
    }

    pub(crate) fn set_connected(&self, sample_rate: u32) {
        self.inner.sample_rate.store(sample_rate, Ordering::Release);
        self.inner.connected.store(true, Ordering::Release);
    }

    pub(crate) fn set_disconnected(&self) {
        self.inner.connected.store(false, Ordering::Release);
    }

    pub(crate) fn is_connected(&self) -> bool {
        self.inner.connected.load(Ordering::Acquire)
    }

    pub(crate) fn has_listeners(&self) -> bool {
        self.inner.pcm.receiver_count() > 0
    }

    pub(crate) fn publish(&self, bytes: Bytes) {
        if bytes.is_empty() || !self.is_connected() {
            return;
        }
        let sample_rate = self.inner.sample_rate.load(Ordering::Acquire);
        if sample_rate == 0 {
            return;
        }
        let _ = self.inner.pcm.send(PcmChunk { sample_rate, bytes });
    }

    fn subscribe(&self) -> Result<(u32, broadcast::Receiver<PcmChunk>)> {
        if !self.is_connected() {
            bail!("DJ mixer master audio is not connected");
        }
        let sample_rate = self.inner.sample_rate.load(Ordering::Acquire);
        if sample_rate == 0 {
            bail!("DJ mixer master audio sample rate is unavailable");
        }
        Ok((sample_rate, self.inner.pcm.subscribe()))
    }
}

pub(crate) fn open_live_mp3(
    source: &AudioStreamSource,
) -> Result<ReceiverStream<Result<Bytes, Infallible>>> {
    let (sample_rate, mut pcm) = source.subscribe()?;
    let mut child = Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "f32le",
            "-ar",
            &sample_rate.to_string(),
            "-ac",
            "2",
            "-i",
            "pipe:0",
            "-vn",
            "-codec:a",
            "libmp3lame",
            "-b:a",
            "320k",
            "-write_xing",
            "0",
            "-flush_packets",
            "1",
            "-f",
            "mp3",
            "pipe:1",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .context("start ffmpeg for the Sonos master stream")?;
    let mut stdin = child.stdin.take().context("open ffmpeg audio input")?;
    let mut stdout = child.stdout.take().context("open ffmpeg audio output")?;
    let (encoded, receiver) = mpsc::channel(MP3_BUFFER_CHUNKS);

    tokio::spawn(async move {
        let writer = tokio::spawn(async move {
            loop {
                match pcm.recv().await {
                    Ok(chunk) if chunk.sample_rate == sample_rate => {
                        if stdin.write_all(&chunk.bytes).await.is_err() {
                            break;
                        }
                    }
                    Ok(_) => break,
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        tracing::warn!(skipped, "sonos_pcm_stream_lagged");
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
        let reader = tokio::spawn(async move {
            let mut buffer = vec![0_u8; 32 * 1024];
            loop {
                match stdout.read(&mut buffer).await {
                    Ok(0) | Err(_) => break,
                    Ok(count) => {
                        if encoded
                            .send(Ok(Bytes::copy_from_slice(&buffer[..count])))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                }
            }
        });

        tokio::select! {
            _ = child.wait() => {}
            _ = writer => {}
            _ = reader => {}
        }
        let _ = child.kill().await;
    });

    Ok(ReceiverStream::new(receiver))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_requires_an_active_audio_device() {
        let source = AudioStreamSource::new();
        assert!(!source.is_connected());
        assert!(source.subscribe().is_err());
        source.set_connected(48_000);
        assert!(source.subscribe().is_ok());
        source.set_disconnected();
        assert!(source.subscribe().is_err());
    }
}
