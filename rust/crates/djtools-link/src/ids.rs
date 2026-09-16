use std::path::Path;

pub(crate) fn stable_id(path: &Path) -> u32 {
    let mut hash = 0x811c_9dc5u32;
    for byte in path.to_string_lossy().as_bytes() {
        hash ^= *byte as u32;
        hash = hash.wrapping_mul(0x0100_0193);
    }
    (hash & 0x7fff_ffff).max(1)
}

pub fn stable_text_id(value: &str) -> u32 {
    if value.trim().is_empty() {
        return 0;
    }
    let mut hash = 0x811c_9dc5u32;
    for byte in value.as_bytes() {
        hash ^= *byte as u32;
        hash = hash.wrapping_mul(0x0100_0193);
    }
    (hash & 0x7fff_ffff).max(1)
}
