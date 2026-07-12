/** Generated from pyrekordbox masterdb/models.py at the pinned source revision. */
import "./models.js";

declare module "./models.js" {
  interface AgentRegistry {
    created_at: Date | null;
    updated_at: Date | null;
    registry_id: string | null;
    id_1: string | null;
    id_2: string | null;
    int_1: number | null;
    int_2: number | null;
    str_1: string | null;
    str_2: string | null;
    date_1: Date | null;
    date_2: Date | null;
    text_1: string | null;
    text_2: string | null;
  }
  interface CloudAgentRegistry {
    ID: string | null;
    UUID: string | null;
    rb_data_status: number | null;
    rb_local_data_status: number | null;
    rb_local_deleted: number | null;
    rb_local_synced: number | null;
    usn: number | null;
    rb_local_usn: number | null;
    created_at: Date | null;
    updated_at: Date | null;
    int_1: number | null;
    int_2: number | null;
    str_1: string | null;
    str_2: string | null;
    date_1: Date | null;
    date_2: Date | null;
    text_1: string | null;
    text_2: string | null;
  }
  interface ContentActiveCensor {
    ID: string | null;
    UUID: string | null;
    rb_data_status: number | null;
    rb_local_data_status: number | null;
    rb_local_deleted: number | null;
    rb_local_synced: number | null;
    usn: number | null;
    rb_local_usn: number | null;
    created_at: Date | null;
    updated_at: Date | null;
    ContentID: string | null;
    ActiveCensors: string | null;
    rb_activecensor_count: number | null;
  }
  interface ContentCue {
    ID: string | null;
    UUID: string | null;
    rb_data_status: number | null;
    rb_local_data_status: number | null;
    rb_local_deleted: number | null;
    rb_local_synced: number | null;
    usn: number | null;
    rb_local_usn: number | null;
    created_at: Date | null;
    updated_at: Date | null;
    ContentID: string | null;
    Cues: string | null;
    rb_cue_count: number | null;
  }
  interface ContentFile {
    ID: string | null;
    UUID: string | null;
    rb_data_status: number | null;
    rb_local_data_status: number | null;
    rb_local_deleted: number | null;
    rb_local_synced: number | null;
    usn: number | null;
    rb_local_usn: number | null;
    created_at: Date | null;
    updated_at: Date | null;
    ContentID: string | null;
    Path: string | null;
    Hash: string | null;
    Size: number | null;
    rb_local_path: string | null;
    rb_insync_hash: string | null;
    rb_insync_local_usn: number | null;
    rb_file_hash_dirty: number | null;
    rb_local_file_status: number | null;
    rb_in_progress: number | null;
    rb_process_type: number | null;
    rb_temp_path: string | null;
    rb_priority: number | null;
    rb_file_size_dirty: number | null;
  }
  interface DjmdActiveCensor {
    ID: string | null;
    UUID: string | null;
    rb_data_status: number | null;
    rb_local_data_status: number | null;
    rb_local_deleted: number | null;
    rb_local_synced: number | null;
    usn: number | null;
    rb_local_usn: number | null;
    created_at: Date | null;
    updated_at: Date | null;
    ContentID: string | null;
    InMsec: number | null;
    OutMsec: number | null;
    Info: number | null;
    ParameterList: string | null;
    ContentUUID: string | null;
  }
  interface DjmdAlbum {
    UUID: string | null;
    rb_data_status: number | null;
    rb_local_data_status: number | null;
    rb_local_deleted: number | null;
    rb_local_synced: number | null;
    usn: number | null;
    rb_local_usn: number | null;
    created_at: Date | null;
    updated_at: Date | null;
    AlbumArtistID: string | null;
    ImagePath: string | null;
    Compilation: number | null;
    SearchStr: string | null;
  }
  interface DjmdArtist {
    UUID: string | null;
    rb_data_status: number | null;
    rb_local_data_status: number | null;
    rb_local_deleted: number | null;
    rb_local_synced: number | null;
    usn: number | null;
    rb_local_usn: number | null;
    created_at: Date | null;
    updated_at: Date | null;
    SearchStr: string | null;
  }
  interface DjmdCategory {
    ID: string | null;
    UUID: string | null;
    rb_data_status: number | null;
    rb_local_data_status: number | null;
    rb_local_deleted: number | null;
    rb_local_synced: number | null;
    usn: number | null;
    rb_local_usn: number | null;
    created_at: Date | null;
    updated_at: Date | null;
    MenuItemID: string | null;
    Seq: number | null;
    Disable: number | null;
    InfoOrder: number | null;
  }
  interface DjmdColor {
    ID: string | null;
    UUID: string | null;
    rb_data_status: number | null;
    rb_local_data_status: number | null;
    rb_local_deleted: number | null;
    rb_local_synced: number | null;
    usn: number | null;
    rb_local_usn: number | null;
    created_at: Date | null;
    updated_at: Date | null;
    ColorCode: number | null;
    SortKey: number | null;
    Commnt: string | null;
  }
  interface DjmdContent {
    UUID: string | null;
    rb_data_status: number | null;
    rb_local_data_status: number | null;
    rb_local_deleted: number | null;
    rb_local_synced: number | null;
    usn: number | null;
    rb_local_usn: number | null;
    created_at: Date | null;
    updated_at: Date | null;
    FileNameS: string | null;
    BPM: number | null;
    Length: number | null;
    TrackNo: number | null;
    BitRate: number | null;
    BitDepth: number | null;
    Commnt: string | null;
    FileType: number | null;
    Rating: number | null;
    ReleaseYear: number | null;
    RemixerID: string | null;
    LabelID: string | null;
    OrgArtistID: string | null;
    KeyID: string | null;
    StockDate: string | null;
    ColorID: string | null;
    DJPlayCount: string | null;
    ImagePath: string | null;
    MasterDBID: string | null;
    MasterSongID: string | null;
    SearchStr: string | null;
    FileSize: number | null;
    DiscNo: number | null;
    ComposerID: string | null;
    Subtitle: string | null;
    SampleRate: number | null;
    DisableQuantize: number | null;
    Analysed: number | null;
    ReleaseDate: string | null;
    DateCreated: string | null;
    ContentLink: number | null;
    Tag: string | null;
    ModifiedByRBM: string | null;
    HotCueAutoLoad: string | null;
    DeliveryControl: string | null;
    DeliveryComment: string | null;
    CueUpdated: string | null;
    AnalysisUpdated: string | null;
    TrackInfoUpdated: string | null;
    Lyricist: string | null;
    ISRC: string | null;
    SamplerTrackInfo: number | null;
    SamplerPlayOffset: number | null;
    SamplerGain: number | null;
    VideoAssociate: string | null;
    LyricStatus: number | null;
    ServiceID: number | null;
    OrgFolderPath: string | null;
    Reserved1: string | null;
    Reserved2: string | null;
    Reserved3: string | null;
    Reserved4: string | null;
    ExtInfo: string | null;
    rb_file_id: string | null;
    DeviceID: string | null;
    rb_LocalFolderPath: string | null;
    SrcID: string | null;
    SrcTitle: string | null;
    SrcArtistName: string | null;
    SrcAlbumName: string | null;
    SrcLength: number | null;
  }
  interface DjmdCue {
    ID: string | null;
    UUID: string | null;
    rb_data_status: number | null;
    rb_local_data_status: number | null;
    rb_local_deleted: number | null;
    rb_local_synced: number | null;
    usn: number | null;
    rb_local_usn: number | null;
    created_at: Date | null;
    updated_at: Date | null;
    ContentID: string | null;
    InMsec: number | null;
    InFrame: number | null;
    InMpegFrame: number | null;
    InMpegAbs: number | null;
    OutMsec: number | null;
    OutFrame: number | null;
    OutMpegFrame: number | null;
    OutMpegAbs: number | null;
    Kind: number | null;
    Color: number | null;
    ColorTableIndex: number | null;
    ActiveLoop: number | null;
    Comment: string | null;
    BeatLoopSize: number | null;
    CueMicrosec: number | null;
    InPointSeekInfo: string | null;
    OutPointSeekInfo: string | null;
    ContentUUID: string | null;
  }
  interface DjmdDevice {
    ID: string | null;
    UUID: string | null;
    rb_data_status: number | null;
    rb_local_data_status: number | null;
    rb_local_deleted: number | null;
    rb_local_synced: number | null;
    usn: number | null;
    rb_local_usn: number | null;
    created_at: Date | null;
    updated_at: Date | null;
    MasterDBID: string | null;
    Name: string | null;
  }
  interface DjmdGenre {
    UUID: string | null;
    rb_data_status: number | null;
    rb_local_data_status: number | null;
    rb_local_deleted: number | null;
    rb_local_synced: number | null;
    usn: number | null;
    rb_local_usn: number | null;
    created_at: Date | null;
    updated_at: Date | null;
  }
  interface DjmdHistory {
    ID: string | null;
    UUID: string | null;
    rb_data_status: number | null;
    rb_local_data_status: number | null;
    rb_local_deleted: number | null;
    rb_local_synced: number | null;
    usn: number | null;
    rb_local_usn: number | null;
    created_at: Date | null;
    updated_at: Date | null;
    Seq: number | null;
    Name: string | null;
    Attribute: number | null;
    ParentID: string | null;
    DateCreated: string | null;
  }
  interface DjmdSongHistory {
    ID: string | null;
    UUID: string | null;
    rb_data_status: number | null;
    rb_local_data_status: number | null;
    rb_local_deleted: number | null;
    rb_local_synced: number | null;
    usn: number | null;
    rb_local_usn: number | null;
    created_at: Date | null;
    updated_at: Date | null;
    HistoryID: string | null;
    ContentID: string | null;
    TrackNo: number | null;
  }
  interface DjmdHotCueBanklist {
    ID: string | null;
    UUID: string | null;
    rb_data_status: number | null;
    rb_local_data_status: number | null;
    rb_local_deleted: number | null;
    rb_local_synced: number | null;
    usn: number | null;
    rb_local_usn: number | null;
    created_at: Date | null;
    updated_at: Date | null;
    Seq: number | null;
    Name: string | null;
    ImagePath: string | null;
    Attribute: number | null;
    ParentID: string | null;
  }
  interface DjmdSongHotCueBanklist {
    ID: string | null;
    UUID: string | null;
    rb_data_status: number | null;
    rb_local_data_status: number | null;
    rb_local_deleted: number | null;
    rb_local_synced: number | null;
    usn: number | null;
    rb_local_usn: number | null;
    created_at: Date | null;
    updated_at: Date | null;
    HotCueBanklistID: string | null;
    ContentID: string | null;
    TrackNo: number | null;
    CueID: string | null;
    InMsec: number | null;
    InFrame: number | null;
    InMpegFrame: number | null;
    InMpegAbs: number | null;
    OutMsec: number | null;
    OutFrame: number | null;
    OutMpegFrame: number | null;
    OutMpegAbs: number | null;
    Color: number | null;
    ColorTableIndex: number | null;
    ActiveLoop: number | null;
    Comment: string | null;
    BeatLoopSize: number | null;
    CueMicrosec: number | null;
    InPointSeekInfo: string | null;
    OutPointSeekInfo: string | null;
    HotCueBanklistUUID: string | null;
  }
  interface DjmdKey {
    UUID: string | null;
    rb_data_status: number | null;
    rb_local_data_status: number | null;
    rb_local_deleted: number | null;
    rb_local_synced: number | null;
    usn: number | null;
    rb_local_usn: number | null;
    created_at: Date | null;
    updated_at: Date | null;
    Seq: number | null;
  }
  interface DjmdLabel {
    UUID: string | null;
    rb_data_status: number | null;
    rb_local_data_status: number | null;
    rb_local_deleted: number | null;
    rb_local_synced: number | null;
    usn: number | null;
    rb_local_usn: number | null;
    created_at: Date | null;
    updated_at: Date | null;
  }
  interface DjmdMenuItems {
    ID: string | null;
    UUID: string | null;
    rb_data_status: number | null;
    rb_local_data_status: number | null;
    rb_local_deleted: number | null;
    rb_local_synced: number | null;
    usn: number | null;
    rb_local_usn: number | null;
    created_at: Date | null;
    updated_at: Date | null;
    Class: number | null;
    Name: string | null;
  }
  interface DjmdMixerParam {
    ID: string | null;
    UUID: string | null;
    rb_data_status: number | null;
    rb_local_data_status: number | null;
    rb_local_deleted: number | null;
    rb_local_synced: number | null;
    usn: number | null;
    rb_local_usn: number | null;
    created_at: Date | null;
    updated_at: Date | null;
    ContentID: string | null;
    GainHigh: number | null;
    GainLow: number | null;
    PeakHigh: number | null;
    PeakLow: number | null;
  }
  interface DjmdMyTag {
    ID: string | null;
    UUID: string | null;
    rb_data_status: number | null;
    rb_local_data_status: number | null;
    rb_local_deleted: number | null;
    rb_local_synced: number | null;
    usn: number | null;
    rb_local_usn: number | null;
    created_at: Date | null;
    updated_at: Date | null;
    Seq: number | null;
    Name: string | null;
    Attribute: number | null;
    ParentID: string | null;
  }
  interface DjmdSongMyTag {
    ID: string | null;
    UUID: string | null;
    rb_data_status: number | null;
    rb_local_data_status: number | null;
    rb_local_deleted: number | null;
    rb_local_synced: number | null;
    usn: number | null;
    rb_local_usn: number | null;
    created_at: Date | null;
    updated_at: Date | null;
    ContentID: string | null;
    TrackNo: number | null;
  }
  interface DjmdPlaylist {
    UUID: string | null;
    rb_data_status: number | null;
    rb_local_data_status: number | null;
    rb_local_deleted: number | null;
    rb_local_synced: number | null;
    usn: number | null;
    rb_local_usn: number | null;
    created_at: Date | null;
    updated_at: Date | null;
    ImagePath: string | null;
  }
  interface DjmdSongPlaylist {
    UUID: string | null;
    rb_data_status: number | null;
    rb_local_data_status: number | null;
    rb_local_deleted: number | null;
    rb_local_synced: number | null;
    usn: number | null;
    rb_local_usn: number | null;
    created_at: Date | null;
    updated_at: Date | null;
  }
  interface DjmdRelatedTracks {
    ID: string | null;
    UUID: string | null;
    rb_data_status: number | null;
    rb_local_data_status: number | null;
    rb_local_deleted: number | null;
    rb_local_synced: number | null;
    usn: number | null;
    rb_local_usn: number | null;
    created_at: Date | null;
    updated_at: Date | null;
    Seq: number | null;
    Name: string | null;
    Attribute: number | null;
    ParentID: string | null;
    Criteria: string | null;
  }
  interface DjmdSongRelatedTracks {
    ID: string | null;
    UUID: string | null;
    rb_data_status: number | null;
    rb_local_data_status: number | null;
    rb_local_deleted: number | null;
    rb_local_synced: number | null;
    usn: number | null;
    rb_local_usn: number | null;
    created_at: Date | null;
    updated_at: Date | null;
    RelatedTracksID: string | null;
    ContentID: string | null;
    TrackNo: number | null;
  }
  interface DjmdSampler {
    ID: string | null;
    UUID: string | null;
    rb_data_status: number | null;
    rb_local_data_status: number | null;
    rb_local_deleted: number | null;
    rb_local_synced: number | null;
    usn: number | null;
    rb_local_usn: number | null;
    created_at: Date | null;
    updated_at: Date | null;
    Seq: number | null;
    Name: string | null;
    Attribute: number | null;
    ParentID: string | null;
  }
  interface DjmdSongSampler {
    ID: string | null;
    UUID: string | null;
    rb_data_status: number | null;
    rb_local_data_status: number | null;
    rb_local_deleted: number | null;
    rb_local_synced: number | null;
    usn: number | null;
    rb_local_usn: number | null;
    created_at: Date | null;
    updated_at: Date | null;
    SamplerID: string | null;
    ContentID: string | null;
    TrackNo: number | null;
  }
  interface DjmdSongTagList {
    ID: string | null;
    UUID: string | null;
    rb_data_status: number | null;
    rb_local_data_status: number | null;
    rb_local_deleted: number | null;
    rb_local_synced: number | null;
    usn: number | null;
    rb_local_usn: number | null;
    created_at: Date | null;
    updated_at: Date | null;
    ContentID: string | null;
    TrackNo: number | null;
  }
  interface DjmdSort {
    ID: string | null;
    UUID: string | null;
    rb_data_status: number | null;
    rb_local_data_status: number | null;
    rb_local_deleted: number | null;
    rb_local_synced: number | null;
    usn: number | null;
    rb_local_usn: number | null;
    created_at: Date | null;
    updated_at: Date | null;
    MenuItemID: string | null;
    Seq: number | null;
    Disable: number | null;
  }
  interface HotCueBanklistCue {
    ID: string | null;
    UUID: string | null;
    rb_data_status: number | null;
    rb_local_data_status: number | null;
    rb_local_deleted: number | null;
    rb_local_synced: number | null;
    usn: number | null;
    rb_local_usn: number | null;
    created_at: Date | null;
    updated_at: Date | null;
    HotCueBanklistID: string | null;
    Cues: string | null;
    rb_cue_count: number | null;
  }
  interface DjmdProperty {
    created_at: Date | null;
    updated_at: Date | null;
    DBID: string | null;
    DBVersion: string | null;
    BaseDBDrive: string | null;
    CurrentDBDrive: string | null;
    DeviceID: string | null;
    Reserved1: string | null;
    Reserved2: string | null;
    Reserved3: string | null;
    Reserved4: string | null;
    Reserved5: string | null;
  }
  interface ImageFile {
    ID: string | null;
    UUID: string | null;
    rb_data_status: number | null;
    rb_local_data_status: number | null;
    rb_local_deleted: number | null;
    rb_local_synced: number | null;
    usn: number | null;
    rb_local_usn: number | null;
    created_at: Date | null;
    updated_at: Date | null;
    TableName: string | null;
    TargetUUID: string | null;
    TargetID: string | null;
    Path: string | null;
    Hash: string | null;
    Size: number | null;
    rb_local_path: string | null;
    rb_insync_hash: string | null;
    rb_insync_local_usn: number | null;
    rb_file_hash_dirty: number | null;
    rb_local_file_status: number | null;
    rb_in_progress: number | null;
    rb_process_type: number | null;
    rb_temp_path: string | null;
    rb_priority: number | null;
    rb_file_size_dirty: number | null;
  }
  interface SettingFile {
    ID: string | null;
    UUID: string | null;
    rb_data_status: number | null;
    rb_local_data_status: number | null;
    rb_local_deleted: number | null;
    rb_local_synced: number | null;
    usn: number | null;
    rb_local_usn: number | null;
    created_at: Date | null;
    updated_at: Date | null;
    Path: string | null;
    Hash: string | null;
    Size: number | null;
    rb_local_path: string | null;
    rb_insync_hash: string | null;
    rb_insync_local_usn: number | null;
    rb_file_hash_dirty: number | null;
    rb_file_size_dirty: number | null;
  }
  interface UuidIDMap {
    ID: string | null;
    UUID: string | null;
    rb_data_status: number | null;
    rb_local_data_status: number | null;
    rb_local_deleted: number | null;
    rb_local_synced: number | null;
    usn: number | null;
    rb_local_usn: number | null;
    created_at: Date | null;
    updated_at: Date | null;
    TableName: string | null;
    TargetUUID: string | null;
    CurrentID: string | null;
  }
}

export {};
