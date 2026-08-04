use std::collections::{BTreeMap, VecDeque};

use crate::db::{
    DB_FIELD_BINARY, DB_FIELD_INT8, DB_FIELD_INT16, DB_FIELD_INT32, DB_FIELD_STRING, DB_MAGIC,
    DB_MSG_FIELD_BINARY, DB_REQ_RENDER, DB_RES_MENU_HEADER, DbMessage, DbValue, db_int,
    parse_render_window, rmst_from_args,
};

const DB_MAGIC_FIELD: [u8; 5] = [
    DB_FIELD_INT32,
    (DB_MAGIC >> 24) as u8,
    (DB_MAGIC >> 16) as u8,
    (DB_MAGIC >> 8) as u8,
    DB_MAGIC as u8,
];

/// One RemoteDB RENDER request and its same-transaction MENU_HEADER response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteDbCursorExchange {
    pub tx_id: u32,
    pub rmst: Option<u32>,
    pub requested_offset: u32,
    pub requested_count: u32,
    pub requested_total: u32,
    pub header_marker: Option<u32>,
    pub header_offset: Option<u32>,
}

impl RemoteDbCursorExchange {
    /// True when a MENU_HEADER has the native marker and echoes the requested render offset.
    pub fn matches(&self) -> bool {
        self.header_marker == Some(1) && self.header_offset == Some(self.requested_offset)
    }
}

/// Cursor-level RemoteDB audit decoded from one bidirectional TCP byte stream.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RemoteDbCursorAudit {
    pub decoded_requests: usize,
    pub decoded_responses: usize,
    pub exchanges: Vec<RemoteDbCursorExchange>,
    pub headers_without_render: usize,
}

impl RemoteDbCursorAudit {
    /// Number of RENDER requests using a nonzero cursor.
    pub fn nonzero_requests(&self) -> usize {
        self.exchanges
            .iter()
            .filter(|exchange| exchange.requested_offset != 0)
            .count()
    }

    /// Number of RENDER requests whose response header echoes the cursor.
    pub fn matching_headers(&self) -> usize {
        self.exchanges
            .iter()
            .filter(|exchange| exchange.matches())
            .count()
    }

    /// Number of RENDER requests with a response header carrying another cursor.
    pub fn mismatched_headers(&self) -> usize {
        self.exchanges
            .iter()
            .filter(|exchange| exchange.header_offset.is_some() && !exchange.matches())
            .count()
    }

    /// Number of RENDER requests without a decoded same-transaction header.
    pub fn missing_headers(&self) -> usize {
        self.exchanges
            .iter()
            .filter(|exchange| exchange.header_offset.is_none())
            .count()
    }

    /// True when at least one nonzero cursor was exercised and every render header matched.
    pub fn complete(&self) -> bool {
        self.nonzero_requests() > 0
            && self.matching_headers() == self.exchanges.len()
            && self.mismatched_headers() == 0
            && self.missing_headers() == 0
    }
}

/// Decode and correlate RemoteDB cursor exchanges from request/response TCP bytes.
///
/// Inputs must be reassembled per TCP direction. Leading setup bytes and unrelated payloads are
/// tolerated: decoding resumes at each typed RemoteDB magic field.
pub fn audit_remote_db_cursors(request_bytes: &[u8], response_bytes: &[u8]) -> RemoteDbCursorAudit {
    let requests = decode_db_messages(request_bytes);
    let responses = decode_db_messages(response_bytes);
    let mut headers = BTreeMap::<u32, VecDeque<(u32, u32)>>::new();
    let mut header_count = 0usize;
    for response in &responses {
        if response.msg_type != DB_RES_MENU_HEADER {
            continue;
        }
        let (Some(marker), Some(offset)) =
            (db_int(response.args.first()), db_int(response.args.get(1)))
        else {
            continue;
        };
        headers
            .entry(response.tx_id)
            .or_default()
            .push_back((marker, offset));
        header_count += 1;
    }

    let mut exchanges = Vec::new();
    for request in &requests {
        if request.msg_type != DB_REQ_RENDER {
            continue;
        }
        let window = parse_render_window(&request.args);
        let header = headers
            .get_mut(&request.tx_id)
            .and_then(VecDeque::pop_front);
        exchanges.push(RemoteDbCursorExchange {
            tx_id: request.tx_id,
            rmst: rmst_from_args(&request.args),
            requested_offset: window.offset.min(u32::MAX as usize) as u32,
            requested_count: window.count.min(u32::MAX as usize) as u32,
            requested_total: window.total.min(u32::MAX as usize) as u32,
            header_marker: header.map(|(marker, _)| marker),
            header_offset: header.map(|(_, offset)| offset),
        });
    }
    let matched_header_count = exchanges
        .iter()
        .filter(|exchange| exchange.header_offset.is_some())
        .count();
    RemoteDbCursorAudit {
        decoded_requests: requests.len(),
        decoded_responses: responses.len(),
        exchanges,
        headers_without_render: header_count.saturating_sub(matched_header_count),
    }
}

fn decode_db_messages(bytes: &[u8]) -> Vec<DbMessage> {
    let mut messages = Vec::new();
    let mut search_from = 0usize;
    while let Some(relative) = bytes
        .get(search_from..)
        .and_then(|remaining| find_bytes(remaining, &DB_MAGIC_FIELD))
    {
        let offset = search_from + relative;
        match decode_db_message(bytes, offset) {
            Some((message, next)) => {
                messages.push(message);
                search_from = next.max(offset + 1);
            }
            None => search_from = offset + 1,
        }
    }
    messages
}

fn decode_db_message(bytes: &[u8], offset: usize) -> Option<(DbMessage, usize)> {
    let (DbValue::Int32(magic), mut cursor) = decode_db_field(bytes, offset)? else {
        return None;
    };
    if magic != DB_MAGIC {
        return None;
    }
    let (DbValue::Int32(tx_id), next) = decode_db_field(bytes, cursor)? else {
        return None;
    };
    cursor = next;
    let (DbValue::Int16(msg_type), next) = decode_db_field(bytes, cursor)? else {
        return None;
    };
    cursor = next;
    let (DbValue::Int8(argc), next) = decode_db_field(bytes, cursor)? else {
        return None;
    };
    cursor = next;
    let (DbValue::Binary(arg_types), next) = decode_db_field(bytes, cursor)? else {
        return None;
    };
    cursor = next;
    if arg_types.len() < argc as usize {
        return None;
    }

    let mut args = Vec::with_capacity(argc as usize);
    for arg_type in arg_types.into_iter().take(argc as usize) {
        if arg_type == DB_MSG_FIELD_BINARY && bytes.get(cursor) != Some(&DB_FIELD_BINARY) {
            args.push(DbValue::Binary(Vec::new()));
            continue;
        }
        let (value, next) = decode_db_field(bytes, cursor)?;
        cursor = next;
        args.push(value);
    }
    Some((
        DbMessage {
            tx_id,
            msg_type,
            args,
        },
        cursor,
    ))
}

fn decode_db_field(bytes: &[u8], offset: usize) -> Option<(DbValue, usize)> {
    match *bytes.get(offset)? {
        DB_FIELD_INT8 => Some((DbValue::Int8(*bytes.get(offset + 1)?), offset + 2)),
        DB_FIELD_INT16 => {
            let raw = bytes.get(offset + 1..offset + 3)?;
            Some((
                DbValue::Int16(u16::from_be_bytes([raw[0], raw[1]])),
                offset + 3,
            ))
        }
        DB_FIELD_INT32 => {
            let raw = bytes.get(offset + 1..offset + 5)?;
            Some((
                DbValue::Int32(u32::from_be_bytes([raw[0], raw[1], raw[2], raw[3]])),
                offset + 5,
            ))
        }
        DB_FIELD_BINARY => {
            let raw_len = bytes.get(offset + 1..offset + 5)?;
            let len = u32::from_be_bytes([raw_len[0], raw_len[1], raw_len[2], raw_len[3]]) as usize;
            let end = offset.checked_add(5)?.checked_add(len)?;
            Some((DbValue::Binary(bytes.get(offset + 5..end)?.to_vec()), end))
        }
        DB_FIELD_STRING => {
            let raw_units = bytes.get(offset + 1..offset + 5)?;
            let units = u32::from_be_bytes([raw_units[0], raw_units[1], raw_units[2], raw_units[3]])
                as usize;
            let byte_len = units.checked_mul(2)?;
            let end = offset.checked_add(5)?.checked_add(byte_len)?;
            let raw = bytes.get(offset + 5..end)?;
            let text_units = raw
                .chunks_exact(2)
                .take(units.saturating_sub(1))
                .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
                .collect::<Vec<_>>();
            Some((DbValue::String(String::from_utf16_lossy(&text_units)), end))
        }
        _ => None,
    }
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[cfg(test)]
mod tests {
    use crate::db::{DbValue, encode_db_message};

    use super::*;

    fn render_request(tx_id: u32, offset: u32) -> Vec<u8> {
        encode_db_message(
            tx_id,
            DB_REQ_RENDER,
            &[
                DbValue::Int32(0x0305_0401),
                DbValue::Int32(offset),
                DbValue::Int32(1),
                DbValue::Int32(0),
                DbValue::Int32(17),
            ],
        )
    }

    fn menu_header(tx_id: u32, offset: u32) -> Vec<u8> {
        encode_db_message(
            tx_id,
            DB_RES_MENU_HEADER,
            &[DbValue::Int32(1), DbValue::Int32(offset)],
        )
    }

    fn fixture(name: &str) -> Vec<u8> {
        let raw = match name {
            "render" => include_str!("../tests/fixtures/remotedb-render-offset-2.hex"),
            "header" => include_str!("../tests/fixtures/remotedb-menu-header-offset-2.hex"),
            _ => panic!("unknown fixture"),
        }
        .trim();
        raw.as_bytes()
            .chunks_exact(2)
            .map(|pair| {
                u8::from_str_radix(std::str::from_utf8(pair).expect("ASCII"), 16).expect("hex")
            })
            .collect()
    }

    #[test]
    fn accepts_exact_native_capture_cursor_exchange() {
        let audit = audit_remote_db_cursors(&fixture("render"), &fixture("header"));

        assert!(audit.complete());
        assert_eq!(
            audit.exchanges,
            [RemoteDbCursorExchange {
                tx_id: 0x1883,
                rmst: Some(0x0103_0401),
                requested_offset: 2,
                requested_count: 1,
                requested_total: 15_227,
                header_marker: Some(1),
                header_offset: Some(2),
            }]
        );
    }

    #[test]
    fn accepts_native_nonzero_cursor_echo() {
        let audit = audit_remote_db_cursors(&render_request(0x1883, 2), &menu_header(0x1883, 2));

        assert!(audit.complete());
        assert_eq!(audit.nonzero_requests(), 1);
        assert_eq!(audit.matching_headers(), 1);
        assert_eq!(audit.exchanges[0].rmst, Some(0x0305_0401));
        assert_eq!(audit.exchanges[0].requested_total, 17);
    }

    #[test]
    fn rejects_stale_zero_header_for_nonzero_render() {
        let audit = audit_remote_db_cursors(&render_request(0x05f3, 2), &menu_header(0x05f3, 0));

        assert!(!audit.complete());
        assert_eq!(audit.mismatched_headers(), 1);
        assert_eq!(audit.exchanges[0].requested_offset, 2);
        assert_eq!(audit.exchanges[0].header_offset, Some(0));
    }

    #[test]
    fn rejects_non_native_menu_header_marker() {
        let response = encode_db_message(
            9,
            DB_RES_MENU_HEADER,
            &[DbValue::Int32(0), DbValue::Int32(2)],
        );
        let audit = audit_remote_db_cursors(&render_request(9, 2), &response);

        assert!(!audit.complete());
        assert_eq!(audit.mismatched_headers(), 1);
        assert_eq!(audit.exchanges[0].header_marker, Some(0));
    }

    #[test]
    fn correlates_by_transaction_and_tolerates_setup_noise() {
        let mut requests = vec![0x11, 0, 0, 0, 3, 0xaa, 0xbb];
        requests.extend_from_slice(&render_request(0x1001, 1));
        requests.extend_from_slice(&render_request(0x1002, 2));
        let mut responses = menu_header(0x1002, 2);
        responses.extend_from_slice(&menu_header(0x1001, 1));

        let audit = audit_remote_db_cursors(&requests, &responses);

        assert!(audit.complete());
        assert_eq!(audit.exchanges.len(), 2);
        assert_eq!(audit.exchanges[0].header_offset, Some(1));
        assert_eq!(audit.exchanges[1].header_offset, Some(2));
    }

    #[test]
    fn reports_missing_and_unpaired_headers() {
        let audit = audit_remote_db_cursors(&render_request(1, 1), &menu_header(2, 2));

        assert!(!audit.complete());
        assert_eq!(audit.missing_headers(), 1);
        assert_eq!(audit.headers_without_render, 1);
    }
}
