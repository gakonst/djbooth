use std::collections::HashSet;
use std::time::Instant;

use crate::db::{
    DB_REQ_INCREMENTAL_SEARCH, DB_REQ_PLAYLIST, DB_REQ_SEARCH, DB_REQ_TITLE,
    DB_REQ_TRACKS_FOR_ALBUM, DB_REQ_TRACKS_FOR_ARTIST_ALBUM, DB_REQ_TRACKS_FOR_BITRATE,
    DB_REQ_TRACKS_FOR_BPM_DISTANCE, DB_REQ_TRACKS_FOR_COLOR, DB_REQ_TRACKS_FOR_DATE_ADDED,
    DB_REQ_TRACKS_FOR_DECADE_YEAR, DB_REQ_TRACKS_FOR_GENRE_ARTIST_ALBUM, DB_REQ_TRACKS_FOR_HISTORY,
    DB_REQ_TRACKS_FOR_KEY_DISTANCE, DB_REQ_TRACKS_FOR_LABEL_ARTIST_ALBUM, DB_REQ_TRACKS_FOR_RATING,
    DB_REQ_TRACKS_FOR_TIME, DbValue, MenuEntry, SORT_DEFAULT, db_int, strip_rmst_arg,
};
use crate::search::{SearchScope, search_scope_from_args};

pub(crate) const LOAD_CONTEXT_OFFSET: usize = 0x14;
pub(crate) const LOAD_CONTEXT_CATEGORY_1_OFFSET: usize = 0x15;
pub(crate) const LOAD_CONTEXT_CATEGORY_2_OFFSET: usize = 0x19;
pub(crate) const LOAD_CONTEXT_MENU_COUNT_OFFSET: usize = 0x23;
pub(crate) const LOAD_CONTEXT_ARTIST_MENU: u8 = 0x02;

#[derive(Debug, Clone)]
pub(crate) struct BrowseContextSnapshot {
    pub(crate) context: LoadConfirmContext,
    pub(crate) track_ids: HashSet<u32>,
    pub(crate) seen_at: Instant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct LoadConfirmContext {
    pub(crate) source_menu: u8,
    pub(crate) category_1: u32,
    pub(crate) category_2: u32,
    pub(crate) menu_count: u16,
}

impl LoadConfirmContext {
    pub(crate) fn new(source_menu: u8) -> Self {
        Self {
            source_menu,
            category_1: 0,
            category_2: 0,
            menu_count: 0,
        }
    }

    pub(crate) fn payload_overrides(self) -> Vec<(usize, u8)> {
        let mut overrides = Vec::with_capacity(15);
        overrides.push((LOAD_CONTEXT_OFFSET, self.source_menu));
        overrides.extend(be_u32_payload_overrides(
            LOAD_CONTEXT_CATEGORY_1_OFFSET,
            self.category_1,
        ));
        overrides.extend(be_u32_payload_overrides(
            LOAD_CONTEXT_CATEGORY_2_OFFSET,
            self.category_2,
        ));
        overrides.extend(be_u16_payload_overrides(
            LOAD_CONTEXT_MENU_COUNT_OFFSET,
            self.menu_count,
        ));
        overrides
    }

    pub(crate) fn summary(self) -> String {
        format!(
            "0x{:02x}({}) cat1={} cat2={} count={}",
            self.source_menu,
            load_context_menu_label(self.source_menu),
            self.category_1,
            self.category_2,
            self.menu_count,
        )
    }

    pub(crate) fn for_browse_request(
        request_type: u16,
        args: &[DbValue],
        entries: &[MenuEntry],
    ) -> Option<Self> {
        if !entries.iter().any(MenuEntry::is_track) {
            return None;
        }
        let args = strip_rmst_arg(args);
        let menu_count = entries.len().min(u16::MAX as usize) as u16;
        match request_type {
            DB_REQ_PLAYLIST => {
                let is_folder = db_int(args.get(2)).unwrap_or(1) == 1;
                let playlist_id = db_int(args.get(1))
                    .filter(|value| *value != 0)
                    .or_else(|| (!is_folder).then(|| db_int(args.first())).flatten())
                    .unwrap_or(0);
                Some(Self {
                    source_menu: 0x05,
                    category_1: playlist_id,
                    category_2: 0,
                    menu_count,
                })
            }
            DB_REQ_SEARCH | DB_REQ_INCREMENTAL_SEARCH => Some(Self {
                source_menu: search_load_context_from_args(args),
                category_1: 0,
                category_2: 0,
                menu_count,
            }),
            DB_REQ_TITLE => Some(Self {
                source_menu: 0x04,
                category_1: db_int(args.first()).unwrap_or(SORT_DEFAULT),
                category_2: 0,
                menu_count,
            }),
            DB_REQ_TRACKS_FOR_ALBUM => Some(Self {
                source_menu: 0x03,
                category_1: db_int(args.get(1)).unwrap_or(0),
                category_2: 0,
                menu_count,
            }),
            DB_REQ_TRACKS_FOR_ARTIST_ALBUM => Some(Self {
                source_menu: 0x02,
                category_1: db_int(args.get(1)).unwrap_or(0),
                category_2: db_int(args.get(2)).unwrap_or(0),
                menu_count,
            }),
            DB_REQ_TRACKS_FOR_KEY_DISTANCE => Some(Self {
                source_menu: 0x0c,
                category_1: db_int(args.get(1)).unwrap_or(0),
                category_2: db_int(args.get(2)).unwrap_or(0),
                menu_count,
            }),
            DB_REQ_TRACKS_FOR_DATE_ADDED => Some(Self {
                source_menu: 0x04,
                category_1: db_int(args.get(1)).unwrap_or(0),
                category_2: 0,
                menu_count,
            }),
            DB_REQ_TRACKS_FOR_GENRE_ARTIST_ALBUM
            | DB_REQ_TRACKS_FOR_BPM_DISTANCE
            | DB_REQ_TRACKS_FOR_DECADE_YEAR
            | DB_REQ_TRACKS_FOR_LABEL_ARTIST_ALBUM
            | DB_REQ_TRACKS_FOR_COLOR
            | DB_REQ_TRACKS_FOR_TIME
            | DB_REQ_TRACKS_FOR_BITRATE
            | DB_REQ_TRACKS_FOR_RATING
            | DB_REQ_TRACKS_FOR_HISTORY => Some(Self {
                source_menu: 0x04,
                category_1: db_int(args.get(1)).unwrap_or(0),
                category_2: db_int(args.get(2)).unwrap_or(0),
                menu_count,
            }),
            _ => None,
        }
    }
}

fn search_load_context_from_args(args: &[DbValue]) -> u8 {
    match search_scope_from_args(args) {
        SearchScope::Artist => 0x1f,
        SearchScope::Album => 0x20,
        SearchScope::Mixed | SearchScope::Track => 0x12,
    }
}

fn load_context_menu_label(value: u8) -> &'static str {
    match value {
        0x00 => "none",
        0x02 => "artist-menu",
        0x03 => "album-menu",
        0x04 => "track-menu",
        0x05 => "playlist",
        0x06 => "bpm-menu",
        0x0c => "key-menu",
        0x11 => "folder-menu",
        0x12 => "search-song",
        0x16 => "history",
        0x1f => "search-artist",
        0x20 => "search-album",
        0x28 => "tag-list",
        0x32 => "instant-double-or-previous-track",
        _ => "unknown",
    }
}

fn be_u16_payload_overrides(offset: usize, value: u16) -> [(usize, u8); 2] {
    let bytes = value.to_be_bytes();
    [(offset, bytes[0]), (offset + 1, bytes[1])]
}

fn be_u32_payload_overrides(offset: usize, value: u32) -> [(usize, u8); 4] {
    let bytes = value.to_be_bytes();
    [
        (offset, bytes[0]),
        (offset + 1, bytes[1]),
        (offset + 2, bytes[2]),
        (offset + 3, bytes[3]),
    ]
}

#[derive(Debug, Clone)]
pub(crate) struct LoadProgressSnapshot {
    pub(crate) track_id: u32,
    pub(crate) seen_at: Instant,
    pub(crate) context: &'static str,
}

impl LoadProgressSnapshot {
    pub(crate) fn is_visual_data(&self) -> bool {
        context_is_visual_load_data(self.context)
    }

    pub(crate) fn suppresses_load_confirm(&self) -> bool {
        context_suppresses_load_confirm(self.context)
    }
}

pub(crate) fn context_is_visual_load_data(context: &str) -> bool {
    matches!(
        context,
        "waveform-preview" | "waveform-detail" | "anlz-visual"
    )
}

pub(crate) fn context_suppresses_load_confirm(context: &str) -> bool {
    matches!(
        context,
        "waveform-preview" | "waveform-detail" | "nfs-audio"
    )
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct LoadConfirmSession {
    pub(crate) generation: u64,
    pub(crate) track_id: u32,
    pub(crate) started_at: Instant,
    pub(crate) require_playing: bool,
    pub(crate) progress_followup_sent: bool,
}
