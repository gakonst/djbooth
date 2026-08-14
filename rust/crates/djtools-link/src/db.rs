use tokio::io::AsyncReadExt;
use tokio::net::TcpStream;

pub(crate) const DB_FIELD_INT8: u8 = 0x0f;
pub(crate) const DB_FIELD_INT16: u8 = 0x10;
pub(crate) const DB_FIELD_INT32: u8 = 0x11;
pub(crate) const DB_FIELD_BINARY: u8 = 0x14;
pub(crate) const DB_FIELD_STRING: u8 = 0x26;

pub(crate) const DB_MSG_FIELD_INT8: u8 = 0x04;
pub(crate) const DB_MSG_FIELD_INT16: u8 = 0x05;
pub(crate) const DB_MSG_FIELD_INT32: u8 = 0x06;
pub(crate) const DB_MSG_FIELD_BINARY: u8 = 0x03;
pub(crate) const DB_MSG_FIELD_STRING: u8 = 0x02;

pub(crate) const DB_MAGIC: u32 = 0x8723_49ae;

pub(crate) const DB_REQ_SETUP: u16 = 0x0000;
pub(crate) const DB_REQ_TEARDOWN: u16 = 0x0100;
pub(crate) const DB_REQ_ROOT_MENU: u16 = 0x1000;
pub(crate) const DB_REQ_GENRE: u16 = 0x1001;
pub(crate) const DB_REQ_ARTIST: u16 = 0x1002;
pub(crate) const DB_REQ_ALBUM: u16 = 0x1003;
pub(crate) const DB_REQ_TITLE: u16 = 0x1004;
pub(crate) const DB_REQ_BPM_MENU: u16 = 0x1006;
pub(crate) const DB_REQ_RATING_MENU: u16 = 0x1007;
pub(crate) const DB_REQ_YEAR_MENU: u16 = 0x1008;
pub(crate) const DB_REQ_LABEL_MENU: u16 = 0x100a;
pub(crate) const DB_REQ_COLOR_MENU: u16 = 0x100d;
pub(crate) const DB_REQ_TIME_MENU: u16 = 0x1010;
pub(crate) const DB_REQ_BITRATE: u16 = 0x1011;
pub(crate) const DB_REQ_HISTORY_MENU: u16 = 0x1012;
pub(crate) const DB_REQ_FILENAME_MENU: u16 = 0x1013;
pub(crate) const DB_REQ_KEY_MENU: u16 = 0x1014;
pub(crate) const DB_REQ_ARTISTS_FOR_GENRE: u16 = 0x1101;
pub(crate) const DB_REQ_ALBUMS_FOR_ARTIST: u16 = 0x1102;
pub(crate) const DB_REQ_TRACKS_FOR_ALBUM: u16 = 0x1103;
pub(crate) const DB_REQ_PLAYLIST: u16 = 0x1105;
pub(crate) const DB_REQ_BPM_RANGE: u16 = 0x1106;
pub(crate) const DB_REQ_TRACKS_FOR_RATING: u16 = 0x1107;
pub(crate) const DB_REQ_YEARS_FOR_DECADE: u16 = 0x1108;
pub(crate) const DB_REQ_ARTISTS_FOR_LABEL: u16 = 0x110a;
pub(crate) const DB_REQ_TRACKS_FOR_COLOR: u16 = 0x110d;
pub(crate) const DB_REQ_TRACKS_FOR_TIME: u16 = 0x1110;
pub(crate) const DB_REQ_TRACKS_FOR_BITRATE: u16 = 0x1111;
pub(crate) const DB_REQ_TRACKS_FOR_HISTORY: u16 = 0x1112;
pub(crate) const DB_REQ_KEY_NEIGHBOR: u16 = 0x1114;
pub(crate) const DB_REQ_ALBUMS_FOR_GENRE_ARTIST: u16 = 0x1201;
pub(crate) const DB_REQ_TRACKS_FOR_ARTIST_ALBUM: u16 = 0x1202;
pub(crate) const DB_REQ_TRACKS_FOR_BPM_DISTANCE: u16 = 0x1206;
pub(crate) const DB_REQ_TRACKS_FOR_DECADE_YEAR: u16 = 0x1208;
pub(crate) const DB_REQ_ALBUMS_FOR_LABEL_ARTIST: u16 = 0x120a;
pub(crate) const DB_REQ_TRACKS_FOR_KEY_DISTANCE: u16 = 0x1214;
pub(crate) const DB_REQ_SEARCH: u16 = 0x1300;
pub(crate) const DB_REQ_TRACKS_FOR_GENRE_ARTIST_ALBUM: u16 = 0x1301;
pub(crate) const DB_REQ_ORIGINAL_ARTIST_MENU: u16 = 0x1302;
pub(crate) const DB_REQ_TRACKS_FOR_LABEL_ARTIST_ALBUM: u16 = 0x130a;
pub(crate) const DB_REQ_SORT_MENU: u16 = 0x1400;
pub(crate) const DB_REQ_ALBUMS_FOR_ORIGINAL_ARTIST: u16 = 0x1402;
/// Incremental search emitted by CDJ-3000 keyboard edits.
pub(crate) const DB_REQ_INCREMENTAL_SEARCH: u16 = 0x1500;
pub(crate) const DB_REQ_TRACKS_FOR_ORIGINAL_ARTIST_ALBUM: u16 = 0x1502;
pub(crate) const DB_REQ_REMIXER_MENU: u16 = 0x1602;
pub(crate) const DB_REQ_ALBUMS_FOR_REMIXER: u16 = 0x1702;
pub(crate) const DB_REQ_DATE_ADDED_MENU: u16 = 0x1708;
pub(crate) const DB_REQ_TRACKS_FOR_REMIXER_ALBUM: u16 = 0x1802;
pub(crate) const DB_REQ_TRACKS_FOR_DATE_ADDED: u16 = 0x1808;
pub(crate) const DB_REQ_HOT_CUE_BANK: u16 = 0x2001;
pub(crate) const DB_REQ_METADATA: u16 = 0x2002;
pub(crate) const DB_REQ_ARTWORK: u16 = 0x2003;
pub(crate) const DB_REQ_WAVEFORM_PREVIEW: u16 = 0x2004;
pub(crate) const DB_REQ_WAVEFORM_PREVIEW_UPLOAD: u16 = 0x2005;
pub(crate) const DB_REQ_FOLDER_MENU: u16 = 0x2006;
pub(crate) const DB_REQ_MOUNT_INFO: u16 = 0x2102;
pub(crate) const DB_REQ_CUE_POINTS: u16 = 0x2104;
pub(crate) const DB_REQ_TRACK_INFO: u16 = 0x2202;
pub(crate) const DB_REQ_BEAT_GRID: u16 = 0x2204;
pub(crate) const DB_REQ_EXT_2705: u16 = 0x2705;
pub(crate) const DB_REQ_WAVEFORM_DETAIL: u16 = 0x2904;
pub(crate) const DB_REQ_CUE_POINTS_EXT: u16 = 0x2b04;
pub(crate) const DB_REQ_ANLZ_TAG: u16 = 0x2c04;
pub(crate) const DB_REQ_INTRODUCE: u16 = 0x3007;
pub(crate) const DB_REQ_RENDER: u16 = 0x3000;
pub(crate) const DB_REQ_EXT_3001: u16 = 0x3001;
/// CDJ-3000 LINK-source availability request. Current players send this with
/// only the r:m:s:t context after rendering playback metadata.
pub(crate) const DB_REQ_EXT_3006: u16 = 0x3006;

pub(crate) const DB_RES_SUCCESS: u16 = 0x4000;
pub(crate) const DB_RES_MENU_HEADER: u16 = 0x4001;
pub(crate) const DB_RES_ARTWORK: u16 = 0x4002;
pub(crate) const DB_RES_INVALID_REQUEST: u16 = 0x4003;
pub(crate) const DB_RES_MENU_ITEM: u16 = 0x4101;
pub(crate) const DB_RES_MENU_FOOTER: u16 = 0x4201;
pub(crate) const DB_RES_WAVEFORM_PREVIEW: u16 = 0x4402;
pub(crate) const DB_RES_EXT_2504: u16 = 0x4502;
pub(crate) const DB_RES_BEAT_GRID: u16 = 0x4602;
pub(crate) const DB_RES_CUE_POINTS: u16 = 0x4702;
pub(crate) const DB_RES_WAVEFORM_DETAIL: u16 = 0x4a02;
pub(crate) const DB_RES_CUE_POINTS_EXT: u16 = 0x4e02;
pub(crate) const DB_RES_ANLZ_TAG: u16 = 0x4f02;

pub(crate) const META_MOUNT_PATH: u32 = 0x0000;
pub(crate) const META_FOLDER: u32 = 0x0001;
pub(crate) const META_ALBUM: u32 = 0x0002;
pub(crate) const META_TITLE: u32 = 0x0004;
pub(crate) const META_GENRE: u32 = 0x0006;
pub(crate) const META_ARTIST: u32 = 0x0007;
pub(crate) const META_PLAYLIST: u32 = 0x0008;
pub(crate) const META_RATING: u32 = 0x000a;
pub(crate) const META_DURATION: u32 = 0x000b;
pub(crate) const META_BPM: u32 = 0x000d;
pub(crate) const META_LABEL: u32 = 0x000e;
pub(crate) const META_KEY: u32 = 0x000f;
pub(crate) const META_BITRATE: u32 = 0x0010;
pub(crate) const META_YEAR: u32 = 0x0011;
pub(crate) const META_COLOR_NONE: u32 = 0x0013;
pub(crate) const META_COMMENT: u32 = 0x0023;
pub(crate) const META_ORIGINAL_ARTIST: u32 = 0x0028;
pub(crate) const META_REMIXER: u32 = 0x0029;
pub(crate) const META_DATE_ADDED: u32 = 0x002e;
pub(crate) const META_ROOT_TRACK: u32 = 0x0083;
pub(crate) const META_ROOT_PLAYLIST: u32 = 0x0084;
pub(crate) const META_TRACK_TITLE_AND_ALBUM: u32 = 0x0204;
pub(crate) const META_TRACK_TITLE_AND_GENRE: u32 = 0x0604;
pub(crate) const META_TRACK_TITLE_AND_ARTIST: u32 = 0x0704;
pub(crate) const META_TRACK_TITLE_AND_RATING: u32 = 0x0a04;
pub(crate) const META_TRACK_TITLE_AND_TIME: u32 = 0x0b04;
pub(crate) const META_TRACK_TITLE_AND_BPM: u32 = 0x0d04;
pub(crate) const META_TRACK_TITLE_AND_LABEL: u32 = 0x0e04;
pub(crate) const META_TRACK_TITLE_AND_KEY: u32 = 0x0f04;
pub(crate) const META_TRACK_TITLE_AND_BITRATE: u32 = 0x1004;
pub(crate) const META_TRACK_TITLE_AND_COLOR: u32 = 0x1a04;
pub(crate) const META_TRACK_TITLE_AND_COMMENT: u32 = 0x2304;
pub(crate) const META_TRACK_TITLE_AND_DATE_ADDED: u32 = 0x2e04;

pub(crate) const SORT_DEFAULT: u32 = 0x00;
pub(crate) const SORT_TITLE: u32 = 0x01;
pub(crate) const SORT_ARTIST: u32 = 0x02;
pub(crate) const SORT_ALBUM: u32 = 0x03;
pub(crate) const SORT_BPM: u32 = 0x04;
pub(crate) const SORT_RATING: u32 = 0x05;
pub(crate) const SORT_GENRE: u32 = 0x06;
pub(crate) const SORT_COMMENT: u32 = 0x07;
pub(crate) const SORT_TIME: u32 = 0x08;
pub(crate) const SORT_LABEL: u32 = 0x0a;
pub(crate) const SORT_KEY: u32 = 0x0c;
pub(crate) const SORT_BITRATE: u32 = 0x0d;
pub(crate) const SORT_COLOR: u32 = 0x0f;
pub(crate) const SORT_DATE_ADDED: u32 = 0x11;
pub(crate) const ROOT_HISTORY_ID: u32 = 22;
pub(crate) const ROOT_SEARCH_ID: u32 = 18;
pub(crate) const ROOT_MATCHING_ID: u32 = 26;
pub(crate) const ROOT_DATE_ADDED_ID: u32 = 27;
pub(crate) const ROOT_COLOR_ID: u32 = 15;

#[derive(Debug, thiserror::Error)]
pub(crate) enum DbError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("invalid DB message magic field")]
    InvalidMagicField,
    #[error("invalid DB message magic 0x{0:08x}")]
    InvalidMagic(u32),
    #[error("invalid DB transaction field")]
    InvalidTransactionField,
    #[error("invalid DB message type field")]
    InvalidMessageTypeField,
    #[error("invalid DB arg count field")]
    InvalidArgCountField,
    #[error("invalid DB arg types field")]
    InvalidArgTypesField,
    #[error("unsupported DB field type 0x{0:02x}")]
    UnsupportedFieldType(u8),
}

type DbResult<T> = std::result::Result<T, DbError>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DbValue {
    Int8(u8),
    Int16(u16),
    Int32(u32),
    Binary(Vec<u8>),
    String(String),
}

impl DbValue {
    fn msg_type(&self) -> u8 {
        match self {
            Self::Int8(_) => DB_MSG_FIELD_INT8,
            Self::Int16(_) => DB_MSG_FIELD_INT16,
            Self::Int32(_) => DB_MSG_FIELD_INT32,
            Self::Binary(_) => DB_MSG_FIELD_BINARY,
            Self::String(_) => DB_MSG_FIELD_STRING,
        }
    }
}

#[derive(Debug)]
pub(crate) struct DbMessage {
    pub(crate) tx_id: u32,
    pub(crate) msg_type: u16,
    pub(crate) args: Vec<DbValue>,
}

pub(crate) fn db_args_summary(args: &[DbValue]) -> String {
    args.iter()
        .map(db_value_summary)
        .collect::<Vec<_>>()
        .join(", ")
}

pub(crate) fn db_request_name(msg_type: u16) -> String {
    let name = match msg_type {
        DB_REQ_SETUP => "SETUP",
        DB_REQ_ROOT_MENU => "ROOT_MENU",
        DB_REQ_GENRE => "GENRE",
        DB_REQ_ARTIST => "ARTIST",
        DB_REQ_ALBUM => "ALBUM",
        DB_REQ_TITLE => "TITLE",
        DB_REQ_BPM_MENU => "BPM_MENU",
        DB_REQ_RATING_MENU => "RATING_MENU",
        DB_REQ_YEAR_MENU => "YEAR_MENU",
        DB_REQ_LABEL_MENU => "LABEL_MENU",
        DB_REQ_COLOR_MENU => "COLOR_MENU",
        DB_REQ_TIME_MENU => "TIME_MENU",
        DB_REQ_BITRATE => "BITRATE",
        DB_REQ_HISTORY_MENU => "HISTORY_MENU",
        DB_REQ_FILENAME_MENU => "FILENAME_MENU",
        DB_REQ_KEY_MENU => "KEY_MENU",
        DB_REQ_ARTISTS_FOR_GENRE => "ARTISTS_FOR_GENRE",
        DB_REQ_ALBUMS_FOR_ARTIST => "ALBUMS_FOR_ARTIST",
        DB_REQ_TRACKS_FOR_ALBUM => "TRACKS_FOR_ALBUM",
        DB_REQ_PLAYLIST => "PLAYLIST",
        DB_REQ_BPM_RANGE => "BPM_RANGE",
        DB_REQ_TRACKS_FOR_RATING => "TRACKS_FOR_RATING",
        DB_REQ_YEARS_FOR_DECADE => "YEARS_FOR_DECADE",
        DB_REQ_ARTISTS_FOR_LABEL => "ARTISTS_FOR_LABEL",
        DB_REQ_TRACKS_FOR_COLOR => "TRACKS_FOR_COLOR",
        DB_REQ_TRACKS_FOR_TIME => "TRACKS_FOR_TIME",
        DB_REQ_TRACKS_FOR_BITRATE => "TRACKS_FOR_BITRATE",
        DB_REQ_TRACKS_FOR_HISTORY => "TRACKS_FOR_HISTORY",
        DB_REQ_ALBUMS_FOR_GENRE_ARTIST => "ALBUMS_FOR_GENRE_ARTIST",
        DB_REQ_TRACKS_FOR_ARTIST_ALBUM => "TRACKS_FOR_ARTIST_ALBUM",
        DB_REQ_TRACKS_FOR_BPM_DISTANCE => "TRACKS_FOR_BPM_DISTANCE",
        DB_REQ_TRACKS_FOR_DECADE_YEAR => "TRACKS_FOR_DECADE_YEAR",
        DB_REQ_ALBUMS_FOR_LABEL_ARTIST => "ALBUMS_FOR_LABEL_ARTIST",
        DB_REQ_TRACKS_FOR_KEY_DISTANCE => "TRACKS_FOR_KEY_DISTANCE",
        DB_REQ_SEARCH => "SEARCH",
        DB_REQ_INCREMENTAL_SEARCH => "INCREMENTAL_SEARCH",
        DB_REQ_TRACKS_FOR_GENRE_ARTIST_ALBUM => "TRACKS_FOR_GENRE_ARTIST_ALBUM",
        DB_REQ_ORIGINAL_ARTIST_MENU => "ORIGINAL_ARTIST_MENU",
        DB_REQ_TRACKS_FOR_LABEL_ARTIST_ALBUM => "TRACKS_FOR_LABEL_ARTIST_ALBUM",
        DB_REQ_KEY_NEIGHBOR => "KEY_NEIGHBOR",
        DB_REQ_ALBUMS_FOR_ORIGINAL_ARTIST => "ALBUMS_FOR_ORIGINAL_ARTIST",
        DB_REQ_TRACKS_FOR_ORIGINAL_ARTIST_ALBUM => "TRACKS_FOR_ORIGINAL_ARTIST_ALBUM",
        DB_REQ_REMIXER_MENU => "REMIXER_MENU",
        DB_REQ_ALBUMS_FOR_REMIXER => "ALBUMS_FOR_REMIXER",
        DB_REQ_DATE_ADDED_MENU => "DATE_ADDED_MENU",
        DB_REQ_TRACKS_FOR_REMIXER_ALBUM => "TRACKS_FOR_REMIXER_ALBUM",
        DB_REQ_TRACKS_FOR_DATE_ADDED => "TRACKS_FOR_DATE_ADDED",
        DB_REQ_HOT_CUE_BANK => "HOT_CUE_BANK",
        DB_REQ_METADATA => "METADATA",
        DB_REQ_MOUNT_INFO => "MOUNT_INFO",
        DB_REQ_TRACK_INFO => "TRACK_INFO",
        DB_REQ_ARTWORK => "ARTWORK",
        DB_REQ_WAVEFORM_PREVIEW => "WAVEFORM_PREVIEW",
        DB_REQ_WAVEFORM_PREVIEW_UPLOAD => "WAVEFORM_PREVIEW_UPLOAD",
        DB_REQ_FOLDER_MENU => "FOLDER_MENU",
        DB_REQ_CUE_POINTS => "CUE_POINTS",
        DB_REQ_BEAT_GRID => "BEAT_GRID",
        DB_REQ_EXT_2705 => "EXT_2705",
        DB_REQ_WAVEFORM_DETAIL => "WAVEFORM_DETAIL",
        DB_REQ_CUE_POINTS_EXT => "CUE_POINTS_EXT",
        DB_REQ_ANLZ_TAG => "ANLZ_TAG",
        DB_REQ_INTRODUCE => "INTRODUCE",
        DB_REQ_RENDER => "RENDER",
        DB_REQ_EXT_3001 => "EXT_3001",
        DB_REQ_EXT_3006 => "EXT_3006",
        DB_REQ_SORT_MENU => "SORT_MENU",
        0x0001 => "INVALID_DATA_OR_CLOSE",
        DB_REQ_TEARDOWN => "TEARDOWN",
        0x2504 => "EXT_2504",
        0x2d04 => "ANLZ_TAG_EXT",
        0x3100 => "EXT_3100",
        _ => "UNKNOWN",
    };
    format!("{name}(0x{msg_type:04x})")
}

fn db_value_summary(value: &DbValue) -> String {
    match value {
        DbValue::Int8(value) => format!("u8:{value}"),
        DbValue::Int16(value) => format!("u16:{value}"),
        DbValue::Int32(value) => format!("u32:{value}"),
        DbValue::Binary(raw) => format!("bin:{}b", raw.len()),
        DbValue::String(value) => {
            let mut text = value.chars().take(64).collect::<String>();
            if value.chars().count() > 64 {
                text.push_str("...");
            }
            format!("str:{text:?}")
        }
    }
}

pub(crate) async fn recv_db_message(stream: &mut TcpStream) -> DbResult<DbMessage> {
    let DbValue::Int32(magic) = recv_db_field(stream).await? else {
        return Err(DbError::InvalidMagicField);
    };
    if magic != DB_MAGIC {
        return Err(DbError::InvalidMagic(magic));
    }
    let DbValue::Int32(tx_id) = recv_db_field(stream).await? else {
        return Err(DbError::InvalidTransactionField);
    };
    let DbValue::Int16(msg_type) = recv_db_field(stream).await? else {
        return Err(DbError::InvalidMessageTypeField);
    };
    let DbValue::Int8(argc) = recv_db_field(stream).await? else {
        return Err(DbError::InvalidArgCountField);
    };
    let DbValue::Binary(arg_types) = recv_db_field(stream).await? else {
        return Err(DbError::InvalidArgTypesField);
    };

    let mut args = Vec::with_capacity(argc as usize);
    for i in 0..argc as usize {
        // RemoteDB advertises a blob field but omits it from the wire when the
        // immediately preceding length field is zero. Waiting for a byte to
        // "peek" here deadlocks until the deck sends its next request.
        if arg_types.get(i) == Some(&DB_MSG_FIELD_BINARY)
            && args.last().and_then(|value| db_int(Some(value))) == Some(0)
        {
            args.push(DbValue::Binary(Vec::new()));
            continue;
        }
        args.push(recv_db_field(stream).await?);
    }

    Ok(DbMessage {
        tx_id,
        msg_type,
        args,
    })
}

pub(crate) async fn recv_db_field(stream: &mut TcpStream) -> DbResult<DbValue> {
    let mut ty = [0u8; 1];
    stream.read_exact(&mut ty).await?;
    match ty[0] {
        DB_FIELD_INT8 => {
            let mut raw = [0u8; 1];
            stream.read_exact(&mut raw).await?;
            Ok(DbValue::Int8(raw[0]))
        }
        DB_FIELD_INT16 => {
            let mut raw = [0u8; 2];
            stream.read_exact(&mut raw).await?;
            Ok(DbValue::Int16(u16::from_be_bytes(raw)))
        }
        DB_FIELD_INT32 => {
            let mut raw = [0u8; 4];
            stream.read_exact(&mut raw).await?;
            Ok(DbValue::Int32(u32::from_be_bytes(raw)))
        }
        DB_FIELD_BINARY => {
            let mut len = [0u8; 4];
            stream.read_exact(&mut len).await?;
            let len = u32::from_be_bytes(len) as usize;
            let mut raw = vec![0u8; len];
            stream.read_exact(&mut raw).await?;
            Ok(DbValue::Binary(raw))
        }
        DB_FIELD_STRING => {
            let mut units = [0u8; 4];
            stream.read_exact(&mut units).await?;
            let units = u32::from_be_bytes(units).saturating_sub(1) as usize;
            let mut raw = vec![0u8; units * 2];
            stream.read_exact(&mut raw).await?;
            let mut pad = [0u8; 2];
            stream.read_exact(&mut pad).await?;
            let units = raw
                .chunks_exact(2)
                .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
                .collect::<Vec<_>>();
            Ok(DbValue::String(String::from_utf16_lossy(&units)))
        }
        other => Err(DbError::UnsupportedFieldType(other)),
    }
}

pub(crate) fn encode_db_message(tx_id: u32, msg_type: u16, args: &[DbValue]) -> Vec<u8> {
    let arg_types = args.iter().map(DbValue::msg_type).collect::<Vec<_>>();
    let mut out = Vec::new();
    out.extend_from_slice(&encode_db_field(&DbValue::Int32(DB_MAGIC)));
    out.extend_from_slice(&encode_db_field(&DbValue::Int32(tx_id)));
    out.extend_from_slice(&encode_db_field(&DbValue::Int16(msg_type)));
    out.extend_from_slice(&encode_db_field(&DbValue::Int8(
        args.len().min(u8::MAX as usize) as u8,
    )));
    out.extend_from_slice(&encode_db_field(&DbValue::Binary(arg_types)));
    for arg in args {
        out.extend_from_slice(&encode_db_field(arg));
    }
    out
}

pub(crate) fn encode_db_field(value: &DbValue) -> Vec<u8> {
    match value {
        DbValue::Int8(value) => vec![DB_FIELD_INT8, *value],
        DbValue::Int16(value) => {
            let mut out = vec![DB_FIELD_INT16];
            out.extend_from_slice(&value.to_be_bytes());
            out
        }
        DbValue::Int32(value) => {
            let mut out = vec![DB_FIELD_INT32];
            out.extend_from_slice(&value.to_be_bytes());
            out
        }
        DbValue::Binary(raw) => {
            let mut out = vec![DB_FIELD_BINARY];
            out.extend_from_slice(&(raw.len() as u32).to_be_bytes());
            out.extend_from_slice(raw);
            out
        }
        DbValue::String(value) => {
            let units = value.encode_utf16().collect::<Vec<_>>();
            let mut out = vec![DB_FIELD_STRING];
            out.extend_from_slice(&((units.len() + 1) as u32).to_be_bytes());
            for unit in units {
                out.extend_from_slice(&unit.to_be_bytes());
            }
            out.extend_from_slice(&0u16.to_be_bytes());
            out
        }
    }
}

pub(crate) fn strip_rmst_arg(args: &[DbValue]) -> &[DbValue] {
    if args.len() >= 2 && db_int(args.first()).is_some_and(is_rmst_arg) {
        return &args[1..];
    }
    if rmst_from_separate_args(args).is_some() {
        return &args[4..];
    }
    args
}

pub(crate) fn rmst_menu_from_args(args: &[DbValue]) -> Option<u8> {
    rmst_from_args(args).map(|value| ((value >> 16) & 0xff) as u8)
}

pub(crate) fn rmst_slot_from_args(args: &[DbValue]) -> Option<u8> {
    rmst_from_args(args).map(|value| ((value >> 8) & 0xff) as u8)
}

pub(crate) fn rmst_from_args(args: &[DbValue]) -> Option<u32> {
    db_int(args.first())
        .filter(|value| is_rmst_arg(*value))
        .or_else(|| rmst_from_separate_args(args))
}

fn rmst_from_separate_args(args: &[DbValue]) -> Option<u32> {
    if args.len() < 4 {
        return None;
    }
    let player = db_int(args.first())?;
    let menu = db_int(args.get(1))?;
    let slot = db_int(args.get(2))?;
    let track_type = db_int(args.get(3))?;
    if player == 0 || player > 0xff || menu >= 0x40 || slot > 0x04 || track_type > 5 {
        return None;
    }
    Some((player << 24) | (menu << 16) | (slot << 8) | track_type)
}

pub(crate) fn is_rmst_arg(value: u32) -> bool {
    let player = (value >> 24) & 0xff;
    let menu = (value >> 16) & 0xff;
    let slot = (value >> 8) & 0xff;
    let track_type = value & 0xff;
    player != 0 && menu < 0x40 && slot <= 0x04 && track_type <= 5
}

pub(crate) fn db_int(value: Option<&DbValue>) -> Option<u32> {
    match value? {
        DbValue::Int8(value) => Some(*value as u32),
        DbValue::Int16(value) => Some(*value as u32),
        DbValue::Int32(value) => Some(*value),
        _ => None,
    }
}

#[derive(Debug, Clone)]
pub(crate) struct MenuEntry {
    pub(crate) entry_id1: u32,
    pub(crate) entry_id2: u32,
    pub(crate) text1: String,
    pub(crate) text2: String,
    pub(crate) entry_type: u32,
    pub(crate) entry_id3: u32,
    pub(crate) position: u32,
    pub(crate) flags: u32,
    pub(crate) label: bool,
    pub(crate) tail1: u32,
    pub(crate) tail2: u32,
    pub(crate) tail3: u32,
    pub(crate) tail_text: String,
    pub(crate) tail4: u32,
}

impl MenuEntry {
    pub(crate) fn plain(id1: u32, id2: u32, text1: &str, text2: &str, entry_type: u32) -> Self {
        Self {
            entry_id1: id1,
            entry_id2: id2,
            text1: text1.to_string(),
            text2: text2.to_string(),
            entry_type,
            entry_id3: 0,
            position: 0,
            flags: 0,
            label: false,
            tail1: 0,
            tail2: 0,
            tail3: 0,
            tail_text: text2.to_string(),
            tail4: 0,
        }
    }

    pub(crate) fn label(id1: u32, id2: u32, text: &str, entry_type: u32) -> Self {
        Self {
            label: true,
            ..Self::plain(id1, id2, text, "", entry_type)
        }
    }

    pub(crate) fn with_entry_id3(mut self, id3: u32) -> Self {
        self.entry_id3 = id3;
        self
    }

    pub(crate) fn is_track(&self) -> bool {
        matches!(
            self.entry_type,
            META_TITLE
                | META_TRACK_TITLE_AND_ALBUM
                | META_TRACK_TITLE_AND_GENRE
                | META_TRACK_TITLE_AND_ARTIST
                | META_TRACK_TITLE_AND_RATING
                | META_TRACK_TITLE_AND_TIME
                | META_TRACK_TITLE_AND_BPM
                | META_TRACK_TITLE_AND_LABEL
                | META_TRACK_TITLE_AND_KEY
                | META_TRACK_TITLE_AND_BITRATE
                | META_TRACK_TITLE_AND_COLOR
                | META_TRACK_TITLE_AND_COMMENT
                | META_TRACK_TITLE_AND_DATE_ADDED
        )
    }

    pub(crate) fn track_id(&self) -> Option<u32> {
        let id = if self.entry_id3 != 0 {
            self.entry_id3
        } else {
            self.entry_id2
        };
        (id != 0).then_some(id)
    }

    fn preview(&self) -> String {
        format!(
            "{}:{:04x}:{}:{}",
            self.entry_id2, self.entry_type, self.text1, self.text2
        )
    }
}

pub(crate) fn menu_entry_args(entry: &MenuEntry) -> Vec<DbValue> {
    let text1 = if entry.label {
        format!("\u{fffa}{}\u{fffb}", entry.text1)
    } else {
        entry.text1.clone()
    };
    vec![
        DbValue::Int32(entry.entry_id1),
        DbValue::Int32(entry.entry_id2),
        DbValue::Int32(utf16_size(&text1) as u32),
        DbValue::String(text1),
        DbValue::Int32(utf16_size(&entry.text2) as u32),
        DbValue::String(entry.text2.clone()),
        DbValue::Int32(entry.entry_type),
        DbValue::Int32(entry.flags),
        DbValue::Int32(entry.entry_id3),
        DbValue::Int32(entry.position),
        DbValue::Int32(entry.tail1),
        DbValue::Int32(entry.tail2),
        DbValue::Int32(entry.tail3),
        DbValue::Int32(utf16_size(&entry.tail_text) as u32),
        DbValue::String(entry.tail_text.clone()),
        DbValue::Int32(entry.tail4),
    ]
}

pub(crate) fn menu_entries_preview(entries: &[MenuEntry]) -> String {
    const MAX_PREVIEW_ROWS: usize = 12;
    let mut out = entries
        .iter()
        .take(MAX_PREVIEW_ROWS)
        .map(MenuEntry::preview)
        .collect::<Vec<_>>()
        .join(" | ");
    if entries.len() > MAX_PREVIEW_ROWS {
        out.push_str(" | ...");
    }
    out
}

pub(crate) fn parse_render_window(args: &[DbValue]) -> RenderWindow {
    let args = strip_rmst_arg(args);
    if args.len() >= 2 {
        return RenderWindow {
            offset: db_int(args.first()).unwrap_or(0) as usize,
            count: db_int(args.get(1)).unwrap_or(0) as usize,
            total: db_int(args.get(3)).unwrap_or(0) as usize,
        };
    }
    RenderWindow {
        offset: 0,
        count: 0,
        total: 0,
    }
}

pub(crate) fn pending_key_from_args(args: &[DbValue]) -> Option<u32> {
    rmst_from_args(args)
}

pub(crate) fn success_with_count(tx_id: u32, request_type: u16, count: u32) -> Vec<u8> {
    encode_db_message(
        tx_id,
        DB_RES_SUCCESS,
        &[DbValue::Int32(request_type as u32), DbValue::Int32(count)],
    )
}

pub(crate) fn render_messages(tx_id: u32, offset: usize, entries: &[MenuEntry]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&encode_db_message(
        tx_id,
        DB_RES_MENU_HEADER,
        &[
            DbValue::Int32(1),
            DbValue::Int32(offset.min(u32::MAX as usize) as u32),
        ],
    ));
    for entry in entries {
        out.extend_from_slice(&encode_db_message(
            tx_id,
            DB_RES_MENU_ITEM,
            &menu_entry_args(entry),
        ));
    }
    out.extend_from_slice(&encode_db_message(tx_id, DB_RES_MENU_FOOTER, &[]));
    out
}

pub(crate) fn cue_points_response(
    tx_id: u32,
    req_type: u16,
    first: Option<&[u8]>,
    second: Option<&[u8]>,
    hot_count: u32,
    memory_count: u32,
) -> Vec<u8> {
    let first = first.unwrap_or_default().to_vec();
    let second = second.unwrap_or_default().to_vec();
    encode_db_message(
        tx_id,
        DB_RES_CUE_POINTS,
        &[
            DbValue::Int32(req_type as u32),
            DbValue::Int32(0),
            DbValue::Int32(first.len() as u32),
            DbValue::Binary(first),
            DbValue::Int32(0x24),
            DbValue::Int32(hot_count),
            DbValue::Int32(memory_count),
            DbValue::Int32(second.len() as u32),
            DbValue::Binary(second),
        ],
    )
}

pub(crate) fn cue_points_ext_response(
    tx_id: u32,
    req_type: u16,
    data: &[u8],
    entry_count: u32,
) -> Vec<u8> {
    encode_db_message(
        tx_id,
        DB_RES_CUE_POINTS_EXT,
        &[
            DbValue::Int32(req_type as u32),
            DbValue::Int32(0),
            DbValue::Int32(data.len() as u32),
            DbValue::Binary(data.to_vec()),
            DbValue::Int32(entry_count),
        ],
    )
}

pub(crate) fn blob_response(
    tx_id: u32,
    req_type: u16,
    res_type: u16,
    data: Option<&[u8]>,
) -> Vec<u8> {
    if data.is_none() && res_type == DB_RES_ANLZ_TAG {
        let mut out = Vec::new();
        out.extend_from_slice(&encode_db_field(&DbValue::Int32(DB_MAGIC)));
        out.extend_from_slice(&encode_db_field(&DbValue::Int32(tx_id)));
        out.extend_from_slice(&encode_db_field(&DbValue::Int16(res_type)));
        out.extend_from_slice(&encode_db_field(&DbValue::Int8(5)));
        out.extend_from_slice(&encode_db_field(&DbValue::Binary(vec![
            0x06, 0x06, 0x06, 0x03, 0x06,
        ])));
        out.extend_from_slice(&encode_db_field(&DbValue::Int32(req_type as u32)));
        out.extend_from_slice(&encode_db_field(&DbValue::Int32(0x32)));
        out.extend_from_slice(&encode_db_field(&DbValue::Int32(0)));
        out.extend_from_slice(&encode_db_field(&DbValue::Int32(0)));
        return out;
    }
    if data.map(|bytes| bytes.is_empty()).unwrap_or(true)
        && matches!(
            res_type,
            DB_RES_ARTWORK
                | DB_RES_WAVEFORM_PREVIEW
                | DB_RES_WAVEFORM_DETAIL
                | DB_RES_EXT_2504
                | DB_RES_BEAT_GRID
        )
    {
        return empty_blob_response(tx_id, req_type, res_type, false);
    }
    let mut data = data.unwrap_or_default().to_vec();
    if res_type == DB_RES_ANLZ_TAG {
        let mut wrapped = (data.len() as u32).to_le_bytes().to_vec();
        wrapped.append(&mut data);
        data = wrapped;
    }
    let has_blob = !data.is_empty();
    let mut fields = vec![
        DbValue::Int32(req_type as u32),
        DbValue::Int32(0),
        DbValue::Int32(data.len() as u32),
        DbValue::Binary(data),
    ];
    if !matches!(
        res_type,
        DB_RES_ARTWORK
            | DB_RES_WAVEFORM_PREVIEW
            | DB_RES_WAVEFORM_DETAIL
            | DB_RES_EXT_2504
            | DB_RES_BEAT_GRID
    ) {
        fields.push(DbValue::Int32(if res_type == DB_RES_ANLZ_TAG {
            1
        } else if res_type == DB_RES_CUE_POINTS_EXT && has_blob {
            1
        } else {
            0
        }));
    }
    encode_db_message(tx_id, res_type, &fields)
}

pub(crate) fn empty_blob_response(
    tx_id: u32,
    req_type: u16,
    res_type: u16,
    success_flag: bool,
) -> Vec<u8> {
    let mut arg_types = vec![
        DB_MSG_FIELD_INT32,
        DB_MSG_FIELD_INT32,
        DB_MSG_FIELD_INT32,
        DB_MSG_FIELD_BINARY,
    ];
    if success_flag {
        arg_types.push(DB_MSG_FIELD_INT32);
    }
    let mut out = Vec::new();
    out.extend_from_slice(&encode_db_field(&DbValue::Int32(DB_MAGIC)));
    out.extend_from_slice(&encode_db_field(&DbValue::Int32(tx_id)));
    out.extend_from_slice(&encode_db_field(&DbValue::Int16(res_type)));
    out.extend_from_slice(&encode_db_field(&DbValue::Int8(arg_types.len() as u8)));
    out.extend_from_slice(&encode_db_field(&DbValue::Binary(arg_types)));
    out.extend_from_slice(&encode_db_field(&DbValue::Int32(req_type as u32)));
    out.extend_from_slice(&encode_db_field(&DbValue::Int32(0)));
    out.extend_from_slice(&encode_db_field(&DbValue::Int32(0)));
    if success_flag {
        out.extend_from_slice(&encode_db_field(&DbValue::Int32(0)));
    }
    out
}

fn utf16_size(value: &str) -> usize {
    value.encode_utf16().count() * 2 + 2
}

pub(crate) fn utf16be_z_bytes(value: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(utf16_size(value));
    for unit in value.encode_utf16() {
        out.extend_from_slice(&unit.to_be_bytes());
    }
    out.extend_from_slice(&0u16.to_be_bytes());
    out
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct RenderWindow {
    pub(crate) offset: usize,
    pub(crate) count: usize,
    pub(crate) total: usize,
}

#[derive(Default)]
pub(crate) struct PendingRenderSession {
    key: Option<u32>,
    entries: Vec<MenuEntry>,
}

impl PendingRenderSession {
    pub(crate) fn prepare(&mut self, key: Option<u32>, entries: Vec<MenuEntry>) {
        self.key = key;
        self.entries = entries;
    }

    pub(crate) fn entries_for_render(
        &self,
        key: Option<u32>,
        window: RenderWindow,
    ) -> Option<&[MenuEntry]> {
        (self.key == key && render_entries_match(&self.entries, window))
            .then_some(self.entries.as_slice())
    }

    pub(crate) fn key(&self) -> Option<u32> {
        self.key
    }

    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }
}

fn render_entries_match(entries: &[MenuEntry], window: RenderWindow) -> bool {
    if window.total > 0 {
        entries.len() == window.total
    } else {
        window.offset.saturating_add(window.count) <= entries.len()
    }
}

#[cfg(test)]
mod tests {
    use std::net::Ipv4Addr;
    use std::time::Duration;

    use tokio::io::AsyncWriteExt;
    use tokio::net::{TcpListener, TcpStream};

    use super::*;
    use crate::protocol::decode_hex;

    #[tokio::test]
    async fn waveform_preview_omitted_blob_does_not_wait_for_the_next_request() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .expect("listener");
        let addr = listener.local_addr().expect("listener address");
        let (client, accepted) = tokio::join!(TcpStream::connect(addr), listener.accept());
        let mut client = client.expect("client");
        let (mut server, _) = accepted.expect("server");
        let request = decode_hex(
            "11872349ae110000072c1020040f051400000005060606060311030804011100000000110330daf41100000000",
        );
        client.write_all(&request).await.expect("request");

        let message =
            tokio::time::timeout(Duration::from_millis(100), recv_db_message(&mut server))
                .await
                .expect("parser must not await a follow-up byte")
                .expect("waveform request");

        assert_eq!(message.tx_id, 0x072c);
        assert_eq!(message.msg_type, DB_REQ_WAVEFORM_PREVIEW);
        assert_eq!(message.args.len(), 5);
        assert_eq!(message.args.last(), Some(&DbValue::Binary(Vec::new())));
    }

    #[tokio::test]
    async fn parses_captured_cdj3000_incremental_search() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .expect("listener");
        let addr = listener.local_addr().expect("listener address");
        let (client, accepted) = tokio::join!(TcpStream::connect(addr), listener.accept());
        let mut client = client.expect("client");
        let (mut server, _) = accepted.expect("server");
        let request = decode_hex(
            include_str!("../tests/fixtures/remotedb-cdj3000-incremental-search-rafa.hex").trim(),
        );
        client.write_all(&request).await.expect("request");

        let message =
            tokio::time::timeout(Duration::from_millis(100), recv_db_message(&mut server))
                .await
                .expect("incremental search parser deadline")
                .expect("incremental search request");

        assert_eq!(message.tx_id, 0x09aa);
        assert_eq!(message.msg_type, DB_REQ_INCREMENTAL_SEARCH);
        assert_eq!(
            message.args,
            vec![
                DbValue::Int32(0x0301_0401),
                DbValue::Int32(SORT_DEFAULT),
                DbValue::Int32(10),
                DbValue::String("RAFA".to_string()),
            ]
        );
    }
}
