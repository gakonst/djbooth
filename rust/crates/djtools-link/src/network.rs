use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::net::{Ipv4Addr, SocketAddrV4};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::net::{TcpStream, UdpSocket};
use tokio::sync::{mpsc, oneshot};

#[cfg(target_os = "macos")]
use socket2::{Domain, Protocol, SockAddr, Socket, Type};
#[cfg(target_os = "macos")]
use std::ffi::CString;
#[cfg(target_os = "macos")]
use std::io::Read;
#[cfg(target_os = "macos")]
use std::num::NonZeroU32;
#[cfg(target_os = "macos")]
use std::os::fd::AsRawFd;
#[cfg(target_os = "macos")]
use std::thread;
#[cfg(target_os = "macos")]
use std::time::{Duration, Instant};

pub(crate) const RAW_IPV4_MTU: usize = 1500;
const RAW_UDP_QUEUE_CAPACITY: usize = 1024;

#[derive(Clone, Debug)]
pub(crate) struct RawUdpDatagram {
    pub(crate) src_mac: [u8; 6],
    pub(crate) dst_mac: [u8; 6],
    pub(crate) src_ip: Ipv4Addr,
    pub(crate) src_port: u16,
    pub(crate) dst_ip: Ipv4Addr,
    pub(crate) dst_port: u16,
    pub(crate) payload: Vec<u8>,
}

#[derive(Clone, Debug)]
pub(crate) struct RawUdpReceived {
    pub(crate) src_ip: Ipv4Addr,
    pub(crate) src_port: u16,
    pub(crate) dst_port: u16,
    pub(crate) payload: Vec<u8>,
}

pub(crate) fn spawn_raw_udp_receiver(
    interface_name: Option<&str>,
    local_mac: [u8; 6],
    local_ip: Ipv4Addr,
) -> io::Result<mpsc::Receiver<RawUdpReceived>> {
    #[cfg(target_os = "macos")]
    {
        let interface_name = interface_name
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "unknown bind interface"))?;
        let mut receiver = RawUdpSender::open(interface_name)?;
        let (tx, rx) = mpsc::channel(RAW_UDP_QUEUE_CAPACITY);
        thread::spawn(move || {
            loop {
                match receiver.read_frames() {
                    Ok(frames) => {
                        for frame in frames {
                            if let Some(reply) = build_arp_reply_for(&frame, local_mac, local_ip) {
                                if let Err(error) = receiver.file.write_all(&reply) {
                                    tracing::warn!(%error, "stagehand_arp_reply_failed");
                                }
                                continue;
                            }
                            let Some(datagram) = parse_udp_for(&frame, local_mac, local_ip) else {
                                continue;
                            };
                            if tx.blocking_send(datagram).is_err() {
                                return;
                            }
                        }
                    }
                    Err(error) => {
                        tracing::warn!(%error, "stagehand_raw_receive_failed");
                        return;
                    }
                }
                thread::sleep(Duration::from_millis(2));
            }
        });
        return Ok(rx);
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (interface_name, local_mac, local_ip);
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "raw Stagehand peer receiving is only implemented on macOS",
        ))
    }
}

enum RawNetworkRequest {
    Udp {
        datagram: RawUdpDatagram,
        reply: oneshot::Sender<io::Result<()>>,
    },
    ArpProbe {
        src_mac: [u8; 6],
        src_ip: Ipv4Addr,
        target_ip: Ipv4Addr,
        timeout: std::time::Duration,
        reply: oneshot::Sender<io::Result<Option<[u8; 6]>>>,
    },
}

/// Async handle for the blocking macOS BPF writer.
///
/// The worker exclusively owns the BPF descriptor and serializes IP identifiers.
/// No file or mutex guard crosses an async suspension point.
#[derive(Clone)]
pub(crate) struct RawUdpTx {
    tx: mpsc::Sender<RawNetworkRequest>,
}

impl RawUdpTx {
    pub(crate) fn spawn(
        interface_name: Option<String>,
        wire_capture_path: Option<PathBuf>,
    ) -> io::Result<Self> {
        let mut wire_capture = wire_capture_path
            .as_deref()
            .map(RawPcapWriter::create)
            .transpose()?;
        let (tx, mut rx) = mpsc::channel::<RawNetworkRequest>(RAW_UDP_QUEUE_CAPACITY);
        tokio::task::spawn_blocking(move || {
            let mut sender = None;
            while let Some(request) = rx.blocking_recv() {
                match request {
                    RawNetworkRequest::Udp { datagram, reply } => {
                        let result =
                            with_raw_sender(interface_name.as_deref(), &mut sender, |sender| {
                                sender.send_udp(&datagram, &mut wire_capture)
                            });
                        if result.is_err() {
                            sender = None;
                        }
                        let _ = reply.send(result);
                    }
                    RawNetworkRequest::ArpProbe {
                        src_mac,
                        src_ip,
                        target_ip,
                        timeout,
                        reply,
                    } => {
                        let result =
                            with_raw_sender(interface_name.as_deref(), &mut sender, |sender| {
                                sender.probe_arp(
                                    src_mac,
                                    src_ip,
                                    target_ip,
                                    timeout,
                                    &mut wire_capture,
                                )
                            });
                        if result.is_err() {
                            sender = None;
                        }
                        let _ = reply.send(result);
                    }
                }
            }
        });
        Ok(Self { tx })
    }

    #[cfg(test)]
    pub(crate) fn disabled() -> Self {
        let (tx, rx) = mpsc::channel(1);
        drop(rx);
        Self { tx }
    }

    pub(crate) async fn send(&self, datagram: RawUdpDatagram) -> io::Result<()> {
        let (reply, received) = oneshot::channel();
        self.tx
            .send(RawNetworkRequest::Udp { datagram, reply })
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "raw UDP worker stopped"))?;
        received.await.map_err(|_| {
            io::Error::new(io::ErrorKind::BrokenPipe, "raw UDP worker dropped reply")
        })?
    }

    pub(crate) async fn probe_arp(
        &self,
        src_mac: [u8; 6],
        src_ip: Ipv4Addr,
        target_ip: Ipv4Addr,
        timeout: std::time::Duration,
    ) -> io::Result<Option<[u8; 6]>> {
        let (reply, received) = oneshot::channel();
        self.tx
            .send(RawNetworkRequest::ArpProbe {
                src_mac,
                src_ip,
                target_ip,
                timeout,
                reply,
            })
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "raw network worker stopped"))?;
        received.await.map_err(|_| {
            io::Error::new(
                io::ErrorKind::BrokenPipe,
                "raw network worker dropped ARP reply",
            )
        })?
    }
}

struct RawPcapWriter {
    file: File,
}

impl RawPcapWriter {
    fn create(path: &Path) -> io::Result<Self> {
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            std::fs::create_dir_all(parent)?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(path)?;
        file.write_all(&0xa1b2c3d4u32.to_le_bytes())?;
        file.write_all(&2u16.to_le_bytes())?;
        file.write_all(&4u16.to_le_bytes())?;
        file.write_all(&0i32.to_le_bytes())?;
        file.write_all(&0u32.to_le_bytes())?;
        file.write_all(&65_535u32.to_le_bytes())?;
        file.write_all(&1u32.to_le_bytes())?;
        Ok(Self { file })
    }

    fn record(&mut self, frame: &[u8]) -> io::Result<()> {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default();
        let seconds = u32::try_from(timestamp.as_secs()).unwrap_or(u32::MAX);
        let bytes = u32::try_from(frame.len())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "pcap frame too large"))?;
        self.file.write_all(&seconds.to_le_bytes())?;
        self.file
            .write_all(&timestamp.subsec_micros().to_le_bytes())?;
        self.file.write_all(&bytes.to_le_bytes())?;
        self.file.write_all(&bytes.to_le_bytes())?;
        self.file.write_all(frame)?;
        Ok(())
    }
}

fn record_wire_frame(capture: &mut Option<RawPcapWriter>, frame: &[u8]) {
    let Some(writer) = capture.as_mut() else {
        return;
    };
    if let Err(err) = writer.record(frame) {
        tracing::warn!(%err, "raw_wire_capture_disabled");
        *capture = None;
    }
}

fn with_raw_sender<T>(
    interface_name: Option<&str>,
    sender: &mut Option<RawUdpSender>,
    operation: impl FnOnce(&mut RawUdpSender) -> io::Result<T>,
) -> io::Result<T> {
    if sender.is_none() {
        let interface_name = interface_name
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "unknown bind interface"))?;
        *sender = Some(RawUdpSender::open(interface_name)?);
        tracing::debug!(
            target: "djtools_link::udp",
            interface = interface_name,
            "raw_udp_opened"
        );
    }
    let sender = sender
        .as_mut()
        .ok_or_else(|| io::Error::other("raw UDP sender unavailable"))?;
    operation(sender)
}

pub(crate) fn parse_mac(value: &str) -> io::Result<[u8; 6]> {
    let parts = value.split(':').collect::<Vec<_>>();
    if parts.len() != 6 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("invalid MAC address '{value}'"),
        ));
    }
    let mut bytes = [0u8; 6];
    for (index, part) in parts.into_iter().enumerate() {
        if part.len() != 2 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("invalid MAC address '{value}'"),
            ));
        }
        bytes[index] = u8::from_str_radix(part, 16).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("invalid MAC address '{value}'"),
            )
        })?;
    }
    Ok(bytes)
}

pub(crate) fn udp_payload_needs_raw_fragmentation(payload: &[u8]) -> bool {
    20 + 8 + payload.len() > RAW_IPV4_MTU
}

pub(crate) fn bind_udp(
    address: SocketAddrV4,
    interface_name: Option<&str>,
    broadcast: bool,
) -> io::Result<UdpSocket> {
    #[cfg(target_os = "macos")]
    {
        let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
        if let Some(interface_name) = interface_name {
            socket.bind_device_by_index_v4(Some(interface_index(interface_name)?))?;
        }
        socket.set_broadcast(broadcast)?;
        socket.bind(&SockAddr::from(address))?;
        socket.set_nonblocking(true)?;
        return UdpSocket::from_std(socket.into());
    }

    #[cfg(not(target_os = "macos"))]
    {
        let socket = std::net::UdpSocket::bind(address)?;
        socket.set_broadcast(broadcast)?;
        socket.set_nonblocking(true)?;
        UdpSocket::from_std(socket)
    }
}

pub(crate) async fn connect_tcp(
    bind_ip: Ipv4Addr,
    target: SocketAddrV4,
    interface_name: Option<&str>,
) -> io::Result<TcpStream> {
    #[cfg(target_os = "macos")]
    {
        if let Some(interface_name) = interface_name {
            let socket = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP))?;
            socket.set_nosigpipe(true)?;
            socket.bind_device_by_index_v4(Some(interface_index(interface_name)?))?;
            socket.bind(&SockAddr::from(SocketAddrV4::new(bind_ip, 0)))?;
            socket.set_nonblocking(true)?;
            match socket.connect(&SockAddr::from(target)) {
                Ok(()) => {}
                Err(err)
                    if err.kind() == io::ErrorKind::WouldBlock
                        || err.raw_os_error() == Some(libc::EINPROGRESS) => {}
                Err(err) => return Err(err),
            }
            let stream = TcpStream::from_std(socket.into())?;
            stream.writable().await?;
            if let Some(err) = stream.take_error()? {
                return Err(err);
            }
            return Ok(stream);
        }
    }

    let _ = bind_ip;
    TcpStream::connect(target).await
}

#[cfg(target_os = "macos")]
fn interface_index(interface_name: &str) -> io::Result<NonZeroU32> {
    let name = CString::new(interface_name).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("interface name contains nul byte: {interface_name:?}"),
        )
    })?;
    let index = unsafe { libc::if_nametoindex(name.as_ptr()) };
    NonZeroU32::new(index).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            format!("interface not found: {interface_name}"),
        )
    })
}

#[cfg(target_os = "macos")]
struct RawUdpSender {
    file: File,
    next_ip_id: u16,
    read_len: usize,
}

#[cfg(target_os = "macos")]
impl RawUdpSender {
    fn open(interface_name: &str) -> io::Result<Self> {
        let mut last_error = None;
        for index in 0..256 {
            let path = format!("/dev/bpf{index}");
            match OpenOptions::new().read(true).write(true).open(&path) {
                Ok(file) => {
                    bind_bpf_interface(&file, interface_name)?;
                    set_nonblocking(&file)?;
                    let read_len = bpf_buffer_len(&file)?;
                    return Ok(Self {
                        file,
                        next_ip_id: 1,
                        read_len,
                    });
                }
                Err(err) => last_error = Some(err),
            }
        }
        Err(last_error.unwrap_or_else(|| io::Error::other("no BPF devices found")))
    }

    fn send_udp(
        &mut self,
        datagram: &RawUdpDatagram,
        wire_capture: &mut Option<RawPcapWriter>,
    ) -> io::Result<()> {
        let frames = build_ethernet_ipv4_udp_frames(
            datagram.src_mac,
            datagram.dst_mac,
            datagram.src_ip,
            datagram.src_port,
            datagram.dst_ip,
            datagram.dst_port,
            &datagram.payload,
            self.next_ip_id,
            RAW_IPV4_MTU,
        )?;
        self.next_ip_id = self.next_ip_id.wrapping_add(1);
        for frame in frames {
            self.file.write_all(&frame)?;
            record_wire_frame(wire_capture, &frame);
        }
        Ok(())
    }

    fn probe_arp(
        &mut self,
        src_mac: [u8; 6],
        src_ip: Ipv4Addr,
        target_ip: Ipv4Addr,
        timeout: Duration,
        wire_capture: &mut Option<RawPcapWriter>,
    ) -> io::Result<Option<[u8; 6]>> {
        let frame = build_ethernet_arp_request_frame(src_mac, src_ip, target_ip);
        self.file.write_all(&frame)?;
        record_wire_frame(wire_capture, &frame);
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            for frame in self.read_frames()? {
                if let Some(mac) = parse_arp_reply(&frame, src_mac, src_ip, target_ip) {
                    return Ok(Some(mac));
                }
            }
            thread::sleep(Duration::from_millis(5));
        }
        Ok(None)
    }

    fn read_frames(&mut self) -> io::Result<Vec<Vec<u8>>> {
        let mut buffer = vec![0u8; self.read_len];
        match self.file.read(&mut buffer) {
            Ok(0) => Ok(Vec::new()),
            Ok(count) => Ok(parse_bpf_records(&buffer[..count])),
            Err(err) if err.kind() == io::ErrorKind::WouldBlock => Ok(Vec::new()),
            Err(err) => Err(err),
        }
    }
}

#[cfg(target_os = "macos")]
fn set_nonblocking(file: &File) -> io::Result<()> {
    let fd = file.as_raw_fd();
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    if unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn bpf_buffer_len(file: &File) -> io::Result<usize> {
    let mut len: libc::c_uint = 0;
    if unsafe { libc::ioctl(file.as_raw_fd(), libc::BIOCGBLEN, &mut len) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(len as usize)
}

#[cfg(target_os = "macos")]
fn bind_bpf_interface(file: &File, interface_name: &str) -> io::Result<()> {
    let fd = file.as_raw_fd();
    let mut request = unsafe { std::mem::zeroed::<libc::ifreq>() };
    let name = interface_name.as_bytes();
    if name.is_empty() || name.len() >= libc::IFNAMSIZ {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("invalid interface name '{interface_name}'"),
        ));
    }
    for (slot, byte) in request.ifr_name.iter_mut().zip(name.iter().copied()) {
        *slot = byte as libc::c_char;
    }
    unsafe {
        if libc::ioctl(fd, libc::BIOCSETIF, &request) < 0 {
            return Err(io::Error::last_os_error());
        }
        if libc::ioctl(fd, libc::BIOCPROMISC.into(), 0) < 0 {
            return Err(io::Error::last_os_error());
        }
        let mut one: libc::c_uint = 1;
        if libc::ioctl(fd, libc::BIOCIMMEDIATE, &mut one) < 0 {
            return Err(io::Error::last_os_error());
        }
        if libc::ioctl(fd, libc::BIOCSHDRCMPLT, &mut one) < 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
struct RawUdpSender;

#[cfg(not(target_os = "macos"))]
impl RawUdpSender {
    fn open(_interface_name: &str) -> io::Result<Self> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "raw UDP fallback is only implemented on macOS",
        ))
    }

    fn send_udp(
        &mut self,
        _datagram: &RawUdpDatagram,
        _wire_capture: &mut Option<RawPcapWriter>,
    ) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "raw UDP fallback is only implemented on macOS",
        ))
    }

    fn probe_arp(
        &mut self,
        _src_mac: [u8; 6],
        _src_ip: Ipv4Addr,
        _target_ip: Ipv4Addr,
        _timeout: std::time::Duration,
        _wire_capture: &mut Option<RawPcapWriter>,
    ) -> io::Result<Option<[u8; 6]>> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "raw ARP probing is only implemented on macOS",
        ))
    }
}

#[allow(clippy::too_many_arguments)]
fn build_ethernet_ipv4_udp_frames(
    src_mac: [u8; 6],
    dst_mac: [u8; 6],
    src_ip: Ipv4Addr,
    src_port: u16,
    dst_ip: Ipv4Addr,
    dst_port: u16,
    payload: &[u8],
    ip_id: u16,
    mtu: usize,
) -> io::Result<Vec<Vec<u8>>> {
    let udp_len = 8usize
        .checked_add(payload.len())
        .ok_or_else(|| io::Error::other("UDP payload length overflow"))?;
    let ip_len = 20usize
        .checked_add(udp_len)
        .ok_or_else(|| io::Error::other("IP payload length overflow"))?;
    if ip_len > u16::MAX as usize {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "raw UDP payload too large",
        ));
    }

    let mut udp_datagram = Vec::with_capacity(udp_len);
    udp_datagram.extend_from_slice(&src_port.to_be_bytes());
    udp_datagram.extend_from_slice(&dst_port.to_be_bytes());
    udp_datagram.extend_from_slice(&(udp_len as u16).to_be_bytes());
    udp_datagram.extend_from_slice(&0u16.to_be_bytes());
    udp_datagram.extend_from_slice(payload);

    if ip_len <= mtu {
        return Ok(vec![build_ethernet_ipv4_payload_frame(
            src_mac,
            dst_mac,
            src_ip,
            dst_ip,
            ip_id,
            0,
            &udp_datagram,
        )?]);
    }
    if mtu <= 28 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "raw UDP MTU too small",
        ));
    }

    let max_fragment_payload = ((mtu - 20) / 8) * 8;
    let mut offset = 0usize;
    let mut frames = Vec::new();
    while offset < udp_datagram.len() {
        let remaining = udp_datagram.len() - offset;
        let chunk_len = remaining.min(max_fragment_payload);
        let more_fragments = offset + chunk_len < udp_datagram.len();
        let fragment_offset = (offset / 8) as u16;
        let flags_fragment_offset = fragment_offset | if more_fragments { 0x2000 } else { 0 };
        frames.push(build_ethernet_ipv4_payload_frame(
            src_mac,
            dst_mac,
            src_ip,
            dst_ip,
            ip_id,
            flags_fragment_offset,
            &udp_datagram[offset..offset + chunk_len],
        )?);
        offset += chunk_len;
    }
    Ok(frames)
}

#[allow(clippy::too_many_arguments)]
fn build_ethernet_ipv4_payload_frame(
    src_mac: [u8; 6],
    dst_mac: [u8; 6],
    src_ip: Ipv4Addr,
    dst_ip: Ipv4Addr,
    ip_id: u16,
    flags_fragment_offset: u16,
    ip_payload: &[u8],
) -> io::Result<Vec<u8>> {
    let ip_len = 20usize
        .checked_add(ip_payload.len())
        .ok_or_else(|| io::Error::other("IP payload length overflow"))?;
    if ip_len > u16::MAX as usize {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "raw IPv4 payload too large",
        ));
    }

    let mut frame = Vec::with_capacity(14 + ip_len);
    frame.extend_from_slice(&dst_mac);
    frame.extend_from_slice(&src_mac);
    frame.extend_from_slice(&0x0800u16.to_be_bytes());

    let ip_start = frame.len();
    frame.push(0x45);
    frame.push(0);
    frame.extend_from_slice(&(ip_len as u16).to_be_bytes());
    frame.extend_from_slice(&ip_id.to_be_bytes());
    frame.extend_from_slice(&flags_fragment_offset.to_be_bytes());
    frame.push(64);
    frame.push(17);
    frame.extend_from_slice(&0u16.to_be_bytes());
    frame.extend_from_slice(&src_ip.octets());
    frame.extend_from_slice(&dst_ip.octets());
    let checksum = internet_checksum(&frame[ip_start..ip_start + 20]);
    frame[ip_start + 10..ip_start + 12].copy_from_slice(&checksum.to_be_bytes());
    frame.extend_from_slice(ip_payload);
    if frame.len() < 60 {
        frame.resize(60, 0);
    }
    Ok(frame)
}

fn build_ethernet_arp_request_frame(
    src_mac: [u8; 6],
    src_ip: Ipv4Addr,
    target_ip: Ipv4Addr,
) -> Vec<u8> {
    let mut frame = Vec::with_capacity(60);
    frame.extend_from_slice(&[0xff; 6]);
    frame.extend_from_slice(&src_mac);
    frame.extend_from_slice(&0x0806u16.to_be_bytes());
    frame.extend_from_slice(&1u16.to_be_bytes());
    frame.extend_from_slice(&0x0800u16.to_be_bytes());
    frame.push(6);
    frame.push(4);
    frame.extend_from_slice(&1u16.to_be_bytes());
    frame.extend_from_slice(&src_mac);
    frame.extend_from_slice(&src_ip.octets());
    frame.extend_from_slice(&[0; 6]);
    frame.extend_from_slice(&target_ip.octets());
    frame.resize(60, 0);
    frame
}

#[cfg(target_os = "macos")]
fn build_arp_reply_for(frame: &[u8], local_mac: [u8; 6], local_ip: Ipv4Addr) -> Option<Vec<u8>> {
    if frame.len() < 42
        || frame.get(12..14)? != 0x0806u16.to_be_bytes()
        || frame.get(20..22)? != 1u16.to_be_bytes()
        || frame.get(38..42)? != local_ip.octets()
    {
        return None;
    }
    let sender_mac: [u8; 6] = frame.get(22..28)?.try_into().ok()?;
    let sender_ip: [u8; 4] = frame.get(28..32)?.try_into().ok()?;
    let mut reply = Vec::with_capacity(60);
    reply.extend_from_slice(&sender_mac);
    reply.extend_from_slice(&local_mac);
    reply.extend_from_slice(&0x0806u16.to_be_bytes());
    reply.extend_from_slice(&1u16.to_be_bytes());
    reply.extend_from_slice(&0x0800u16.to_be_bytes());
    reply.extend_from_slice(&[6, 4]);
    reply.extend_from_slice(&2u16.to_be_bytes());
    reply.extend_from_slice(&local_mac);
    reply.extend_from_slice(&local_ip.octets());
    reply.extend_from_slice(&sender_mac);
    reply.extend_from_slice(&sender_ip);
    reply.resize(60, 0);
    Some(reply)
}

#[cfg(target_os = "macos")]
fn parse_udp_for(frame: &[u8], local_mac: [u8; 6], local_ip: Ipv4Addr) -> Option<RawUdpReceived> {
    if frame.len() < 42
        || frame.get(0..6)? != local_mac
        || frame.get(12..14)? != 0x0800u16.to_be_bytes()
        || frame.get(23).copied()? != 17
        || frame.get(30..34)? != local_ip.octets()
    {
        return None;
    }
    let ip_header_len = usize::from(frame[14] & 0x0f) * 4;
    let udp = 14 + ip_header_len;
    if ip_header_len < 20 || frame.len() < udp + 8 {
        return None;
    }
    let udp_len = usize::from(u16::from_be_bytes(
        frame.get(udp + 4..udp + 6)?.try_into().ok()?,
    ));
    if udp_len < 8 || frame.len() < udp + udp_len {
        return None;
    }
    Some(RawUdpReceived {
        src_ip: Ipv4Addr::from(<[u8; 4]>::try_from(frame.get(26..30)?).ok()?),
        src_port: u16::from_be_bytes(frame.get(udp..udp + 2)?.try_into().ok()?),
        dst_port: u16::from_be_bytes(frame.get(udp + 2..udp + 4)?.try_into().ok()?),
        payload: frame[udp + 8..udp + udp_len].to_vec(),
    })
}

fn parse_arp_reply(
    frame: &[u8],
    local_mac: [u8; 6],
    local_ip: Ipv4Addr,
    expected_sender_ip: Ipv4Addr,
) -> Option<[u8; 6]> {
    if frame.len() < 42
        || frame.get(0..6)? != local_mac
        || frame.get(12..14)? != 0x0806u16.to_be_bytes()
        || frame.get(14..16)? != 1u16.to_be_bytes()
        || frame.get(16..18)? != 0x0800u16.to_be_bytes()
        || frame.get(18..20)? != [6, 4]
        || frame.get(20..22)? != 2u16.to_be_bytes()
        || frame.get(28..32)? != expected_sender_ip.octets()
        || frame.get(32..38)? != local_mac
        || frame.get(38..42)? != local_ip.octets()
    {
        return None;
    }
    frame.get(22..28)?.try_into().ok()
}

#[cfg(target_os = "macos")]
fn parse_bpf_records(data: &[u8]) -> Vec<Vec<u8>> {
    let mut frames = Vec::new();
    let mut offset = 0usize;
    while offset + 20 <= data.len() {
        let caplen = u32::from_ne_bytes([
            data[offset + 8],
            data[offset + 9],
            data[offset + 10],
            data[offset + 11],
        ]) as usize;
        let hdrlen = u16::from_ne_bytes([data[offset + 16], data[offset + 17]]) as usize;
        if hdrlen == 0 || caplen == 0 || offset + hdrlen + caplen > data.len() {
            break;
        }
        frames.push(data[offset + hdrlen..offset + hdrlen + caplen].to_vec());
        offset += (hdrlen + caplen + 3) & !3;
    }
    frames
}

fn internet_checksum(data: &[u8]) -> u16 {
    let mut sum = 0u32;
    for chunk in data.chunks(2) {
        let word = if chunk.len() == 2 {
            u16::from_be_bytes([chunk[0], chunk[1]]) as u32
        } else {
            (chunk[0] as u32) << 8
        };
        sum = sum.wrapping_add(word);
        while sum > 0xffff {
            sum = (sum & 0xffff) + (sum >> 16);
        }
    }
    !(sum as u16)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn parses_mac_strictly() {
        assert_eq!(
            parse_mac("24:97:ed:24:4a:66").unwrap(),
            [0x24, 0x97, 0xed, 0x24, 0x4a, 0x66]
        );
        assert!(parse_mac("24:97:ed:24:4a").is_err());
        assert!(parse_mac("24:97:ed:24:4a:xyz").is_err());
    }

    #[test]
    fn builds_one_valid_ipv4_udp_frame() {
        let frames = build_ethernet_ipv4_udp_frames(
            [0, 1, 2, 3, 4, 5],
            [6, 7, 8, 9, 10, 11],
            Ipv4Addr::new(169, 254, 253, 33),
            50000,
            Ipv4Addr::new(169, 254, 255, 255),
            50000,
            b"djlink",
            0x1234,
            RAW_IPV4_MTU,
        )
        .unwrap();
        assert_eq!(frames.len(), 1);
        let frame = &frames[0];
        assert_eq!(&frame[..6], &[6, 7, 8, 9, 10, 11]);
        assert_eq!(&frame[6..12], &[0, 1, 2, 3, 4, 5]);
        assert_eq!(&frame[12..14], &0x0800u16.to_be_bytes());
        assert_eq!(internet_checksum(&frame[14..34]), 0);
        assert_eq!(&frame[34..36], &50000u16.to_be_bytes());
        assert_eq!(&frame[36..38], &50000u16.to_be_bytes());
    }

    #[test]
    fn fragments_maximum_proven_nfs_payload_on_eight_byte_boundaries() {
        let payload = vec![0x5a; 64_512];
        assert!(udp_payload_needs_raw_fragmentation(&payload));
        let frames = build_ethernet_ipv4_udp_frames(
            [0, 1, 2, 3, 4, 5],
            [6, 7, 8, 9, 10, 11],
            Ipv4Addr::new(169, 254, 253, 33),
            2049,
            Ipv4Addr::new(169, 254, 7, 4),
            49152,
            &payload,
            0x1234,
            RAW_IPV4_MTU,
        )
        .unwrap();
        assert!(frames.len() > 1);
        let mut reassembled = Vec::new();
        for (index, frame) in frames.iter().enumerate() {
            assert_eq!(internet_checksum(&frame[14..34]), 0);
            assert_eq!(&frame[18..20], &0x1234u16.to_be_bytes());
            let flags_offset = u16::from_be_bytes([frame[20], frame[21]]);
            let offset = usize::from(flags_offset & 0x1fff) * 8;
            assert_eq!(offset, reassembled.len());
            if index + 1 < frames.len() {
                assert_ne!(flags_offset & 0x2000, 0);
            } else {
                assert_eq!(flags_offset & 0x2000, 0);
            }
            let ip_len = usize::from(u16::from_be_bytes([frame[16], frame[17]]));
            reassembled.extend_from_slice(&frame[34..14 + ip_len]);
        }
        assert_eq!(&reassembled[..2], &2049u16.to_be_bytes());
        assert_eq!(&reassembled[2..4], &49152u16.to_be_bytes());
        assert_eq!(&reassembled[8..], payload);
    }

    #[test]
    fn arp_probe_request_and_reply_are_strict() {
        let local_mac = [0xc8, 0x3d, 0xfc, 0x15, 0x71, 0xed];
        let deck_mac = [0x24, 0x97, 0xed, 0x24, 0x4a, 0x66];
        let local_ip = Ipv4Addr::new(169, 254, 253, 33);
        let deck_ip = Ipv4Addr::new(169, 254, 7, 4);
        let request = build_ethernet_arp_request_frame(local_mac, local_ip, deck_ip);
        assert_eq!(&request[..6], &[0xff; 6]);
        assert_eq!(&request[6..12], &local_mac);
        assert_eq!(&request[12..14], &0x0806u16.to_be_bytes());
        assert_eq!(&request[20..22], &1u16.to_be_bytes());
        assert_eq!(&request[22..28], &local_mac);
        assert_eq!(&request[28..32], &local_ip.octets());
        assert_eq!(&request[38..42], &deck_ip.octets());

        let mut reply = vec![0u8; 60];
        reply[0..6].copy_from_slice(&local_mac);
        reply[6..12].copy_from_slice(&deck_mac);
        reply[12..14].copy_from_slice(&0x0806u16.to_be_bytes());
        reply[14..16].copy_from_slice(&1u16.to_be_bytes());
        reply[16..18].copy_from_slice(&0x0800u16.to_be_bytes());
        reply[18..20].copy_from_slice(&[6, 4]);
        reply[20..22].copy_from_slice(&2u16.to_be_bytes());
        reply[22..28].copy_from_slice(&deck_mac);
        reply[28..32].copy_from_slice(&deck_ip.octets());
        reply[32..38].copy_from_slice(&local_mac);
        reply[38..42].copy_from_slice(&local_ip.octets());
        assert_eq!(
            parse_arp_reply(&reply, local_mac, local_ip, deck_ip),
            Some(deck_mac)
        );
        reply[38] ^= 1;
        assert_eq!(parse_arp_reply(&reply, local_mac, local_ip, deck_ip), None);
    }

    #[test]
    fn isolated_peer_answers_arp_and_receives_udp() {
        let local_mac = [0xc8, 0x3d, 0xfc, 0x15, 0x71, 0xed];
        let deck_mac = [0x24, 0x97, 0xed, 0x24, 0x4a, 0x66];
        let local_ip = Ipv4Addr::new(169, 254, 179, 138);
        let deck_ip = Ipv4Addr::new(169, 254, 7, 4);
        let request = build_ethernet_arp_request_frame(deck_mac, deck_ip, local_ip);
        let reply = build_arp_reply_for(&request, local_mac, local_ip).expect("ARP reply");
        assert_eq!(&reply[..6], &deck_mac);
        assert_eq!(&reply[6..12], &local_mac);
        assert_eq!(&reply[20..22], &2u16.to_be_bytes());
        assert_eq!(&reply[28..32], &local_ip.octets());

        let frame = build_ethernet_ipv4_udp_frames(
            deck_mac,
            local_mac,
            deck_ip,
            50001,
            local_ip,
            50001,
            b"stagehand",
            7,
            RAW_IPV4_MTU,
        )
        .unwrap()
        .remove(0);
        let received = parse_udp_for(&frame, local_mac, local_ip).expect("UDP datagram");
        assert_eq!(received.src_ip, deck_ip);
        assert_eq!(received.src_port, 50001);
        assert_eq!(received.dst_port, 50001);
        assert_eq!(received.payload, b"stagehand");
    }

    #[test]
    fn writes_standard_ethernet_pcap_records() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("raw-wire.pcap");
        let frame = build_ethernet_arp_request_frame(
            [0, 1, 2, 3, 4, 5],
            Ipv4Addr::new(169, 254, 253, 33),
            Ipv4Addr::new(169, 254, 7, 4),
        );
        let mut writer = RawPcapWriter::create(&path).unwrap();
        writer.record(&frame).unwrap();
        drop(writer);

        let bytes = std::fs::read(path).unwrap();
        assert_eq!(&bytes[..4], &0xa1b2c3d4u32.to_le_bytes());
        assert_eq!(&bytes[4..8], &[2, 0, 4, 0]);
        assert_eq!(&bytes[20..24], &1u32.to_le_bytes());
        assert_eq!(
            u32::from_le_bytes(bytes[32..36].try_into().unwrap()),
            frame.len() as u32
        );
        assert_eq!(
            u32::from_le_bytes(bytes[36..40].try_into().unwrap()),
            frame.len() as u32
        );
        assert_eq!(&bytes[40..], frame);
    }
}
