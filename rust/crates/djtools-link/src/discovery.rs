//! Bounded hints for unicast discovery. A hint is never proof of a DJ Link peer.
use std::{net::Ipv4Addr, path::Path};

pub(crate) const MAX_PEERS: usize = 32;

pub(crate) fn usable_peer(local: Ipv4Addr, mask: Ipv4Addr, peer: Ipv4Addr) -> bool {
    let local = u32::from(local);
    let mask = u32::from(mask);
    let peer = u32::from(peer);
    let network = local & mask;
    peer != local && peer & mask == network && peer != network && peer != (network | !mask)
}

pub(crate) async fn cached_peers(path: Option<&Path>) -> Vec<Ipv4Addr> {
    let Some(path) = path else { return vec![] };
    let Ok(metadata) = tokio::fs::metadata(path).await else {
        return vec![];
    };
    if metadata.len() > 4096 {
        return vec![];
    }
    let Ok(bytes) = tokio::fs::read(path).await else {
        return vec![];
    };
    serde_json::from_slice::<Vec<Ipv4Addr>>(&bytes)
        .unwrap_or_default()
        .into_iter()
        .take(MAX_PEERS)
        .collect()
}

pub(crate) async fn save_peers(path: Option<&Path>, peers: &[Ipv4Addr]) -> std::io::Result<()> {
    let Some(path) = path else { return Ok(()) };
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let temporary = path.with_extension("tmp");
    tokio::fs::write(
        &temporary,
        serde_json::to_vec(&peers[..peers.len().min(MAX_PEERS)])?,
    )
    .await?;
    tokio::fs::rename(temporary, path).await
}

/// Only resolved neighbours on the selected interface. iOS may deny route-table
/// access; that is an optional hint failure, never a discovery failure.
#[cfg(target_vendor = "apple")]
pub(crate) fn neighbours(interface: Option<&str>) -> std::io::Result<Vec<Ipv4Addr>> {
    let Some(interface) = interface else {
        return Ok(vec![]);
    };
    let name = std::ffi::CString::new(interface)?;
    let index = unsafe { libc::if_nametoindex(name.as_ptr()) };
    if index == 0 {
        return Err(std::io::Error::last_os_error());
    }
    let mut mib = [
        libc::CTL_NET,
        libc::PF_ROUTE,
        0,
        libc::AF_INET,
        libc::NET_RT_FLAGS,
        libc::RTF_LLINFO,
    ];
    let mut size = 0;
    if unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            6,
            std::ptr::null_mut(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    } != 0
    {
        return Err(std::io::Error::last_os_error());
    }
    if size > 4 * 1024 * 1024 {
        return Ok(vec![]);
    }
    let mut bytes = vec![0u8; size];
    if unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            6,
            bytes.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    } != 0
    {
        return Err(std::io::Error::last_os_error());
    }
    Ok(parse_neighbours(&bytes[..size], index))
}

#[cfg(not(target_vendor = "apple"))]
pub(crate) fn neighbours(_: Option<&str>) -> std::io::Result<Vec<Ipv4Addr>> {
    Ok(vec![])
}

#[cfg(target_vendor = "apple")]
fn parse_neighbours(mut bytes: &[u8], index: u32) -> Vec<Ipv4Addr> {
    let mut peers = Vec::new();
    let header_size = std::mem::size_of::<libc::rt_msghdr>();
    while bytes.len() >= header_size {
        // Route messages are kernel ABI structs, not naturally aligned in Vec<u8>.
        let header = unsafe { std::ptr::read_unaligned(bytes.as_ptr().cast::<libc::rt_msghdr>()) };
        let length = header.rtm_msglen as usize;
        if length < header_size || length > bytes.len() {
            break;
        }
        let (message, rest) = bytes.split_at(length);
        bytes = rest;
        if header.rtm_index as u32 != index || header.rtm_flags & libc::RTF_LLINFO == 0 {
            continue;
        }
        let mut addresses = &message[header_size..];
        let mut ip = None;
        let mut resolved = false;
        for slot in 0..libc::RTAX_MAX {
            if header.rtm_addrs & (1 << slot) == 0 {
                continue;
            }
            if addresses.len() < 2 {
                break;
            }
            let length = addresses[0] as usize;
            let padded = (length.max(1) + 3) & !3;
            if padded > addresses.len() || length < 2 {
                break;
            }
            let address = &addresses[..length];
            if slot == libc::RTAX_DST && address[1] == libc::AF_INET as u8 && length >= 8 {
                ip = Some(Ipv4Addr::new(
                    address[4], address[5], address[6], address[7],
                ));
            }
            if slot == libc::RTAX_GATEWAY && address[1] == libc::AF_LINK as u8 && length >= 8 {
                let start = 8 + address[5] as usize;
                resolved = address[6] == 6
                    && address
                        .get(start..start + 6)
                        .is_some_and(|mac| mac.iter().any(|byte| *byte != 0));
            }
            addresses = &addresses[padded..];
        }
        if resolved
            && let Some(ip) = ip
            && !peers.contains(&ip)
        {
            peers.push(ip);
        }
    }
    peers.truncate(MAX_PEERS);
    peers
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_vendor = "apple")]
    #[test]
    fn route_hints_require_resolved_mac_and_the_selected_interface() {
        let mut bytes = vec![0; std::mem::size_of::<libc::rt_msghdr>()];
        // Build the ABI fixture field-by-field, keeping padding initialized.
        macro_rules! field {
            ($name:ident, $value:expr) => {{
                let offset = std::mem::offset_of!(libc::rt_msghdr, $name);
                let value = $value.to_ne_bytes();
                bytes[offset..offset + value.len()].copy_from_slice(&value);
            }};
        }
        field!(
            rtm_msglen,
            (std::mem::size_of::<libc::rt_msghdr>() + 36) as u16
        );
        field!(rtm_index, 12u16);
        field!(rtm_flags, libc::RTF_LLINFO);
        field!(
            rtm_addrs,
            (1i32 << libc::RTAX_DST) | (1i32 << libc::RTAX_GATEWAY)
        );
        bytes.extend([
            16,
            libc::AF_INET as u8,
            0,
            0,
            169,
            254,
            6,
            175,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
        ]);
        bytes.extend([
            20,
            libc::AF_LINK as u8,
            12,
            0,
            6,
            3,
            6,
            0,
            b'e',
            b'n',
            b'5',
            1,
            2,
            3,
            4,
            5,
            6,
            0,
            0,
            0,
        ]);
        let deck = Ipv4Addr::new(169, 254, 6, 175);
        assert_eq!(parse_neighbours(&bytes, 12), [deck]);
        assert!(parse_neighbours(&bytes, 13).is_empty());
        let mut unaligned = vec![0];
        unaligned.extend(&bytes);
        assert_eq!(parse_neighbours(&unaligned[1..], 12), [deck]);
        for length in 0..bytes.len() {
            assert!(parse_neighbours(&bytes[..length], 12).is_empty());
        }
        let mac = bytes.len() - 9;
        bytes[mac..mac + 6].fill(0);
        assert!(parse_neighbours(&bytes, 12).is_empty());
    }

    #[tokio::test]
    async fn cache_survives_restart_but_never_expands_scan_scope() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("peers.json");
        let local = Ipv4Addr::new(169, 254, 65, 9);
        let mask = Ipv4Addr::new(255, 255, 0, 0);
        let deck = Ipv4Addr::new(169, 254, 6, 175);
        save_peers(Some(&path), &[deck, local, Ipv4Addr::new(10, 0, 0, 3)])
            .await
            .unwrap();
        assert_eq!(
            cached_peers(Some(&path))
                .await
                .into_iter()
                .filter(|peer| usable_peer(local, mask, *peer))
                .collect::<Vec<_>>(),
            [deck]
        );
        assert!(!usable_peer(local, mask, Ipv4Addr::new(169, 254, 0, 0)));
        assert!(!usable_peer(local, mask, Ipv4Addr::new(169, 254, 255, 255)));
        tokio::fs::write(&path, b"truncated cache").await.unwrap();
        assert!(cached_peers(Some(&path)).await.is_empty());
    }
}
