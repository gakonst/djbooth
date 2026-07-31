use std::{
    env,
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
};

use anyhow::{Context as _, Result, bail};
use gpui::{
    App, Application, Bounds, Context, Div, Render, Window, WindowBounds, WindowOptions, div,
    prelude::*, px, rgb, size,
};
use gpui_component::{
    Root, Sizable as _,
    button::{Button, ButtonVariants as _},
    sidebar::SidebarToggleButton,
};
use serde::Deserialize;
use serde_json::Value;

const BACKGROUND: u32 = 0x08090c;
const SURFACE: u32 = 0x101218;
const SURFACE_RAISED: u32 = 0x171a22;
const BORDER: u32 = 0x292d38;
const TEXT: u32 = 0xe7e9ef;
const MUTED: u32 = 0x858b9a;
const FAINT: u32 = 0x565d6d;
const ACCENT: u32 = 0xa78bfa;
const DECK_A: u32 = 0x60a5fa;
const DECK_B: u32 = 0xf472b6;
const SUCCESS: u32 = 0x4ade80;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LibraryStats {
    tracks: usize,
    playlists: usize,
    analyzed: usize,
}

#[derive(Debug, Deserialize)]
struct BootstrapEnvelope {
    library: BootstrapLibrary,
}

#[derive(Debug, Deserialize)]
struct BootstrapLibrary {
    stats: LibraryStats,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Playlist {
    name: String,
    track_count: Option<usize>,
    #[serde(default)]
    hosted: Option<HostedPlaylist>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostedPlaylist {
    provider: String,
    download_enabled: bool,
    sync_state: String,
}

#[derive(Debug, Deserialize)]
struct PlaylistsEnvelope {
    items: Vec<Playlist>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Track {
    #[serde(rename = "id")]
    _id: String,
    title: String,
    artist: Option<String>,
    album: Option<String>,
    genre: Option<String>,
    key: Option<String>,
    bpm: Option<f64>,
    duration_seconds: Option<f64>,
    analyzed: bool,
    file_exists: bool,
}

#[derive(Debug, Deserialize)]
struct TracksEnvelope {
    items: Vec<Track>,
    count: usize,
}

#[derive(Debug)]
struct ApiSnapshot {
    stats: LibraryStats,
    playlists: Vec<Playlist>,
    tracks: Vec<Track>,
    track_count: usize,
}

impl ApiSnapshot {
    fn load(base_url: &str) -> Result<Self> {
        let bootstrap: BootstrapEnvelope = get_json(base_url, "/api/bootstrap")?;
        let local: PlaylistsEnvelope = get_json(base_url, "/api/playlists")?;
        let hosted: PlaylistsEnvelope = get_json(base_url, "/api/hosted-playlists")?;
        let tracks: TracksEnvelope = get_json(
            base_url,
            "/api/tracks?filter=all&limit=100&offset=0&sort=title&direction=asc",
        )?;
        let mut playlists = local.items;
        playlists.extend(hosted.items);
        Ok(Self {
            stats: bootstrap.library.stats,
            playlists,
            track_count: tracks.count,
            tracks: tracks.items,
        })
    }
}

struct BackendLease {
    url: String,
    child: Option<Child>,
}

impl BackendLease {
    fn connect() -> Result<Self> {
        if let Ok(url) = env::var("REKORDBOX_LIBRARY_URL") {
            return Ok(Self {
                url: normalize_base_url(&url),
                child: None,
            });
        }

        let package_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .context("GPUI crate has no package parent")?
            .to_path_buf();
        let script = env::var_os("REKORDBOX_LIBRARY_SIDECAR_SCRIPT")
            .map(PathBuf::from)
            .unwrap_or_else(|| package_root.join("dist/desktop-sidecar.js"));
        if !script.is_file() {
            bail!(
                "library sidecar is missing at {}; run `pnpm --filter @gakonst/rekordbox-library build`",
                script.display()
            );
        }
        let node = env::var_os("REKORDBOX_LIBRARY_NODE_BINARY").unwrap_or_else(|| "node".into());
        let mut child = Command::new(node)
            .arg(script)
            .arg("--read-only")
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .context("failed to start the library sidecar")?;
        let stdout = child
            .stdout
            .take()
            .context("sidecar stdout was not piped")?;
        let mut lines = BufReader::new(stdout).lines();
        let ready = lines
            .next()
            .transpose()
            .context("failed to read sidecar readiness")?
            .context("library sidecar exited before readiness")?;
        let value: Value =
            serde_json::from_str(&ready).context("invalid sidecar readiness JSON")?;
        if value.get("type").and_then(Value::as_str) != Some("ready") {
            bail!("unexpected sidecar startup message: {ready}");
        }
        let url = value
            .get("url")
            .and_then(Value::as_str)
            .context("sidecar readiness omitted its URL")?;
        Ok(Self {
            url: normalize_base_url(url),
            child: Some(child),
        })
    }
}

impl Drop for BackendLease {
    fn drop(&mut self) {
        if let Some(child) = &mut self.child {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

struct Workbench {
    _backend: BackendLease,
    stats: LibraryStats,
    playlists: Vec<Playlist>,
    tracks: Vec<Track>,
    track_count: usize,
    sidebar_collapsed: bool,
    selected: usize,
    deck_a: Option<Track>,
    deck_b: Option<Track>,
}

impl Workbench {
    fn new(backend: BackendLease, snapshot: ApiSnapshot) -> Self {
        let deck_a = snapshot.tracks.first().cloned();
        let deck_b = snapshot.tracks.get(1).cloned();
        Self {
            _backend: backend,
            stats: snapshot.stats,
            playlists: snapshot.playlists,
            tracks: snapshot.tracks,
            track_count: snapshot.track_count,
            sidebar_collapsed: false,
            selected: 0,
            deck_a,
            deck_b,
        }
    }

    fn sidebar(&self, cx: &mut Context<Self>) -> Div {
        let collapsed = self.sidebar_collapsed;
        let rows = self
            .playlists
            .iter()
            .take(40)
            .enumerate()
            .map(|(index, playlist)| {
                let provider = playlist
                    .hosted
                    .as_ref()
                    .map(|hosted| hosted.provider.as_str())
                    .unwrap_or("rekordbox");
                let state = playlist.hosted.as_ref().map(|hosted| {
                    if hosted.sync_state == "error" {
                        "retry"
                    } else if hosted.download_enabled {
                        "saved"
                    } else {
                        "remote"
                    }
                });
                div()
                    .id(("playlist", index))
                    .h(px(29.))
                    .px_3()
                    .flex()
                    .items_center()
                    .gap_2()
                    .rounded_md()
                    .text_xs()
                    .text_color(rgb(MUTED))
                    .hover(|style| style.bg(rgb(SURFACE_RAISED)).text_color(rgb(TEXT)))
                    .child(
                        div()
                            .w(px(if collapsed { 22. } else { 62. }))
                            .text_color(rgb(FAINT))
                            .child(if collapsed {
                                provider
                                    .chars()
                                    .next()
                                    .unwrap_or('R')
                                    .to_uppercase()
                                    .to_string()
                            } else {
                                provider.to_uppercase()
                            }),
                    )
                    .when(!collapsed, |row| {
                        row.child(div().flex_1().truncate().child(playlist.name.clone()))
                            .child(
                                playlist
                                    .track_count
                                    .map(|count| count.to_string())
                                    .unwrap_or_else(|| "—".into()),
                            )
                    })
                    .when_some(if collapsed { None } else { state }, |row, state| {
                        row.child(
                            div()
                                .ml_1()
                                .text_color(if state == "retry" {
                                    rgb(DECK_B)
                                } else {
                                    rgb(SUCCESS)
                                })
                                .child(state.to_uppercase()),
                        )
                    })
            });
        div()
            .w(px(if collapsed { 74. } else { 258. }))
            .h_full()
            .flex_none()
            .flex()
            .flex_col()
            .border_r_1()
            .border_color(rgb(BORDER))
            .bg(rgb(0x0b0d11))
            .child(
                div()
                    .h(px(52.))
                    .px_4()
                    .flex()
                    .items_center()
                    .gap_3()
                    .border_b_1()
                    .border_color(rgb(BORDER))
                    .child(div().size_8().rounded_lg().bg(rgb(0x32215d)))
                    .when(!collapsed, |header| {
                        header.child(
                            div()
                                .flex()
                                .flex_col()
                                .child(div().text_sm().text_color(rgb(TEXT)).child("Music Library"))
                                .child(
                                    div()
                                        .text_xs()
                                        .text_color(rgb(FAINT))
                                        .child("GPUI / REKORDBOX WORKBENCH"),
                                ),
                        )
                    })
                    .child(div().flex_1())
                    .child(
                        SidebarToggleButton::left()
                            .collapsed(collapsed)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.sidebar_collapsed = !this.sidebar_collapsed;
                                cx.notify();
                            })),
                    ),
            )
            .when(!collapsed, |sidebar| {
                sidebar.child(
                    div()
                        .h(px(42.))
                        .mx_3()
                        .mt_3()
                        .px_3()
                        .flex()
                        .items_center()
                        .rounded_md()
                        .border_1()
                        .border_color(rgb(BORDER))
                        .text_xs()
                        .text_color(rgb(FAINT))
                        .child("Filter playlists…"),
                )
            })
            .when(!collapsed, |sidebar| {
                sidebar
                    .child(
                        div()
                            .id("playlist-scroll")
                            .px_3()
                            .py_3()
                            .flex_1()
                            .overflow_scroll()
                            .children(rows),
                    )
                    .child(
                        div()
                            .h(px(42.))
                            .px_4()
                            .flex()
                            .items_center()
                            .border_t_1()
                            .border_color(rgb(BORDER))
                            .text_xs()
                            .text_color(rgb(MUTED))
                            .child(format!(
                                "{} tracks · {} playlists · {} analyzed",
                                self.stats.tracks, self.stats.playlists, self.stats.analyzed
                            )),
                    )
            })
    }

    fn deck(track: Option<&Track>, label: &'static str, color: u32) -> Div {
        let title = track
            .map(|track| display_title(&track.title))
            .unwrap_or("No track loaded");
        let artist = track
            .and_then(|track| track.artist.as_deref())
            .unwrap_or("Double-click a track to load it");
        let bpm = track
            .and_then(|track| track.bpm)
            .map(|bpm| format!("{bpm:.1} BPM"))
            .unwrap_or_else(|| "— BPM".into());
        let key = track.and_then(|track| track.key.as_deref()).unwrap_or("—");
        let duration = track
            .and_then(|track| track.duration_seconds)
            .unwrap_or(0.0);
        div()
            .h(px(132.))
            .flex_none()
            .flex()
            .flex_col()
            .gap_2()
            .p_3()
            .border_b_1()
            .border_color(rgb(BORDER))
            .bg(rgb(SURFACE))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_3()
                    .child(
                        div()
                            .size_7()
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded_md()
                            .border_1()
                            .border_color(rgb(color))
                            .text_xs()
                            .text_color(rgb(color))
                            .child(label),
                    )
                    .child(
                        div()
                            .flex_1()
                            .truncate()
                            .text_sm()
                            .text_color(rgb(TEXT))
                            .child(title.to_owned()),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(rgb(MUTED))
                            .child(artist.to_owned()),
                    )
                    .child(div().text_xs().text_color(rgb(color)).child(bpm))
                    .child(div().text_xs().text_color(rgb(MUTED)).child(key.to_owned()))
                    .child(
                        div()
                            .px_2()
                            .py_1()
                            .rounded_md()
                            .bg(rgb(0x21163d))
                            .text_xs()
                            .text_color(rgb(ACCENT))
                            .child("ORIG  ALL  V  D  B  O"),
                    ),
            )
            .child(waveform(color))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .text_xs()
                    .text_color(rgb(MUTED))
                    .child("◀  −10")
                    .child(
                        div()
                            .size_8()
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded_lg()
                            .bg(rgb(color))
                            .text_color(rgb(BACKGROUND))
                            .child("▶"),
                    )
                    .child("+10  ▶")
                    .child(div().flex_1())
                    .child("LOW  ○   MID  ○   HIGH  ○   TRIM  ○")
                    .child(format_duration(duration)),
            )
    }

    fn track_browser(&self, cx: &mut Context<Self>) -> Div {
        let header = div()
            .h(px(32.))
            .px_3()
            .flex()
            .items_center()
            .border_b_1()
            .border_color(rgb(BORDER))
            .text_xs()
            .text_color(rgb(FAINT))
            .child(div().w(px(36.)).child("#"))
            .child(div().flex_1().child("TITLE / ARTIST"))
            .child(div().w(px(72.)).child("BPM"))
            .child(div().w(px(52.)).child("KEY"))
            .child(div().w(px(160.)).child("ALBUM"))
            .child(div().w(px(120.)).child("GENRE"));
        let rows = self.tracks.iter().enumerate().map(|(index, track)| {
            let selected = index == self.selected;
            let analyzed = if track.analyzed { "◆" } else { "◇" };
            let playable = if track.file_exists { "" } else { " · missing" };
            let title = display_title(&track.title).to_owned();
            let artist = track
                .artist
                .clone()
                .unwrap_or_else(|| "Unknown artist".into());
            let bpm = track
                .bpm
                .map(|value| format!("{value:.1}"))
                .unwrap_or_else(|| "—".into());
            let key = track.key.clone().unwrap_or_else(|| "—".into());
            let album = track.album.clone().unwrap_or_else(|| "—".into());
            let genre = track.genre.clone().unwrap_or_else(|| "—".into());
            div()
                .id(("track", index))
                .h(px(45.))
                .px_3()
                .flex()
                .items_center()
                .border_b_1()
                .border_color(rgb(0x1c1f27))
                .text_xs()
                .text_color(rgb(MUTED))
                .when(selected, |row| row.bg(rgb(0x1b1530)))
                .hover(|row| row.bg(rgb(SURFACE_RAISED)))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.selected = index;
                    cx.notify();
                }))
                .child(
                    div()
                        .w(px(36.))
                        .text_color(rgb(FAINT))
                        .child((index + 1).to_string()),
                )
                .child(
                    div()
                        .flex_1()
                        .overflow_hidden()
                        .child(div().truncate().text_color(rgb(TEXT)).child(title))
                        .child(
                            div()
                                .truncate()
                                .text_color(rgb(FAINT))
                                .child(format!("{analyzed} {artist}{playable}")),
                        ),
                )
                .child(div().w(px(72.)).child(bpm))
                .child(div().w(px(52.)).text_color(rgb(ACCENT)).child(key))
                .child(div().w(px(160.)).truncate().child(album))
                .child(div().w(px(120.)).truncate().child(genre))
        });
        div()
            .flex_1()
            .flex()
            .flex_col()
            .overflow_hidden()
            .child(header)
            .child(
                div()
                    .id("track-scroll")
                    .flex_1()
                    .overflow_scroll()
                    .children(rows),
            )
            .child(
                div()
                    .h(px(30.))
                    .px_3()
                    .flex()
                    .items_center()
                    .border_t_1()
                    .border_color(rgb(BORDER))
                    .text_xs()
                    .text_color(rgb(FAINT))
                    .child(format!(
                        "Showing {} of {} tracks",
                        self.tracks.len(),
                        self.track_count
                    )),
            )
    }

    fn center(&self, cx: &mut Context<Self>) -> Div {
        let load_a = cx.entity();
        let load_b = cx.entity();
        div()
            .flex_1()
            .h_full()
            .flex()
            .flex_col()
            .overflow_hidden()
            .child(
                div()
                    .h(px(42.))
                    .px_4()
                    .flex()
                    .items_center()
                    .justify_between()
                    .border_b_1()
                    .border_color(rgb(BORDER))
                    .bg(rgb(0x0d0f14))
                    .child(
                        div()
                            .text_sm()
                            .text_color(rgb(TEXT))
                            .child("Library  ›  All tracks"),
                    )
                    .child(
                        div()
                            .flex()
                            .gap_2()
                            .child(
                                Button::new("load-a")
                                    .primary()
                                    .compact()
                                    .xsmall()
                                    .label("Load A")
                                    .on_click(move |_, _, cx| {
                                        load_a.update(cx, |this, cx| {
                                            this.deck_a = this.tracks.get(this.selected).cloned();
                                            cx.notify();
                                        });
                                    }),
                            )
                            .child(
                                Button::new("load-b")
                                    .info()
                                    .compact()
                                    .xsmall()
                                    .label("Load B")
                                    .on_click(move |_, _, cx| {
                                        load_b.update(cx, |this, cx| {
                                            this.deck_b = this.tracks.get(this.selected).cloned();
                                            cx.notify();
                                        });
                                    }),
                            ),
                    ),
            )
            .child(Self::deck(self.deck_a.as_ref(), "A", DECK_A))
            .child(Self::deck(self.deck_b.as_ref(), "B", DECK_B))
            .child(
                div()
                    .h(px(35.))
                    .px_4()
                    .flex()
                    .items_center()
                    .gap_3()
                    .border_b_1()
                    .border_color(rgb(BORDER))
                    .bg(rgb(0x0d0f14))
                    .text_xs()
                    .text_color(rgb(MUTED))
                    .child("A  ━━━━━●━━━━━  B")
                    .child("Transition  8s")
                    .child("A → B")
                    .child("B → A")
                    .child(div().flex_1())
                    .child("Search title, artist, album, genre…"),
            )
            .child(self.track_browser(cx))
    }

    fn assistant(&self) -> Div {
        div()
            .w(px(350.))
            .h_full()
            .flex_none()
            .flex()
            .flex_col()
            .border_l_1()
            .border_color(rgb(BORDER))
            .bg(rgb(0x0b0d11))
            .child(
                div()
                    .h(px(52.))
                    .px_4()
                    .flex()
                    .items_center()
                    .gap_3()
                    .border_b_1()
                    .border_color(rgb(BORDER))
                    .child(div().size_7().rounded_lg().bg(rgb(0x35215e)))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .child(div().text_sm().text_color(rgb(TEXT)).child("Nanocodex"))
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(rgb(FAINT))
                                    .child("Native GPUI migration shell"),
                            ),
                    ),
            )
            .child(
                div()
                    .flex_1()
                    .p_4()
                    .flex()
                    .flex_col()
                    .justify_center()
                    .gap_3()
                    .child(div().text_sm().text_color(rgb(TEXT)).child("Describe the set you want"))
                    .child(
                        div()
                            .text_xs()
                            .text_color(rgb(MUTED))
                            .child("The GPUI shell intentionally keeps agent execution behind the existing typed loopback API boundary."),
                    )
                    .child(
                        div()
                            .p_3()
                            .rounded_md()
                            .border_1()
                            .border_color(rgb(BORDER))
                            .bg(rgb(SURFACE))
                            .text_xs()
                            .text_color(rgb(FAINT))
                            .child("Build a playlist, reorder tracks, or find a transition…"),
                    ),
            )
    }
}

impl Render for Workbench {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .flex()
            .bg(rgb(BACKGROUND))
            .text_color(rgb(TEXT))
            .child(self.sidebar(cx))
            .child(self.center(cx))
            .child(self.assistant())
    }
}

fn waveform(color: u32) -> Div {
    let bars = (0..96).map(move |index| {
        let height = 8.0 + ((index * 17 + index * index * 3) % 30) as f32;
        div()
            .w(px(2.))
            .h(px(height))
            .flex_none()
            .rounded_sm()
            .bg(if index % 7 == 0 {
                rgb(ACCENT)
            } else {
                rgb(color)
            })
    });
    div()
        .h(px(39.))
        .w_full()
        .px_2()
        .flex()
        .items_center()
        .gap_1()
        .overflow_hidden()
        .rounded_md()
        .border_1()
        .border_color(rgb(BORDER))
        .bg(rgb(0x050609))
        .children(bars)
}

fn display_title(title: &str) -> &str {
    if title.trim().is_empty() {
        "Untitled"
    } else {
        title
    }
}

fn format_duration(seconds: f64) -> String {
    let seconds = seconds.max(0.0).floor() as u64;
    format!("{}:{:02}", seconds / 60, seconds % 60)
}

fn normalize_base_url(value: &str) -> String {
    format!("{}/", value.trim().trim_end_matches('/'))
}

fn get_json<T: for<'de> Deserialize<'de>>(base_url: &str, path: &str) -> Result<T> {
    let url = format!("{}{}", base_url.trim_end_matches('/'), path);
    let mut response = ureq::get(&url)
        .call()
        .with_context(|| format!("GET {url} failed"))?;
    response
        .body_mut()
        .read_json()
        .with_context(|| format!("GET {url} returned invalid JSON"))
}

fn main() -> Result<()> {
    let backend = BackendLease::connect()?;
    let snapshot = ApiSnapshot::load(&backend.url)?;
    Application::new().run(move |cx: &mut App| {
        gpui_component::init(cx);
        let bounds = Bounds::centered(None, size(px(1440.), px(920.)), cx);
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                ..Default::default()
            },
            move |window, cx| {
                let workbench = cx.new(|_| Workbench::new(backend, snapshot));
                cx.new(|cx| Root::new(workbench, window, cx))
            },
        )
        .expect("failed to open the GPUI workbench window");
        cx.activate(true);
    });
    Ok(())
}
