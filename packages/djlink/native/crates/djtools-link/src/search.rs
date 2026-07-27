use std::collections::BTreeMap;

use deunicode::deunicode;

use crate::db::{
    DbValue, META_ALBUM, META_ARTIST, META_TRACK_TITLE_AND_ARTIST, MenuEntry, SORT_ALBUM,
    SORT_ARTIST, SORT_BITRATE, SORT_BPM, SORT_COLOR, SORT_COMMENT, SORT_DATE_ADDED, SORT_DEFAULT,
    SORT_GENRE, SORT_KEY, SORT_LABEL, SORT_RATING, SORT_TIME, SORT_TITLE, db_int,
    rmst_menu_from_args, strip_rmst_arg,
};
use crate::library::{LibrarySnapshot, TrackRecord};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SearchScope {
    Mixed,
    Track,
    Artist,
    Album,
}

pub(crate) fn search_scope_from_args(args: &[DbValue]) -> SearchScope {
    match rmst_menu_from_args(args) {
        Some(0x12) => SearchScope::Track,
        Some(0x1f) => SearchScope::Artist,
        Some(0x20) => SearchScope::Album,
        _ => SearchScope::Mixed,
    }
}

pub(crate) fn search_query_from_args(args: &[DbValue]) -> Option<String> {
    search_query_arg(strip_rmst_arg(args)).map(|(_, query)| query)
}

pub(crate) fn search_query_arg(args: &[DbValue]) -> Option<(usize, String)> {
    args.iter()
        .enumerate()
        .find_map(|(index, arg)| match arg {
            DbValue::String(value) if !value.trim().is_empty() => Some((index, value.clone())),
            _ => None,
        })
        .or_else(|| {
            args.iter().enumerate().find_map(|(index, arg)| match arg {
                DbValue::Binary(raw) => decode_search_binary(raw).map(|query| (index, query)),
                _ => None,
            })
        })
}

pub(crate) fn decode_search_binary(raw: &[u8]) -> Option<String> {
    if raw.is_empty() {
        return None;
    }
    let utf8 = std::str::from_utf8(raw)
        .ok()
        .map(|value| value.trim_matches(char::from(0)).trim().to_string())
        .filter(|value| !value.is_empty());
    if raw.len() % 2 != 0 {
        return utf8;
    }

    let be = decode_utf16_search_binary(raw, true);
    let le = decode_utf16_search_binary(raw, false);
    [be, le, utf8]
        .into_iter()
        .flatten()
        .max_by_key(|value| search_decode_score(value))
}

fn decode_utf16_search_binary(raw: &[u8], big_endian: bool) -> Option<String> {
    let mut units = raw
        .chunks_exact(2)
        .map(|pair| {
            if big_endian {
                u16::from_be_bytes([pair[0], pair[1]])
            } else {
                u16::from_le_bytes([pair[0], pair[1]])
            }
        })
        .collect::<Vec<_>>();
    while units.last() == Some(&0) {
        units.pop();
    }
    if units.is_empty() {
        return None;
    }
    let value = String::from_utf16_lossy(&units);
    (!value.trim().is_empty()).then_some(value)
}

fn search_decode_score(value: &str) -> (usize, usize) {
    let control_chars = value
        .chars()
        .filter(|ch| ch.is_control() && !ch.is_whitespace())
        .count();
    let useful_chars = value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || ch.is_ascii_whitespace())
        .count();
    (usize::MAX - control_chars, useful_chars)
}

pub(crate) fn track_search_score(
    track: &TrackRecord,
    query: &str,
    query_terms: &[&str],
) -> Option<u8> {
    let title = normalize_search_text(&track.title);
    let artist = normalize_search_text(&track.artist);
    let canonical = normalize_search_text(&track.canonical_name);
    let album = normalize_search_text(&track.album);
    let haystack = normalize_search_text(&format!(
        "{} {} {} {} {} {} {} {} {}",
        track.title,
        track.artist,
        track.canonical_name,
        track.album,
        track.key,
        track.camelot,
        track.genre,
        track.label,
        track.comment
    ));

    if title == query || canonical == query {
        return Some(0);
    }
    if artist == query || album == query {
        return Some(1);
    }
    if title.starts_with(query) || canonical.starts_with(query) {
        return Some(2);
    }
    if haystack.contains(query) {
        return Some(3);
    }
    if !query_terms.is_empty() && query_terms.iter().all(|term| haystack.contains(term)) {
        return Some(4);
    }
    None
}

pub(crate) fn search_entries(library: &LibrarySnapshot, args: &[DbValue]) -> Vec<MenuEntry> {
    let Some(query) = search_query_from_args(args) else {
        return Vec::new();
    };
    let query = normalize_search_text(&query);
    if query.is_empty() {
        return Vec::new();
    }
    let scope = search_scope_from_args(args);
    let query_terms = query.split_whitespace().collect::<Vec<_>>();
    match scope {
        SearchScope::Track => search_track_entries(library, &query, &query_terms),
        SearchScope::Artist => search_artist_entries(library, &query, &query_terms),
        SearchScope::Album => search_album_entries(library, &query, &query_terms),
        SearchScope::Mixed => mixed_search_entries(library, &query, &query_terms),
    }
}

fn search_track_entries(
    library: &LibrarySnapshot,
    query: &str,
    query_terms: &[&str],
) -> Vec<MenuEntry> {
    let mut tracks = library
        .all_tracks
        .iter()
        .filter_map(|track| {
            let score = track_search_score(track, query, query_terms)?;
            Some((score, track.clone()))
        })
        .collect::<Vec<_>>();
    tracks.sort_by(|(left_score, left), (right_score, right)| {
        left_score
            .cmp(right_score)
            .then_with(|| track_title_cmp(left, right))
    });
    tracks
        .into_iter()
        .enumerate()
        .map(|(idx, (_, track))| search_track_entry(&track, idx + 1))
        .collect()
}

fn search_track_entry(track: &TrackRecord, position: usize) -> MenuEntry {
    MenuEntry {
        entry_id1: track.artist_id,
        entry_id2: track.track_id,
        text1: track.title.clone(),
        text2: track.artist.clone(),
        entry_type: META_TRACK_TITLE_AND_ARTIST,
        entry_id3: track.track_id,
        position: position as u32,
        flags: 0x0100_0000,
        label: false,
        tail1: 0x0000_0100,
        tail2: 3,
        tail3: track.album_id,
        tail_text: track.key_label(),
        tail4: track.bpm_hundreds,
    }
}

fn mixed_search_entries(
    library: &LibrarySnapshot,
    query: &str,
    query_terms: &[&str],
) -> Vec<MenuEntry> {
    let mut entries = search_track_entries(library, query, query_terms);
    entries.extend(search_artist_entries(library, query, query_terms));
    entries.extend(search_album_entries(library, query, query_terms));
    entries
}

pub(crate) fn search_sort_from_args(args: &[DbValue]) -> u32 {
    let menu_sort = match rmst_menu_from_args(args) {
        Some(0x12) => Some(SORT_TITLE),
        Some(0x1f) => Some(SORT_ARTIST),
        Some(0x20) => Some(SORT_ALBUM),
        _ => None,
    };
    let args = strip_rmst_arg(args);
    let Some((query_index, _)) = search_query_arg(args) else {
        return menu_sort.unwrap_or(SORT_DEFAULT);
    };
    let sort = query_index
        .checked_sub(2)
        .and_then(|index| db_int(args.get(index)))
        .or_else(|| {
            query_index
                .checked_sub(1)
                .and_then(|index| db_int(args.get(index)))
        })
        .unwrap_or(SORT_DEFAULT);
    if is_known_search_sort(sort) && sort != SORT_DEFAULT {
        sort
    } else {
        menu_sort.unwrap_or(SORT_DEFAULT)
    }
}

fn is_known_search_sort(sort: u32) -> bool {
    matches!(
        sort,
        SORT_DEFAULT
            | SORT_TITLE
            | SORT_ARTIST
            | SORT_ALBUM
            | SORT_BPM
            | SORT_RATING
            | SORT_GENRE
            | SORT_COMMENT
            | SORT_TIME
            | SORT_LABEL
            | SORT_KEY
            | SORT_BITRATE
            | SORT_COLOR
            | SORT_DATE_ADDED
    )
}

fn search_artist_entries(
    library: &LibrarySnapshot,
    query: &str,
    query_terms: &[&str],
) -> Vec<MenuEntry> {
    let mut artists = BTreeMap::<String, u32>::new();
    for track in &library.all_tracks {
        let artist = normalize_search_text(&track.artist);
        if artist.contains(query)
            || (!query_terms.is_empty() && query_terms.iter().all(|term| artist.contains(term)))
        {
            artists
                .entry(track.artist.clone())
                .or_insert(track.artist_id);
        }
    }
    artists
        .into_iter()
        .map(|(artist, artist_id)| MenuEntry::plain(0, artist_id, &artist, "", META_ARTIST))
        .collect()
}

fn search_album_entries(
    library: &LibrarySnapshot,
    query: &str,
    query_terms: &[&str],
) -> Vec<MenuEntry> {
    let mut albums = BTreeMap::<String, (u32, String, u32)>::new();
    for track in &library.all_tracks {
        let album = normalize_search_text(&track.album);
        if album.contains(query)
            || (!query_terms.is_empty() && query_terms.iter().all(|term| album.contains(term)))
        {
            albums.entry(track.album.clone()).or_insert((
                track.album_id,
                track.artist.clone(),
                track.artist_id,
            ));
        }
    }
    albums
        .into_iter()
        .map(|(album, (album_id, artist, artist_id))| {
            MenuEntry::plain(artist_id, album_id, &album, &artist, META_ALBUM)
        })
        .collect()
}

fn track_title_cmp(a: &TrackRecord, b: &TrackRecord) -> std::cmp::Ordering {
    a.title
        .to_ascii_lowercase()
        .cmp(&b.title.to_ascii_lowercase())
        .then_with(|| a.track_id.cmp(&b.track_id))
}

pub(crate) fn normalize_search_text(value: &str) -> String {
    let mut out = String::new();
    let mut pending_space = false;
    for ch in deunicode(value).chars() {
        if ch.is_ascii_alphanumeric() {
            if pending_space && !out.is_empty() {
                out.push(' ');
            }
            pending_space = false;
            out.push(ch.to_ascii_lowercase());
        } else {
            pending_space = true;
        }
    }
    out
}
