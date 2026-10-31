//! Bounded hints for unicast discovery. A hint is never proof of a DJ Link peer.
use std::{net::Ipv4Addr, path::Path};

pub(crate) const MAX_PEERS: usize = 32;

/// One bounded batch per 125 ms. Finish the first pass even if a mixer or one
/// deck responds early: that response says nothing about the remaining decks.
/// Later passes back off once a deck is present.
pub(crate) fn sweep_batch(tick: u64, swept: bool, has_deck: bool) -> usize {
    if !swept || !has_deck {
        64
    } else if tick.is_multiple_of(16) {
        16
    } else {
        0
    }
}

pub(crate) fn priority_due(tick: u64) -> bool {
    // Cached and lost peers remain responsive even during a long subnet sweep.
    tick.is_multiple_of(2)
}

pub(crate) fn neighbours_due(tick: u64, elapsed: std::time::Duration) -> bool {
    // IPv4 can appear before the USB peer enters the neighbour table.
    tick.is_multiple_of(if elapsed < std::time::Duration::from_secs(5) {
        2
    } else {
        8
    })
}

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
