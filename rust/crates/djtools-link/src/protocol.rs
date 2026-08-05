use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) mod keepalive;
pub(crate) mod stagehand;
pub(crate) mod status;

pub const DJLINK_MAGIC: &[u8; 10] = b"Qspt1WmJOL";

#[derive(Debug)]
pub(crate) struct RpcCall {
    pub(crate) xid: u32,
    pub(crate) prog: u32,
    pub(crate) vers: u32,
    pub(crate) proc: u32,
    pub(crate) payload_off: usize,
}

pub(crate) fn rpc_parse_call(data: &[u8]) -> Option<RpcCall> {
    if data.len() < 24 {
        return None;
    }
    let xid = be_u32(&data[0..4]);
    let msg_type = be_u32(&data[4..8]);
    let rpc_vers = be_u32(&data[8..12]);
    if msg_type != 0 || rpc_vers != 2 {
        return None;
    }
    let prog = be_u32(&data[12..16]);
    let vers = be_u32(&data[16..20]);
    let proc = be_u32(&data[20..24]);
    let mut off = 24;
    off += 4;
    let cred_len = be_u32(data.get(off..off + 4)?) as usize;
    off += 4 + xdr_padded_len(cred_len);
    off += 4;
    let verf_len = be_u32(data.get(off..off + 4)?) as usize;
    off += 4 + xdr_padded_len(verf_len);
    Some(RpcCall {
        xid,
        prog,
        vers,
        proc,
        payload_off: off,
    })
}

pub(crate) fn rpc_reply_header(xid: u32) -> Vec<u8> {
    [xid, 1, 0, 0, 0, 0]
        .into_iter()
        .flat_map(|value| value.to_be_bytes())
        .collect()
}

pub(crate) fn xdr_encode_string(value: &str) -> Vec<u8> {
    xdr_encode_opaque(value.as_bytes())
}

pub(crate) fn xdr_encode_opaque(raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&(raw.len() as u32).to_be_bytes());
    out.extend_from_slice(raw);
    out.resize((out.len() + 3) & !3, 0);
    out
}

pub(crate) fn xdr_decode_opaque(data: &[u8], off: usize) -> Option<(Vec<u8>, usize)> {
    let len = be_u32(data.get(off..off + 4)?) as usize;
    let start = off + 4;
    let end = start.checked_add(len)?;
    let raw = data.get(start..end)?.to_vec();
    Some((raw, end + ((4 - len % 4) % 4)))
}

pub(crate) enum NameEncoding {
    Utf8,
    Auto,
}

pub(crate) fn xdr_decode_string(
    data: &[u8],
    off: usize,
    encoding: NameEncoding,
) -> (String, usize) {
    let Some((raw, off)) = xdr_decode_opaque(data, off) else {
        return (String::new(), off);
    };
    let value = match encoding {
        NameEncoding::Utf8 => String::from_utf8_lossy(&raw).to_string(),
        NameEncoding::Auto => decode_nfs_name(&raw),
    };
    (value.trim_end_matches('\0').to_string(), off)
}

pub(crate) fn decode_nfs_name(raw: &[u8]) -> String {
    if raw.len() >= 2 && raw.len() % 2 == 0 && raw.chunks_exact(2).any(|pair| pair[1] == 0) {
        let units = raw
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .take_while(|unit| *unit != 0)
            .collect::<Vec<_>>();
        return String::from_utf16_lossy(&units);
    }
    String::from_utf8_lossy(raw).to_string()
}

pub(crate) fn xdr_padded_len(len: usize) -> usize {
    (len + 3) & !3
}

pub(crate) fn be_u32(raw: &[u8]) -> u32 {
    u32::from_be_bytes([raw[0], raw[1], raw[2], raw[3]])
}

pub(crate) fn be_u24(raw: &[u8]) -> u32 {
    u32::from_be_bytes([0, raw[0], raw[1], raw[2]])
}

pub(crate) fn be_u64(raw: &[u8]) -> u64 {
    u64::from_be_bytes([
        raw[0], raw[1], raw[2], raw[3], raw[4], raw[5], raw[6], raw[7],
    ])
}

pub(crate) fn unix_now() -> u32 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as u32
}

pub(crate) fn decode_hex(input: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(input.len() / 2);
    let bytes = input.as_bytes();
    for i in (0..bytes.len()).step_by(2) {
        let hi = hex_val(bytes[i]);
        let lo = hex_val(bytes[i + 1]);
        out.push((hi << 4) | lo);
    }
    out
}

fn hex_val(byte: u8) -> u8 {
    match byte {
        b'0'..=b'9' => byte - b'0',
        b'a'..=b'f' => byte - b'a' + 10,
        b'A'..=b'F' => byte - b'A' + 10,
        _ => 0,
    }
}
