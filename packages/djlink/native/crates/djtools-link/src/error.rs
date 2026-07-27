#[derive(Debug, thiserror::Error)]
pub enum LinkError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("invalid log level '{0}'")]
    InvalidLogLevel(String),
    #[error("empty track selector")]
    EmptyTrackSelector,
    #[error("ambiguous track selector '{selector}': {choices}")]
    AmbiguousTrackSelector { selector: String, choices: String },
    #[error("track selector '{selector}' did not match the local library")]
    TrackSelectorNotFound { selector: String },
    #[error("route probe produced IPv6 address")]
    RouteProbeIpv6,
    #[error("raw UDP payload must not be empty")]
    RawUdpPayloadEmpty,
    #[error("DJ Link runtime is stopped")]
    RuntimeStopped,
    #[error("server is not running")]
    ServerNotRunning,
    #[error("DJ Link load command actor is stopped")]
    LoadCommandActorStopped,
    #[error("load of track {track_id} on player {target_player} was superseded by a newer command")]
    LoadCommandSuperseded { target_player: u8, track_id: u32 },
    #[error(
        "player {target_player} did not confirm track {track_id} loaded after {attempts} bounded command attempt(s)"
    )]
    LoadNotConfirmed {
        target_player: u8,
        track_id: u32,
        attempts: usize,
    },
    #[error("target player {target_player} not found")]
    TargetPlayerNotFound { target_player: u8 },
    #[error("fader-start command supports target players 1..=4, got {target_player}")]
    InvalidFaderStartTarget { target_player: u8 },
    #[error("on-air command supports players 1..=6, got {player}")]
    InvalidOnAirPlayer { player: u8 },
    #[error("non-extended on-air command supports players 1..=4, got {player}")]
    InvalidNonExtendedOnAirPlayer { player: u8 },
    #[error("fourcc '{value}' is longer than 4 bytes")]
    FourccTooLong { value: String },
    #[error("unknown bind interface for raw TCP fallback")]
    RawTcpBindInterfaceUnknown,
    #[error("unknown target MAC for raw TCP fallback target {target_ip}")]
    RawTcpTargetMacUnknown { target_ip: std::net::Ipv4Addr },
    #[error("no DJ Link interface name available")]
    InterfaceNameUnavailable,
    #[error("if_nametoindex({interface}) returned 0")]
    InterfaceIndexZero { interface: String },
}

pub type LinkResult<T> = std::result::Result<T, LinkError>;
