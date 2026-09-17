//! Foreground LAN playback experiment. Only explicitly registered files are
//! served, to the selected renderer, behind an ephemeral capability URL.
use anyhow::{Context, Result, ensure};
use axum::{
    Router,
    body::Body,
    extract::{ConnectInfo, Path, State},
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
};
use serde::Deserialize;
use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
    pin::Pin,
    sync::Arc,
    task::{Context as TaskContext, Poll},
    time::{Duration, Instant},
};
use tokio::{
    fs::File,
    io::{AsyncReadExt, AsyncSeekExt},
    net::{TcpListener, UdpSocket},
    sync::{OwnedSemaphorePermit, Semaphore, oneshot},
    task::JoinHandle,
};
use tokio_stream::Stream;
use tokio_util::io::ReaderStream;

#[derive(Clone, Deserialize)]
pub struct MediaFile {
    pub path: PathBuf,
    pub mime: String,
}
#[derive(Clone)]
struct ServerState {
    files: Arc<Vec<MediaFile>>,
    capability: Arc<str>,
    peer: IpAddr,
    slots: Arc<Semaphore>,
}
pub struct LocalMediaServer {
    pub urls: Vec<String>,
    stop: Option<oneshot::Sender<()>>,
    _task: JoinHandle<()>,
}
impl Drop for LocalMediaServer {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        // Graceful shutdown closes the listener and lets already buffered audio
        // complete. Each transfer has its own bounded deadline.
    }
}
impl LocalMediaServer {
    pub async fn start(peer: Ipv4Addr, files: Vec<MediaFile>) -> Result<Self> {
        ensure!(
            !files.is_empty() && files.len() <= 2000,
            "Choose 1–2000 cached files"
        );
        let mut checked = Vec::with_capacity(files.len());
        for mut file in files {
            ensure!(
                matches!(
                    file.mime.as_str(),
                    "audio/mpeg"
                        | "audio/mp4"
                        | "audio/flac"
                        | "audio/wav"
                        | "audio/aiff"
                        | "audio/aac"
                        | "audio/ogg"
                ),
                "Unsupported audio type"
            );
            file.path = tokio::fs::canonicalize(&file.path)
                .await
                .context("Cached audio is unavailable")?;
            let metadata = tokio::fs::metadata(&file.path).await?;
            ensure!(
                metadata.is_file() && metadata.len() > 0,
                "Cached audio must be a nonempty file"
            );
            checked.push(file);
        }
        let route = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).await?;
        route.connect((peer, 1400)).await?;
        let listener = TcpListener::bind((route.local_addr()?.ip(), 0)).await?;
        let address = listener.local_addr()?;
        let capability: Arc<str> = uuid::Uuid::new_v4().simple().to_string().into();
        let urls: Vec<String> = (0..checked.len())
            .map(|i| format!("http://{address}/{capability}/{i}"))
            .collect();
        let state = ServerState {
            files: Arc::new(checked),
            capability,
            peer: peer.into(),
            slots: Arc::new(Semaphore::new(8)),
        };
        let app = Router::new()
            .route("/{capability}/{index}", get(serve))
            .with_state(state);
        let (stop, stopped) = oneshot::channel();
        let task = tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await;
        });
        tracing::info!(%address, count = urls.len(), "Sonos phone media listener started");
        Ok(Self {
            urls,
            stop: Some(stop),
            _task: task,
        })
    }
}
fn range(value: &str, size: u64) -> Option<(u64, u64)> {
    let (start, end) = value.strip_prefix("bytes=")?.split_once('-')?;
    if start.is_empty() {
        let length = end.parse::<u64>().ok()?.min(size);
        return (length > 0).then_some((size - length, length));
    }
    let start = start.parse::<u64>().ok()?;
    let end = if end.is_empty() {
        size - 1
    } else {
        end.parse::<u64>().ok()?.min(size - 1)
    };
    (start < size && end >= start).then(|| (start, end - start + 1))
}
struct Transfer {
    reader: ReaderStream<tokio::io::Take<File>>,
    _slot: OwnedSemaphorePermit,
    deadline: Pin<Box<tokio::time::Sleep>>,
}
impl Stream for Transfer {
    type Item = std::io::Result<axum::body::Bytes>;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<Option<Self::Item>> {
        if std::future::Future::poll(self.deadline.as_mut(), cx).is_ready() {
            return Poll::Ready(Some(Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "Audio transfer expired",
            ))));
        }
        let result = Pin::new(&mut self.reader).poll_next(cx);
        if matches!(&result, Poll::Ready(Some(Ok(_)))) {
            self.deadline
                .as_mut()
                .reset(tokio::time::Instant::now() + Duration::from_secs(30));
        }
        result
    }
}
async fn serve(
    State(state): State<ServerState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path((capability, index)): Path<(String, usize)>,
    method: Method,
    headers: HeaderMap,
) -> Response {
    let started = Instant::now();
    if peer.ip() != state.peer || capability != state.capability.as_ref() {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some(media) = state.files.get(index) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(slot) = state.slots.clone().try_acquire_owned() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let Ok(mut file) = File::open(&media.path).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(metadata) = file.metadata().await else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let size = metadata.len();
    if size == 0 {
        return StatusCode::NOT_FOUND.into_response();
    }
    // An unknown If-Range validator requires the complete representation.
    let requested = headers
        .get("range")
        .filter(|_| !headers.contains_key("if-range"));
    let (offset, length) = if let Some(requested) = requested {
        let Some(range) = requested.to_str().ok().and_then(|s| range(s, size)) else {
            return Response::builder()
                .status(416)
                .header("content-range", format!("bytes */{size}"))
                .body(Body::empty())
                .unwrap();
        };
        range
    } else {
        (0, size)
    };
    let body = if method == Method::HEAD {
        Body::empty()
    } else {
        if file.seek(std::io::SeekFrom::Start(offset)).await.is_err() {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
        Body::from_stream(Transfer {
            reader: ReaderStream::with_capacity(file.take(length), 64 * 1024),
            _slot: slot,
            deadline: Box::pin(tokio::time::sleep(Duration::from_secs(30))),
        })
    };
    let mut response = Response::builder()
        .status(if requested.is_some() { 206 } else { 200 })
        .header("content-type", &media.mime)
        .header("content-length", length)
        .header("accept-ranges", "bytes")
        .header("cache-control", "private, no-store");
    if requested.is_some() {
        response = response.header(
            "content-range",
            format!("bytes {offset}-{}/{size}", offset + length - 1),
        );
    }
    tracing::info!(
        index,
        offset,
        length,
        head = method == Method::HEAD,
        elapsed_us = started.elapsed().as_micros() as u64,
        "Sonos phone media response"
    );
    response.body(body).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn renderer_reads_exact_bytes_ranges_and_head_without_path_access() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audio");
        let bytes: Vec<u8> = (0..200_000).map(|i| (i % 251) as u8).collect();
        tokio::fs::write(&path, &bytes).await.unwrap();
        let server = LocalMediaServer::start(
            Ipv4Addr::LOCALHOST,
            vec![MediaFile {
                path,
                mime: "audio/mp4".into(),
            }],
        )
        .await
        .unwrap();
        let client = reqwest::Client::new();
        let url = &server.urls[0];
        let response = client.get(url).send().await.unwrap();
        assert_eq!(response.content_length(), Some(bytes.len() as u64));
        assert_eq!(response.bytes().await.unwrap().as_ref(), bytes);
        for (range, expected) in [
            ("bytes=123-987", &bytes[123..988]),
            ("bytes=199900-", &bytes[199900..]),
            ("bytes=-100", &bytes[199900..]),
        ] {
            let response = client.get(url).header("range", range).send().await.unwrap();
            assert_eq!(response.status(), 206);
            assert_eq!(response.bytes().await.unwrap().as_ref(), expected);
        }
        let head = client.head(url).send().await.unwrap();
        assert_eq!(head.headers()["content-length"], bytes.len().to_string());
        assert!(head.bytes().await.unwrap().is_empty());
        for range in ["bytes=200000-", "bytes=3-2", "bytes=-0", "bytes=0-1,4-5"] {
            assert_eq!(
                client
                    .get(url)
                    .header("range", range)
                    .send()
                    .await
                    .unwrap()
                    .status(),
                416
            );
        }
        assert_eq!(
            client
                .get(url)
                .header("range", "bytes=1-2")
                .header("if-range", "unknown")
                .send()
                .await
                .unwrap()
                .status(),
            200
        );
        let mut bad = reqwest::Url::parse(url).unwrap();
        bad.set_path("/wrong/0");
        assert_eq!(client.get(bad).send().await.unwrap().status(), 404);
        assert_eq!(client.post(url).send().await.unwrap().status(), 405);
        let url = url.clone();
        drop(server);
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(client.get(url).send().await.is_err());
    }
}
