//! Optional, bounded app diagnostics. Socket taps observe bytes; they never
//! implement, alter, retry, or delay the DJ Link protocol.
use serde_json::{Value, json};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    net::SocketAddr,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    task::{Context, Poll},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::TcpStream,
};

const MIB: u64 = 1024 * 1024;
const SEGMENTS: usize = 4;
const SESSIONS: usize = 4;
static ACTIVE: OnceLock<Recorder> = OnceLock::new();
static CONNECTION: AtomicU64 = AtomicU64::new(1);

struct Recorder {
    sender: mpsc::SyncSender<Message>,
    dropped: Arc<AtomicU64>,
    failures: Arc<AtomicU64>,
    directory: PathBuf,
    started: Instant,
}
enum Message {
    Record {
        lane: &'static str,
        at: u128,
        elapsed_us: u128,
        value: Value,
    },
    Bytes {
        at: u128,
        elapsed_us: u128,
        transport: &'static str,
        direction: &'static str,
        local: SocketAddr,
        peer: SocketAddr,
        connection: u64,
        bytes: Vec<u8>,
    },
    Metric {
        at: u128,
        elapsed_us: u128,
        value: Value,
        reply: mpsc::Sender<Result<(), String>>,
    },
    Flush(mpsc::Sender<()>),
}
fn timestamp() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

/// Each lane retains at most four files; a crash leaves complete prior JSONL
/// rows readable. Rotation is done only on the dedicated writer thread.
struct RollingFile {
    directory: PathBuf,
    lane: &'static str,
    file: File,
    size: u64,
    limit: u64,
}
impl RollingFile {
    fn new(directory: &Path, lane: &'static str, limit: u64) -> io::Result<Self> {
        let path = directory.join(format!("{lane}.jsonl"));
        let file = OpenOptions::new().create(true).append(true).open(path)?;
        let size = file.metadata()?.len();
        Ok(Self {
            directory: directory.into(),
            lane,
            file,
            size,
            limit,
        })
    }
    fn path(&self, index: usize) -> PathBuf {
        self.directory.join(if index == 0 {
            format!("{}.jsonl", self.lane)
        } else {
            format!("{}.{index}.jsonl", self.lane)
        })
    }
    fn row(&mut self, value: &Value) -> io::Result<()> {
        let mut bytes = serde_json::to_vec(value)?;
        bytes.push(b'\n');
        if bytes.len() as u64 > self.limit {
            return Err(io::Error::other("diagnostic record exceeds lane limit"));
        }
        if self.size + bytes.len() as u64 > self.limit {
            self.file.sync_data()?;
            for index in (1..SEGMENTS).rev() {
                match fs::rename(self.path(index - 1), self.path(index)) {
                    Ok(()) => {}
                    Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e),
                }
            }
            self.file = File::create(self.path(0))?;
            self.size = 0;
        }
        self.file.write_all(&bytes)?;
        self.size += bytes.len() as u64;
        Ok(())
    }
}
fn prune_sessions(root: &Path) -> io::Result<()> {
    let mut sessions = fs::read_dir(root)?
        .filter_map(Result::ok)
        .filter(|e| {
            e.file_type().is_ok_and(|t| t.is_dir())
                && e.file_name().to_string_lossy().starts_with("session-")
        })
        .collect::<Vec<_>>();
    sessions.sort_by_key(|e| e.file_name());
    let remove = sessions.len().saturating_sub(SESSIONS - 1);
    for entry in sessions.into_iter().take(remove) {
        fs::remove_dir_all(entry.path())?;
    }
    Ok(())
}

pub fn initialized() -> bool {
    ACTIVE.get().is_some()
}

/// Initialize once at app launch, before any server starts. Metadata must not
/// contain account credentials. Files live outside the purgeable temp directory.
pub fn initialize(root: &Path, session: &str, metadata: Value) -> anyhow::Result<Value> {
    if ACTIVE.get().is_some() {
        return Ok(status());
    }
    anyhow::ensure!(root.is_absolute(), "Diagnostics root must be absolute");
    anyhow::ensure!(
        !session.is_empty()
            && session.len() <= 64
            && session
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-'),
        "Invalid diagnostics session ID"
    );
    fs::create_dir_all(root)?;
    prune_sessions(root)?;
    let directory = root.join(format!("session-{}-{session}", timestamp()));
    fs::create_dir(&directory)?;
    fs::write(
        directory.join("manifest.json"),
        serde_json::to_vec_pretty(&json!({
            "schema":1, "session":session, "created_ms":timestamp(), "build":metadata,
            "capture":"application socket payloads; TCP chunks are not wire segments; no OS headers/retransmissions",
            "retention":{"sessions":SESSIONS,"segments_per_lane":SEGMENTS,"timeline_segment_bytes":2*MIB,"transport_segment_bytes":4*MIB,"metrics_segment_bytes":2*MIB},
        }))?,
    )?;
    let mut timeline = RollingFile::new(&directory, "timeline", 2 * MIB)?;
    let mut transport = RollingFile::new(&directory, "transport", 4 * MIB)?;
    let mut metrics = RollingFile::new(&directory, "metrics", 2 * MIB)?;
    let (sender, receiver) = mpsc::sync_channel(256);
    let dropped = Arc::new(AtomicU64::new(0));
    let failures = Arc::new(AtomicU64::new(0));
    let recorder = Recorder {
        sender,
        dropped: dropped.clone(),
        failures: failures.clone(),
        directory,
        started: Instant::now(),
    };
    std::thread::Builder::new().name("djlink-diagnostics".into()).spawn(move || {
        let mut last_counts = (0, 0);
        loop {
            let result = match receiver.recv_timeout(Duration::from_secs(1)) {
                Ok(Message::Record { lane, at, elapsed_us, value }) => {
                    let file = if lane == "metrics" { &mut metrics } else { &mut timeline };
                    file.row(&json!({"time_ms":at,"elapsed_us":elapsed_us,"data":value}))
                },
                Ok(Message::Bytes { at, elapsed_us, transport: protocol, direction, local, peer, connection, bytes }) => {
                    use std::fmt::Write;
                    let mut hex = String::with_capacity(bytes.len()*2);
                    for b in &bytes { let _ = write!(hex,"{b:02x}"); }
                    transport.row(&json!({"time_ms":at,"elapsed_us":elapsed_us,"protocol":protocol,"direction":direction,"local":local.to_string(),"peer":peer.to_string(),"connection":connection,"length":bytes.len(),"hex":hex}))
                },
                Ok(Message::Metric { at, elapsed_us, value, reply }) => {
                    let result = metrics.row(&json!({"time_ms":at,"elapsed_us":elapsed_us,"data":value})).and_then(|_| metrics.file.sync_data());
                    let _ = reply.send(result.as_ref().map(|_| ()).map_err(ToString::to_string));
                    result
                },
                Ok(Message::Flush(reply)) => {
                    for file in [&timeline, &transport, &metrics] { if file.file.sync_data().is_err() { failures.fetch_add(1, Ordering::Relaxed); } }
                    let _ = reply.send(()); Ok(())
                },
                Err(mpsc::RecvTimeoutError::Timeout) => Ok(()),
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            };
            if result.is_err() { failures.fetch_add(1, Ordering::Relaxed); }
            let counts = (dropped.load(Ordering::Relaxed), failures.load(Ordering::Relaxed));
            if counts != last_counts {
                let _ = timeline.row(&json!({"time_ms":timestamp(),"data":{"event":"diagnostics_loss","queue_drops":counts.0,"write_failures":counts.1}}));
                last_counts = counts;
            }
        }
    })?;
    // Publish only after the writer exists, so a spawn failure remains retryable.
    // App launch serializes initialization. Refuse an unexpected second owner.
    anyhow::ensure!(
        ACTIVE.set(recorder).is_ok(),
        "Diagnostics already initialized"
    );
    // All shared Rust tracing and Swift events enter this same bounded writer.
    let tracing = tracing_subscriber::fmt()
        .with_env_filter("warn,djtools_link=debug,djtools_link::db=trace,djtools_link::rpc=trace")
        .with_ansi(false)
        .with_thread_ids(true)
        .with_target(true)
        .with_writer(TimelineWriter)
        .try_init()
        .is_ok();
    event(
        "diagnostics_started",
        json!({"rust_tracing_attached":tracing}),
    );
    Ok(status())
}
fn submit(make: impl FnOnce(&Recorder) -> Message) {
    if let Some(recorder) = ACTIVE.get()
        && recorder.sender.try_send(make(recorder)).is_err()
    {
        recorder.dropped.fetch_add(1, Ordering::Relaxed);
    }
}
pub fn event(name: &str, fields: Value) {
    submit(|r| Message::Record {
        lane: "timeline",
        at: timestamp(),
        elapsed_us: r.started.elapsed().as_micros(),
        value: json!({"event":name,"fields":fields}),
    });
}
/// Called on the Apple diagnostics queue, never an audio/network/UI thread.
/// Acknowledge durable persistence rather than silently dropping a crash report.
pub fn metric(payload: Value) -> anyhow::Result<()> {
    let r = ACTIVE
        .get()
        .ok_or_else(|| anyhow::anyhow!("Diagnostics not initialized"))?;
    let (reply, received) = mpsc::channel();
    let message = Message::Metric {
        at: timestamp(),
        elapsed_us: r.started.elapsed().as_micros(),
        value: payload,
        reply,
    };
    r.sender
        .send(message)
        .map_err(|_| anyhow::anyhow!("Diagnostics writer stopped"))?;
    received
        .recv_timeout(Duration::from_secs(5))?
        .map_err(anyhow::Error::msg)
}
pub fn status() -> Value {
    ACTIVE.get().map(|r| json!({"active":true,"directory":r.directory,"queue_drops":r.dropped.load(Ordering::Relaxed),"write_failures":r.failures.load(Ordering::Relaxed)})).unwrap_or(json!({"active":false}))
}
pub fn flush() -> anyhow::Result<()> {
    if let Some(r) = ACTIVE.get() {
        let (tx, rx) = mpsc::channel();
        r.sender
            .try_send(Message::Flush(tx))
            .map_err(|_| anyhow::anyhow!("Diagnostics queue full"))?;
        rx.recv_timeout(Duration::from_secs(2))?;
    }
    Ok(())
}
#[derive(Clone)]
struct TimelineWriter;
impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for TimelineWriter {
    type Writer = Self;
    fn make_writer(&'a self) -> Self {
        self.clone()
    }
}
impl Write for TimelineWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        event("rust", json!({"message":String::from_utf8_lossy(bytes)}));
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn capture(
    protocol: &'static str,
    direction: &'static str,
    local: SocketAddr,
    peer: SocketAddr,
    connection: u64,
    bytes: &[u8],
) {
    if bytes.is_empty() {
        return;
    }
    // Limit each queue item; preserve all stream bytes across consecutive chunks.
    for bytes in bytes.chunks(65536) {
        submit(|r| Message::Bytes {
            at: timestamp(),
            elapsed_us: r.started.elapsed().as_micros(),
            transport: protocol,
            direction,
            local,
            peer,
            connection,
            bytes: bytes.to_vec(),
        });
    }
}
pub(crate) fn udp(
    direction: &'static str,
    local: io::Result<SocketAddr>,
    peer: SocketAddr,
    bytes: &[u8],
) {
    if let Ok(local) = local {
        capture("udp", direction, local, peer, 0, bytes);
    }
}

/// Records only bytes actually accepted/read by the existing Tokio socket.
/// Connection IDs separate reconnects which reuse an address and port.
pub(crate) struct CapturedTcp {
    stream: TcpStream,
    local: SocketAddr,
    peer: SocketAddr,
    id: u64,
}
impl CapturedTcp {
    pub(crate) fn new(stream: TcpStream) -> io::Result<Self> {
        let result = Self {
            local: stream.local_addr()?,
            peer: stream.peer_addr()?,
            id: CONNECTION.fetch_add(1, Ordering::Relaxed),
            stream,
        };
        event(
            "tcp_open",
            json!({"connection":result.id,"local":result.local.to_string(),"peer":result.peer.to_string()}),
        );
        Ok(result)
    }
}
impl Drop for CapturedTcp {
    fn drop(&mut self) {
        event("tcp_closed", json!({"connection":self.id}));
    }
}
impl AsyncRead for CapturedTcp {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let start = buf.filled().len();
        let result = Pin::new(&mut self.stream).poll_read(cx, buf);
        if let Poll::Ready(Ok(())) = &result {
            capture(
                "tcp",
                "rx",
                self.local,
                self.peer,
                self.id,
                &buf.filled()[start..],
            );
        }
        if let Poll::Ready(Err(e)) = &result {
            event(
                "tcp_read_error",
                json!({"connection":self.id,"error":e.to_string()}),
            );
        }
        result
    }
}
impl AsyncWrite for CapturedTcp {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let result = Pin::new(&mut self.stream).poll_write(cx, buf);
        if let Poll::Ready(Ok(n)) = &result {
            capture("tcp", "tx", self.local, self.peer, self.id, &buf[..*n]);
        }
        if let Poll::Ready(Err(e)) = &result {
            event(
                "tcp_write_error",
                json!({"connection":self.id,"error":e.to_string()}),
            );
        }
        result
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rotation_retains_recent_complete_rows_and_bounds_disk() {
        let dir = tempfile::tempdir().unwrap();
        let mut writer = RollingFile::new(dir.path(), "timeline", 100).unwrap();
        for i in 0..100 {
            writer.row(&json!({"event":i})).unwrap();
        }
        let mut values = vec![];
        for i in (0..SEGMENTS).rev() {
            let path = writer.path(i);
            assert!(fs::metadata(&path).unwrap().len() <= 100);
            for line in fs::read_to_string(path).unwrap().lines() {
                values.push(
                    serde_json::from_str::<Value>(line).unwrap()["event"]
                        .as_u64()
                        .unwrap(),
                );
            }
        }
        assert_eq!(values.last(), Some(&99));
        assert!(values.windows(2).all(|v| v[0] + 1 == v[1]));
        drop(writer);
        let mut reopened = RollingFile::new(dir.path(), "timeline", 100).unwrap();
        reopened.row(&json!({"event":100})).unwrap();
        assert!(
            fs::read_to_string(reopened.path(0))
                .unwrap()
                .contains("100")
        );
    }
    #[test]
    fn retention_preserves_unrelated_directories() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("unrelated")).unwrap();
        for i in 0..8 {
            fs::create_dir(root.path().join(format!("session-{i}"))).unwrap();
        }
        prune_sessions(root.path()).unwrap();
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), SESSIONS);
        assert!(root.path().join("unrelated").exists());
        assert!(root.path().join("session-7").exists());
        assert!(!root.path().join("session-0").exists());
    }
}
