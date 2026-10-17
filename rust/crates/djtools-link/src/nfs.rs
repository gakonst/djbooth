use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Instant, UNIX_EPOCH};

use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tracing::{trace, warn};

use crate::ids::stable_id;
use crate::protocol::{
    NameEncoding, be_u32, be_u64, rpc_parse_call, rpc_reply_header, unix_now, xdr_decode_opaque,
    xdr_decode_string, xdr_encode_opaque, xdr_encode_string,
};

pub const NFS_PORT: u16 = 2049;
pub(crate) const NFS_FHSIZE: usize = 32;
pub(crate) const NFS_ROOT_FH: [u8; NFS_FHSIZE] = [0; NFS_FHSIZE];
pub(crate) const NFS_READ_CHUNK_MAX: usize = 64_512;

pub(crate) const RPC_PORTMAP_PROG: u32 = 100000;
pub(crate) const RPC_MOUNT_PROG: u32 = 100005;
pub(crate) const RPC_NFS_PROG: u32 = 100003;
pub(crate) const PORTMAP_GETPORT: u32 = 3;
pub(crate) const MOUNT_NULL: u32 = 0;
pub(crate) const MOUNT_MNT: u32 = 1;
pub(crate) const MOUNT_UMNT: u32 = 3;
pub(crate) const MOUNT_EXPORT: u32 = 5;
pub(crate) const NFS2_GETATTR: u32 = 1;
pub(crate) const NFS2_LOOKUP: u32 = 4;
pub(crate) const NFS2_READ: u32 = 6;
pub(crate) const NFS3_GETATTR: u32 = 1;
pub(crate) const NFS3_LOOKUP: u32 = 3;
pub(crate) const NFS3_ACCESS: u32 = 4;
pub(crate) const NFS3_READ: u32 = 6;
pub(crate) const NFS_REG: u32 = 1;
pub(crate) const NFS_DIR: u32 = 2;
pub(crate) const NFS_OK: u32 = 0;
pub(crate) const NFSERR_NOENT: u32 = 2;
pub(crate) const NFSERR_IO: u32 = 5;
pub(crate) const NFSERR_STALE: u32 = 70;

#[allow(async_fn_in_trait)]
pub(crate) trait NfsContext {
    fn bind_ip(&self) -> Ipv4Addr;
    async fn nfs_resolve_child(&self, parent: &Path, name: &str) -> PathBuf {
        resolve_child_path(parent, name).await
    }
    async fn nfs_handle_for_path(&self, path: &Path, parent_fh: Option<&[u8]>) -> Option<Vec<u8>>;
    async fn nfs_path_for_handle(&self, fh: &[u8]) -> Option<PathBuf>;
    async fn nfs_read_chunk(
        &self,
        path: &Path,
        offset: u64,
        count: usize,
    ) -> std::io::Result<Vec<u8>>;
    async fn note_nfs_audio_progress(&self, addr: SocketAddr, path: &Path, offset: u64);
}

impl<T: NfsContext + ?Sized> NfsContext for Arc<T> {
    fn bind_ip(&self) -> Ipv4Addr {
        self.as_ref().bind_ip()
    }

    async fn nfs_resolve_child(&self, parent: &Path, name: &str) -> PathBuf {
        self.as_ref().nfs_resolve_child(parent, name).await
    }

    async fn nfs_handle_for_path(&self, path: &Path, parent_fh: Option<&[u8]>) -> Option<Vec<u8>> {
        self.as_ref().nfs_handle_for_path(path, parent_fh).await
    }

    async fn nfs_path_for_handle(&self, fh: &[u8]) -> Option<PathBuf> {
        self.as_ref().nfs_path_for_handle(fh).await
    }

    async fn nfs_read_chunk(
        &self,
        path: &Path,
        offset: u64,
        count: usize,
    ) -> std::io::Result<Vec<u8>> {
        self.as_ref().nfs_read_chunk(path, offset, count).await
    }

    async fn note_nfs_audio_progress(&self, addr: SocketAddr, path: &Path, offset: u64) {
        self.as_ref()
            .note_nfs_audio_progress(addr, path, offset)
            .await;
    }
}

pub(crate) struct NfsState {
    handles: HashMap<Vec<u8>, PathBuf>,
    path_to_fh: HashMap<PathBuf, Vec<u8>>,
}

impl Default for NfsState {
    fn default() -> Self {
        let mut state = Self {
            handles: HashMap::new(),
            path_to_fh: HashMap::new(),
        };
        state
            .handles
            .insert(NFS_ROOT_FH.to_vec(), PathBuf::from("/"));
        state
            .path_to_fh
            .insert(PathBuf::from("/"), NFS_ROOT_FH.to_vec());
        state
    }
}

impl NfsState {
    pub(crate) fn extend_exports(&mut self, added: Self) {
        for (handle, path) in added.handles {
            self.handles.entry(handle).or_insert(path);
        }
        for (path, handle) in added.path_to_fh {
            self.path_to_fh.entry(path).or_insert(handle);
        }
    }

    pub(crate) fn from_exports(paths: &std::collections::HashSet<PathBuf>) -> Self {
        let mut state = Self::default();
        for path in paths {
            if path == Path::new("/") {
                continue;
            }
            // Decks retain handles across server restarts. Restore both normal
            // component LOOKUP and absolute-path LOOKUP from the export root.
            let parent_id = path
                .parent()
                .filter(|parent| *parent != Path::new("/"))
                .map(|parent| stable_id(parent).max(1))
                .unwrap_or(0);
            let mut parent = NFS_ROOT_FH;
            parent[..4].copy_from_slice(&parent_id.to_be_bytes());
            let mut fh = state.handle_for_path(path, Some(&parent));
            fh[4..8].fill(0);
            state.handles.insert(fh, path.clone());
        }
        state
    }

    pub(crate) fn handle_for_path(&mut self, path: &Path, parent_fh: Option<&[u8]>) -> Vec<u8> {
        if let Some(existing) = self.path_to_fh.get(path) {
            return existing.clone();
        }
        if path == Path::new("/") || parent_fh.is_none() {
            let fh = NFS_ROOT_FH.to_vec();
            self.handles.insert(fh.clone(), path.to_path_buf());
            self.path_to_fh.insert(path.to_path_buf(), fh.clone());
            return fh;
        }
        let parent_id = parent_fh
            .and_then(|fh| fh.get(0..4))
            .map(|raw| u32::from_be_bytes([raw[0], raw[1], raw[2], raw[3]]))
            .unwrap_or(0);
        let node_id = stable_id(path).max(1);
        let mut fh = Vec::with_capacity(NFS_FHSIZE);
        fh.extend_from_slice(&node_id.to_be_bytes());
        fh.extend_from_slice(&parent_id.to_be_bytes());
        fh.resize(NFS_FHSIZE, 0);
        self.handles.insert(fh.clone(), path.to_path_buf());
        self.path_to_fh.insert(path.to_path_buf(), fh.clone());
        fh
    }

    pub(crate) fn path_for_handle(&self, fh: &[u8]) -> Option<PathBuf> {
        self.handles.get(fh).cloned()
    }
}

fn stale_reply(xid: u32, post_attributes: bool) -> Vec<u8> {
    let mut reply = rpc_reply_header(xid);
    reply.extend_from_slice(&NFSERR_STALE.to_be_bytes());
    if post_attributes {
        reply.extend_from_slice(&post_op_attr(None));
    }
    reply
}

pub(crate) fn portmap_getport(req_prog: u32, req_vers: u32, req_prot: u32, mount_port: u16) -> u16 {
    if req_prot == 17 && req_prog == RPC_MOUNT_PROG && matches!(req_vers, 1 | 3) {
        mount_port
    } else if req_prot == 17 && req_prog == RPC_NFS_PROG && matches!(req_vers, 2 | 3) {
        NFS_PORT
    } else {
        0
    }
}

/// One component avoids decks repeatedly walking the host's entire sandbox path.
/// Bind the alias to the file path, not a track ID that a later generation can reuse.
pub(crate) fn nfs_export_path(path: &Path) -> PathBuf {
    let digest = Sha256::digest(path.as_os_str().as_encoded_bytes());
    let mut alias = PathBuf::from(format!("/djbooth-{digest:x}"));
    if let Some(extension) = path.extension() {
        alias.set_extension(extension);
    }
    alias
}

pub(crate) async fn resolve_child_path(parent: &Path, name: &str) -> PathBuf {
    let child = if parent == Path::new("/") {
        PathBuf::from("/").join(name.trim_start_matches('/'))
    } else {
        parent.join(name)
    };
    if tokio::fs::try_exists(&child).await.unwrap_or(false) {
        return child;
    }
    if let Ok(mut entries) = tokio::fs::read_dir(parent).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            if entry
                .file_name()
                .to_string_lossy()
                .eq_ignore_ascii_case(name)
            {
                return entry.path();
            }
        }
    }
    child
}

pub(crate) async fn read_file_chunk(
    path: &Path,
    offset: u64,
    count: usize,
) -> std::io::Result<Vec<u8>> {
    let started = Instant::now();
    let result = async {
        let mut file = tokio::fs::File::open(path).await?;
        file.seek(std::io::SeekFrom::Start(offset)).await?;
        let mut buf = vec![0u8; count];
        let n = file.read(&mut buf).await?;
        buf.truncate(n);
        Ok::<_, std::io::Error>(buf)
    }
    .await;
    match &result {
        Ok(data) => trace!(
            target: "djtools_link::nfs",
            path = %path.display(),
            offset,
            requested = count,
            bytes = data.len(),
            elapsed_us = started.elapsed().as_micros(),
            "nfs_read_chunk"
        ),
        Err(err) => warn!(
            target: "djtools_link::nfs",
            path = %path.display(),
            offset,
            requested = count,
            error = %err,
            elapsed_us = started.elapsed().as_micros(),
            "nfs_read_chunk_error"
        ),
    }
    result
}

pub(crate) fn nfs_fh_node_id(fh: &[u8]) -> u32 {
    fh.get(0..4).map(be_u32).unwrap_or(0)
}

pub(crate) async fn nfs2_fattr(path: &Path, is_dir: bool, fileid: u32) -> Vec<u8> {
    let meta = tokio::fs::metadata(path).await.ok();
    let now = unix_now();
    let size = if is_dir {
        160
    } else {
        meta.as_ref().map(|m| m.len() as u32).unwrap_or(0)
    };
    let mtime = meta
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as u32)
        .unwrap_or(now);
    let values = [
        if is_dir { NFS_DIR } else { NFS_REG },
        if is_dir { 0o40755 } else { 0o100777 },
        if is_dir { 5 } else { 1 },
        if is_dir { 0 } else { 501 },
        if is_dir { 80 } else { 20 },
        size,
        4096,
        0x0100_000d,
        0,
        2,
        fileid,
        mtime,
        0,
        mtime,
        0,
        mtime,
        0,
    ];
    values.iter().flat_map(|v| v.to_be_bytes()).collect()
}

pub(crate) async fn nfs3_fattr(path: &Path, is_dir: bool) -> Vec<u8> {
    let meta = tokio::fs::metadata(path).await.ok();
    let now = unix_now();
    let size = if is_dir {
        4096
    } else {
        meta.as_ref().map(|m| m.len()).unwrap_or(0)
    };
    let mtime = meta
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as u32)
        .unwrap_or(now);
    let fileid = stable_id(path) as u64;
    let mut out = Vec::new();
    for value in [
        if is_dir { NFS_DIR } else { NFS_REG },
        if is_dir { 0o40755 } else { 0o100644 },
        1,
        0,
        0,
    ] {
        out.extend_from_slice(&value.to_be_bytes());
    }
    out.extend_from_slice(&size.to_be_bytes());
    out.extend_from_slice(&size.to_be_bytes());
    out.extend_from_slice(&0u32.to_be_bytes());
    out.extend_from_slice(&0u32.to_be_bytes());
    out.extend_from_slice(&1u64.to_be_bytes());
    out.extend_from_slice(&fileid.to_be_bytes());
    for _ in 0..3 {
        out.extend_from_slice(&mtime.to_be_bytes());
        out.extend_from_slice(&0u32.to_be_bytes());
    }
    out
}

pub(crate) fn post_op_attr(attrs: Option<&[u8]>) -> Vec<u8> {
    let mut out = Vec::new();
    match attrs {
        Some(attrs) => {
            out.extend_from_slice(&1u32.to_be_bytes());
            out.extend_from_slice(attrs);
        }
        None => out.extend_from_slice(&0u32.to_be_bytes()),
    }
    out
}

pub(crate) async fn handle_mount_packet<C: NfsContext + ?Sized>(
    ctx: &C,
    data: &[u8],
) -> Option<Vec<u8>> {
    let call = rpc_parse_call(data)?;
    if call.prog != RPC_MOUNT_PROG {
        return None;
    }
    handle_mount_call(ctx, call.xid, call.vers, call.proc, data, call.payload_off).await
}

pub(crate) async fn handle_nfs_datagram<C: NfsContext + ?Sized>(
    ctx: &C,
    data: &[u8],
    addr: SocketAddr,
) -> Option<Vec<u8>> {
    let call = rpc_parse_call(data)?;
    trace!(
        target: "djtools_link::rpc",
        %addr,
        xid = call.xid,
        prog = call.prog,
        vers = call.vers,
        proc = call.proc,
        bytes = data.len(),
        "nfs_request"
    );
    if call.prog == RPC_MOUNT_PROG {
        handle_mount_call(ctx, call.xid, call.vers, call.proc, data, call.payload_off).await
    } else if call.prog == RPC_NFS_PROG && call.vers <= 2 {
        handle_nfs2_call(ctx, call.xid, call.proc, data, call.payload_off, addr).await
    } else if call.prog == RPC_NFS_PROG {
        handle_nfs3_call(ctx, call.xid, call.proc, data, call.payload_off, addr).await
    } else {
        None
    }
}

async fn handle_mount_call<C: NfsContext + ?Sized>(
    ctx: &C,
    xid: u32,
    vers: u32,
    proc: u32,
    data: &[u8],
    off: usize,
) -> Option<Vec<u8>> {
    match proc {
        MOUNT_NULL => Some(rpc_reply_header(xid)),
        MOUNT_MNT => {
            let (path, _) = xdr_decode_string(data, off, NameEncoding::Utf8);
            let path = if path.trim().is_empty() {
                PathBuf::from("/")
            } else {
                PathBuf::from(path)
            };
            let fh = ctx.nfs_handle_for_path(&path, None).await?;
            let mut reply = rpc_reply_header(xid);
            reply.extend_from_slice(&NFS_OK.to_be_bytes());
            if vers >= 3 {
                reply.extend_from_slice(&xdr_encode_opaque(&fh));
                reply.extend_from_slice(&1u32.to_be_bytes());
                reply.extend_from_slice(&0u32.to_be_bytes());
            } else {
                reply.extend_from_slice(&fh);
            }
            Some(reply)
        }
        MOUNT_UMNT => Some(rpc_reply_header(xid)),
        MOUNT_EXPORT => {
            let mut reply = rpc_reply_header(xid);
            reply.extend_from_slice(&1u32.to_be_bytes());
            let export_path = b"/\0";
            reply.extend_from_slice(&(export_path.len() as u32).to_be_bytes());
            reply.extend_from_slice(export_path);
            reply.resize((reply.len() + 3) & !3, 0);
            reply.extend_from_slice(&1u32.to_be_bytes());
            reply.extend_from_slice(&xdr_encode_string(&format!(
                "{}/255.255.0.0",
                ctx.bind_ip()
            )));
            reply.extend_from_slice(&0u32.to_be_bytes());
            reply.extend_from_slice(&0u32.to_be_bytes());
            Some(reply)
        }
        _ => None,
    }
}

async fn handle_nfs2_call<C: NfsContext + ?Sized>(
    ctx: &C,
    xid: u32,
    proc: u32,
    data: &[u8],
    off: usize,
    addr: SocketAddr,
) -> Option<Vec<u8>> {
    match proc {
        NFS2_GETATTR => nfs2_getattr(ctx, xid, data, off).await,
        NFS2_LOOKUP => nfs2_lookup(ctx, xid, data, off).await,
        NFS2_READ => nfs2_read(ctx, xid, data, off, addr).await,
        _ => None,
    }
}

pub(crate) async fn nfs2_getattr<C: NfsContext + ?Sized>(
    ctx: &C,
    xid: u32,
    data: &[u8],
    off: usize,
) -> Option<Vec<u8>> {
    let fh = data.get(off..off + NFS_FHSIZE)?;
    let Some(path) = ctx.nfs_path_for_handle(fh).await else {
        return Some(stale_reply(xid, false));
    };
    let mut reply = rpc_reply_header(xid);
    if path != Path::new("/") && !tokio::fs::try_exists(&path).await.unwrap_or(false) {
        reply.extend_from_slice(&NFSERR_NOENT.to_be_bytes());
        return Some(reply);
    }
    reply.extend_from_slice(&NFS_OK.to_be_bytes());
    let is_dir = tokio::fs::metadata(&path)
        .await
        .is_ok_and(|meta| meta.is_dir());
    reply.extend_from_slice(&nfs2_fattr(&path, is_dir, nfs_fh_node_id(fh).max(1)).await);
    Some(reply)
}

pub(crate) async fn nfs2_lookup<C: NfsContext + ?Sized>(
    ctx: &C,
    xid: u32,
    data: &[u8],
    off: usize,
) -> Option<Vec<u8>> {
    let parent_fh = data.get(off..off + NFS_FHSIZE)?;
    let (name, _) = xdr_decode_string(data, off + NFS_FHSIZE, NameEncoding::Auto);
    let Some(parent) = ctx.nfs_path_for_handle(parent_fh).await else {
        return Some(stale_reply(xid, false));
    };
    let child = ctx.nfs_resolve_child(&parent, &name).await;
    let mut reply = rpc_reply_header(xid);
    if !tokio::fs::try_exists(&child).await.unwrap_or(false) {
        reply.extend_from_slice(&NFSERR_NOENT.to_be_bytes());
        return Some(reply);
    }
    let child_fh = ctx.nfs_handle_for_path(&child, Some(parent_fh)).await?;
    let is_dir = tokio::fs::metadata(&child)
        .await
        .is_ok_and(|meta| meta.is_dir());
    reply.extend_from_slice(&NFS_OK.to_be_bytes());
    reply.extend_from_slice(&child_fh);
    reply.extend_from_slice(&nfs2_fattr(&child, is_dir, nfs_fh_node_id(&child_fh)).await);
    Some(reply)
}

pub(crate) async fn nfs2_read<C: NfsContext + ?Sized>(
    ctx: &C,
    xid: u32,
    data: &[u8],
    off: usize,
    addr: SocketAddr,
) -> Option<Vec<u8>> {
    let fh = data.get(off..off + NFS_FHSIZE)?;
    let arg_off = off + NFS_FHSIZE;
    let offset = be_u32(data.get(arg_off..arg_off + 4)?) as u64;
    let count = be_u32(data.get(arg_off + 4..arg_off + 8)?) as usize;
    let Some(path) = ctx.nfs_path_for_handle(fh).await else {
        return Some(stale_reply(xid, false));
    };
    let mut reply = rpc_reply_header(xid);
    match ctx
        .nfs_read_chunk(&path, offset, count.min(NFS_READ_CHUNK_MAX))
        .await
    {
        Ok(file_data) => {
            ctx.note_nfs_audio_progress(addr, &path, offset).await;
            reply.extend_from_slice(&NFS_OK.to_be_bytes());
            reply.extend_from_slice(&nfs2_fattr(&path, false, nfs_fh_node_id(fh)).await);
            reply.extend_from_slice(&(file_data.len() as u32).to_be_bytes());
            reply.extend_from_slice(&file_data);
            reply.resize((reply.len() + 3) & !3, 0);
        }
        Err(_) => reply.extend_from_slice(&NFSERR_IO.to_be_bytes()),
    }
    Some(reply)
}

async fn handle_nfs3_call<C: NfsContext + ?Sized>(
    ctx: &C,
    xid: u32,
    proc: u32,
    data: &[u8],
    off: usize,
    addr: SocketAddr,
) -> Option<Vec<u8>> {
    match proc {
        NFS3_GETATTR => nfs3_getattr(ctx, xid, data, off).await,
        NFS3_LOOKUP => nfs3_lookup(ctx, xid, data, off).await,
        NFS3_ACCESS => nfs3_access(ctx, xid, data, off).await,
        NFS3_READ => nfs3_read(ctx, xid, data, off, addr).await,
        _ => None,
    }
}

pub(crate) async fn nfs3_getattr<C: NfsContext + ?Sized>(
    ctx: &C,
    xid: u32,
    data: &[u8],
    off: usize,
) -> Option<Vec<u8>> {
    let (fh, _) = xdr_decode_opaque(data, off)?;
    let Some(path) = ctx.nfs_path_for_handle(&fh).await else {
        return Some(stale_reply(xid, false));
    };
    let mut reply = rpc_reply_header(xid);
    reply.extend_from_slice(&NFS_OK.to_be_bytes());
    let is_dir = tokio::fs::metadata(&path)
        .await
        .is_ok_and(|meta| meta.is_dir());
    reply.extend_from_slice(&nfs3_fattr(&path, is_dir).await);
    Some(reply)
}

pub(crate) async fn nfs3_lookup<C: NfsContext + ?Sized>(
    ctx: &C,
    xid: u32,
    data: &[u8],
    off: usize,
) -> Option<Vec<u8>> {
    let (parent_fh, name_off) = xdr_decode_opaque(data, off)?;
    let (name, _) = xdr_decode_string(data, name_off, NameEncoding::Auto);
    let Some(parent) = ctx.nfs_path_for_handle(&parent_fh).await else {
        return Some(stale_reply(xid, true));
    };
    let child = ctx.nfs_resolve_child(&parent, &name).await;
    let mut reply = rpc_reply_header(xid);
    if !tokio::fs::try_exists(&child).await.unwrap_or(false) {
        reply.extend_from_slice(&NFSERR_NOENT.to_be_bytes());
        reply.extend_from_slice(&post_op_attr(Some(&nfs3_fattr(&parent, true).await)));
        return Some(reply);
    }
    let child_fh = ctx.nfs_handle_for_path(&child, Some(&parent_fh)).await?;
    let child_is_dir = tokio::fs::metadata(&child)
        .await
        .is_ok_and(|meta| meta.is_dir());
    reply.extend_from_slice(&NFS_OK.to_be_bytes());
    reply.extend_from_slice(&xdr_encode_opaque(&child_fh));
    reply.extend_from_slice(&post_op_attr(Some(&nfs3_fattr(&child, child_is_dir).await)));
    reply.extend_from_slice(&post_op_attr(Some(&nfs3_fattr(&parent, true).await)));
    Some(reply)
}

pub(crate) async fn nfs3_access<C: NfsContext + ?Sized>(
    ctx: &C,
    xid: u32,
    data: &[u8],
    off: usize,
) -> Option<Vec<u8>> {
    let (fh, access_off) = xdr_decode_opaque(data, off)?;
    let access = be_u32(data.get(access_off..access_off + 4)?);
    let Some(path) = ctx.nfs_path_for_handle(&fh).await else {
        return Some(stale_reply(xid, true));
    };
    let mut reply = rpc_reply_header(xid);
    reply.extend_from_slice(&NFS_OK.to_be_bytes());
    let is_dir = tokio::fs::metadata(&path)
        .await
        .is_ok_and(|meta| meta.is_dir());
    reply.extend_from_slice(&post_op_attr(Some(&nfs3_fattr(&path, is_dir).await)));
    reply.extend_from_slice(&access.to_be_bytes());
    Some(reply)
}

pub(crate) async fn nfs3_read<C: NfsContext + ?Sized>(
    ctx: &C,
    xid: u32,
    data: &[u8],
    off: usize,
    addr: SocketAddr,
) -> Option<Vec<u8>> {
    let (fh, arg_off) = xdr_decode_opaque(data, off)?;
    let offset = be_u64(data.get(arg_off..arg_off + 8)?);
    let count = be_u32(data.get(arg_off + 8..arg_off + 12)?) as usize;
    let Some(path) = ctx.nfs_path_for_handle(&fh).await else {
        return Some(stale_reply(xid, true));
    };
    let mut reply = rpc_reply_header(xid);
    match ctx
        .nfs_read_chunk(&path, offset, count.min(NFS_READ_CHUNK_MAX))
        .await
    {
        Ok(file_data) => {
            ctx.note_nfs_audio_progress(addr, &path, offset).await;
            let file_size = tokio::fs::metadata(&path)
                .await
                .map(|meta| meta.len())
                .unwrap_or(0);
            let eof = u32::from(offset + file_data.len() as u64 >= file_size);
            reply.extend_from_slice(&NFS_OK.to_be_bytes());
            reply.extend_from_slice(&post_op_attr(Some(&nfs3_fattr(&path, false).await)));
            reply.extend_from_slice(&(file_data.len() as u32).to_be_bytes());
            reply.extend_from_slice(&eof.to_be_bytes());
            reply.extend_from_slice(&(file_data.len() as u32).to_be_bytes());
            reply.extend_from_slice(&file_data);
            reply.resize((reply.len() + 3) & !3, 0);
        }
        Err(_) => reply.extend_from_slice(&NFSERR_IO.to_be_bytes()),
    }
    Some(reply)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Context(NfsState);

    impl NfsContext for Context {
        fn bind_ip(&self) -> Ipv4Addr {
            Ipv4Addr::LOCALHOST
        }
        async fn nfs_handle_for_path(&self, _: &Path, _: Option<&[u8]>) -> Option<Vec<u8>> {
            panic!("unknown handles must not reach child lookup")
        }
        async fn nfs_path_for_handle(&self, fh: &[u8]) -> Option<PathBuf> {
            self.0.path_for_handle(fh)
        }
        async fn nfs_read_chunk(
            &self,
            path: &Path,
            offset: u64,
            count: usize,
        ) -> std::io::Result<Vec<u8>> {
            read_file_chunk(path, offset, count).await
        }
        async fn note_nfs_audio_progress(&self, _: SocketAddr, _: &Path, _: u64) {}
    }

    #[tokio::test]
    async fn unknown_handles_receive_stale_instead_of_silence() {
        let ctx = Context(NfsState::default());
        let addr = "127.0.0.1:40000".parse().unwrap();
        let fh = [0xab; NFS_FHSIZE];
        let mut v2 = fh.to_vec();
        v2.extend_from_slice(&[0; 12]);
        let mut v3 = xdr_encode_opaque(&fh);
        v3.extend_from_slice(&[0; 12]);
        let responses = [
            (nfs2_getattr(&ctx, 42, &v2, 0).await, false),
            (nfs2_lookup(&ctx, 42, &v2, 0).await, false),
            (nfs2_read(&ctx, 42, &v2, 0, addr).await, false),
            (nfs3_getattr(&ctx, 42, &v3, 0).await, false),
            (nfs3_lookup(&ctx, 42, &v3, 0).await, true),
            (nfs3_access(&ctx, 42, &v3, 0).await, true),
            (nfs3_read(&ctx, 42, &v3, 0, addr).await, true),
        ];
        for (response, has_attrs) in responses {
            let reply = response.expect("valid RPC must receive a reply");
            let header = rpc_reply_header(42);
            assert_eq!(&reply[..header.len()], &header);
            assert_eq!(be_u32(&reply[header.len()..]), 70);
            assert_eq!(reply.len(), header.len() + if has_attrs { 8 } else { 4 });
            if has_attrs {
                assert_eq!(&reply[reply.len() - 4..], &[0; 4]);
            }
        }
    }

    #[tokio::test]
    async fn cached_file_handles_read_after_restart_without_new_lookups() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("track.wav");
        tokio::fs::write(&path, b"audio").await.unwrap();
        let paths = path.ancestors().map(Path::to_path_buf).collect();
        let mut previous = NfsState::default();
        let mut parent = NFS_ROOT_FH.to_vec();
        let ancestors = path.ancestors().collect::<Vec<_>>();
        for component in ancestors.into_iter().rev().skip(1) {
            parent = previous.handle_for_path(component, Some(&parent));
        }
        let ctx = Context(NfsState::from_exports(&paths));
        assert_eq!(ctx.0.path_for_handle(&parent), Some(path.clone()));
        let absolute = NfsState::default().handle_for_path(&path, Some(&NFS_ROOT_FH));
        assert_eq!(ctx.0.path_for_handle(&absolute), Some(path));
        for fh in [parent, absolute] {
            let mut request = fh;
            request.extend_from_slice(&0u32.to_be_bytes());
            request.extend_from_slice(&5u32.to_be_bytes());
            let reply = nfs2_read(&ctx, 17, &request, 0, "127.0.0.1:40000".parse().unwrap())
                .await
                .unwrap();
            assert_eq!(be_u32(&reply[rpc_reply_header(17).len()..]), NFS_OK);
            assert!(reply.windows(5).any(|bytes| bytes == b"audio"));
        }
    }
}
