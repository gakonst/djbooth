use std::path::Path;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

pub const FILE_HEADER_LEN: usize = 28;
const TAG_HEADER_LEN: usize = 12;
const VBR_ENTRY_COUNT: usize = 400;
/// Number of entries in Rekordbox's FLAC `PVB2` seek table.
pub const PVB2_ENTRY_COUNT: usize = 400;
const PVB2_HEADER_LEN: usize = 32;
const PVB2_ENTRY_BYTES: usize = 20;
const PREVIEW_ENTRY_COUNT: usize = 400;
const TINY_PREVIEW_ENTRY_COUNT: usize = 100;
const CANONICAL_FILE_HEADER_TAIL: [u8; 16] = [
    0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
];

fn read_be_u16(data: &[u8], offset: usize, context: &str) -> Result<u16> {
    let bytes = data
        .get(offset..offset + 2)
        .with_context(|| format!("missing {context} at byte {offset}"))?;
    Ok(u16::from_be_bytes(
        bytes.try_into().expect("two-byte slice"),
    ))
}

fn read_be_u32(data: &[u8], offset: usize, context: &str) -> Result<u32> {
    let bytes = data
        .get(offset..offset + 4)
        .with_context(|| format!("missing {context} at byte {offset}"))?;
    Ok(u32::from_be_bytes(
        bytes.try_into().expect("four-byte slice"),
    ))
}

fn read_be_u64(data: &[u8], offset: usize, context: &str) -> Result<u64> {
    let bytes = data
        .get(offset..offset + 8)
        .with_context(|| format!("missing {context} at byte {offset}"))?;
    Ok(u64::from_be_bytes(
        bytes.try_into().expect("eight-byte slice"),
    ))
}

fn write_be_u16(data: &mut [u8], offset: usize, value: u16) {
    data[offset..offset + 2].copy_from_slice(&value.to_be_bytes());
}

fn write_be_u32(data: &mut [u8], offset: usize, value: u32) {
    data[offset..offset + 4].copy_from_slice(&value.to_be_bytes());
}

fn write_be_u64(data: &mut [u8], offset: usize, value: u64) {
    data[offset..offset + 8].copy_from_slice(&value.to_be_bytes());
}

fn checked_u32(value: usize, context: &str) -> Result<u32> {
    u32::try_from(value).with_context(|| format!("{context} exceeds the ANLZ u32 length limit"))
}

fn fourcc(data: &[u8]) -> Result<[u8; 4]> {
    data.get(..4)
        .context("missing ANLZ fourcc")?
        .try_into()
        .map_err(Into::into)
}

fn fourcc_text(value: &[u8; 4]) -> String {
    String::from_utf8_lossy(value).into_owned()
}

/// One losslessly retained ANLZ tagged section.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnlzTag {
    raw: Vec<u8>,
}

impl AnlzTag {
    /// Parse one complete tag and reject trailing or truncated bytes.
    pub fn parse(raw: &[u8]) -> Result<Self> {
        if raw.len() < TAG_HEADER_LEN {
            bail!("ANLZ tag is shorter than its {TAG_HEADER_LEN}-byte envelope");
        }
        let kind = fourcc(raw)?;
        let header_len = read_be_u32(raw, 4, "tag header length")? as usize;
        let total_len = read_be_u32(raw, 8, "tag total length")? as usize;
        if header_len < TAG_HEADER_LEN || header_len > total_len {
            bail!(
                "{} has invalid header length {header_len} for total length {total_len}",
                fourcc_text(&kind)
            );
        }
        if total_len != raw.len() {
            bail!(
                "{} declares {total_len} bytes but received {}",
                fourcc_text(&kind),
                raw.len()
            );
        }
        Ok(Self { raw: raw.to_vec() })
    }

    /// Four-byte section identifier.
    pub fn kind(&self) -> [u8; 4] {
        self.raw[..4].try_into().expect("validated fourcc")
    }

    /// Printable section identifier.
    pub fn kind_text(&self) -> String {
        fourcc_text(&self.kind())
    }

    /// Declared section-header length.
    pub fn header_len(&self) -> usize {
        u32::from_be_bytes(self.raw[4..8].try_into().expect("validated header")) as usize
    }

    /// Complete section bytes, including its envelope.
    pub fn raw(&self) -> &[u8] {
        &self.raw
    }

    /// Section bytes following the declared section header.
    pub fn payload(&self) -> &[u8] {
        &self.raw[self.header_len()..]
    }
}

/// One losslessly retained PMAI analysis file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnlzFile {
    header: Vec<u8>,
    tags: Vec<AnlzTag>,
}

impl AnlzFile {
    /// Parse a DAT, EXT, or 2EX file while retaining every unknown byte.
    pub fn parse(data: &[u8]) -> Result<Self> {
        if data.len() < FILE_HEADER_LEN {
            bail!("ANLZ file is shorter than its {FILE_HEADER_LEN}-byte PMAI header");
        }
        if data.get(..4) != Some(b"PMAI") {
            bail!("ANLZ file is missing the PMAI signature");
        }
        let header_len = read_be_u32(data, 4, "PMAI header length")? as usize;
        let total_len = read_be_u32(data, 8, "PMAI total length")? as usize;
        if header_len < FILE_HEADER_LEN || header_len > total_len {
            bail!("PMAI has invalid header length {header_len} for total length {total_len}");
        }
        if total_len != data.len() {
            bail!(
                "PMAI declares {total_len} bytes but received {}",
                data.len()
            );
        }

        let mut tags = Vec::new();
        let mut offset = header_len;
        while offset < total_len {
            let tag_len = read_be_u32(data, offset + 8, "tag total length")? as usize;
            if tag_len < TAG_HEADER_LEN {
                bail!("tag at byte {offset} declares invalid length {tag_len}");
            }
            let end = offset
                .checked_add(tag_len)
                .context("ANLZ tag length overflow")?;
            let raw = data
                .get(offset..end)
                .with_context(|| format!("tag at byte {offset} exceeds PMAI length"))?;
            tags.push(AnlzTag::parse(raw)?);
            offset = end;
        }
        if offset != total_len {
            bail!("ANLZ tag traversal ended at {offset}, expected {total_len}");
        }
        Ok(Self {
            header: data[..header_len].to_vec(),
            tags,
        })
    }

    /// Read and parse an analysis file.
    pub fn read(path: &Path) -> Result<Self> {
        let data = std::fs::read(path)
            .with_context(|| format!("failed to read ANLZ file {}", path.display()))?;
        Self::parse(&data)
    }

    /// Build a canonical PMAI container from ordered tags.
    pub fn from_tags(tags: Vec<AnlzTag>) -> Result<Self> {
        let mut header = vec![0; FILE_HEADER_LEN];
        header[..4].copy_from_slice(b"PMAI");
        write_be_u32(&mut header, 4, FILE_HEADER_LEN as u32);
        header[12..].copy_from_slice(&CANONICAL_FILE_HEADER_TAIL);
        let mut file = Self { header, tags };
        file.refresh_total_len()?;
        Ok(file)
    }

    /// Ordered sections, including repeated and unknown tags.
    pub fn tags(&self) -> &[AnlzTag] {
        &self.tags
    }

    /// Rebuild bytes. Untouched parsed files are byte-for-byte identical.
    pub fn to_bytes(&self) -> Result<Vec<u8>> {
        let total_len =
            self.header.len() + self.tags.iter().map(|tag| tag.raw().len()).sum::<usize>();
        let mut header = self.header.clone();
        write_be_u32(&mut header, 8, checked_u32(total_len, "PMAI file")?);
        let mut output = Vec::with_capacity(total_len);
        output.extend_from_slice(&header);
        for tag in &self.tags {
            output.extend_from_slice(tag.raw());
        }
        Ok(output)
    }

    fn refresh_total_len(&mut self) -> Result<()> {
        let total_len =
            self.header.len() + self.tags.iter().map(|tag| tag.raw().len()).sum::<usize>();
        write_be_u32(&mut self.header, 8, checked_u32(total_len, "PMAI file")?);
        Ok(())
    }
}

/// Raw values stored in one standard PQTZ beat-grid entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct BeatGridEntry {
    pub beat: u16,
    pub bpm_hundredths: u16,
    pub time_ms: u32,
}

/// Fully understood DAT analysis primitives.
///
/// Cue sections are retained losslessly because non-empty PCOB entry semantics
/// are not yet implemented by the clean-room writer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DatAnalysis {
    pub path: String,
    pub vbr_header_unknown: u32,
    pub vbr_index: Vec<u32>,
    pub vbr_trailer_unknown: u32,
    pub beat_grid: Vec<BeatGridEntry>,
    pub preview_waveform: Vec<u8>,
    pub tiny_preview_waveform: Vec<u8>,
    pub hot_cues: AnlzTag,
    pub memory_cues: AnlzTag,
}

impl DatAnalysis {
    /// Decode the canonical seven-section DAT shape emitted by Rekordbox 6.8.2.
    pub fn parse(file: &AnlzFile) -> Result<Self> {
        let tags = file.tags();
        let expected = [
            b"PPTH", b"PVBR", b"PQTZ", b"PWAV", b"PWV2", b"PCOB", b"PCOB",
        ];
        if tags.len() != expected.len() {
            bail!(
                "canonical DAT requires {} tags, found {}",
                expected.len(),
                tags.len()
            );
        }
        for (index, expected_kind) in expected.iter().enumerate() {
            if tags[index].kind().as_slice() != *expected_kind {
                bail!(
                    "canonical DAT tag {index} must be {}, found {}",
                    String::from_utf8_lossy(*expected_kind),
                    tags[index].kind_text()
                );
            }
        }
        let (vbr_header_unknown, vbr_index, vbr_trailer_unknown) = parse_vbr_tag(&tags[1])?;
        Ok(Self {
            path: parse_path_tag(&tags[0])?,
            vbr_header_unknown,
            vbr_index,
            vbr_trailer_unknown,
            beat_grid: parse_beat_grid_tag(&tags[2])?,
            preview_waveform: parse_waveform_tag(&tags[3], *b"PWAV", PREVIEW_ENTRY_COUNT)?,
            tiny_preview_waveform: parse_waveform_tag(
                &tags[4],
                *b"PWV2",
                TINY_PREVIEW_ENTRY_COUNT,
            )?,
            hot_cues: tags[5].clone(),
            memory_cues: tags[6].clone(),
        })
    }

    /// Rebuild the canonical DAT shape from semantic primitives.
    pub fn to_file(&self) -> Result<AnlzFile> {
        if self.vbr_index.len() != VBR_ENTRY_COUNT {
            bail!(
                "PVBR requires {VBR_ENTRY_COUNT} entries, found {}",
                self.vbr_index.len()
            );
        }
        if self.preview_waveform.len() != PREVIEW_ENTRY_COUNT {
            bail!(
                "PWAV requires {PREVIEW_ENTRY_COUNT} entries, found {}",
                self.preview_waveform.len()
            );
        }
        if self.tiny_preview_waveform.len() != TINY_PREVIEW_ENTRY_COUNT {
            bail!(
                "PWV2 requires {TINY_PREVIEW_ENTRY_COUNT} entries, found {}",
                self.tiny_preview_waveform.len()
            );
        }
        if self.hot_cues.kind() != *b"PCOB" || self.memory_cues.kind() != *b"PCOB" {
            bail!("DAT cue sections must both be PCOB tags");
        }
        AnlzFile::from_tags(vec![
            build_path_tag(&self.path)?,
            build_vbr_tag_with_unknowns(
                self.vbr_header_unknown,
                &self.vbr_index,
                self.vbr_trailer_unknown,
            )?,
            build_beat_grid_tag(&self.beat_grid)?,
            build_waveform_tag(*b"PWAV", &self.preview_waveform)?,
            build_waveform_tag(*b"PWV2", &self.tiny_preview_waveform)?,
            self.hot_cues.clone(),
            self.memory_cues.clone(),
        ])
    }
}

/// A variable-length waveform section whose entry size and unknown format word
/// are preserved explicitly.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CountedWaveform {
    pub kind: [u8; 4],
    pub entry_bytes: u32,
    pub header_unknown: Option<u32>,
    pub entries: Vec<u8>,
}

impl CountedWaveform {
    /// Decode PWV3 through PWV7 without interpreting proprietary DSP values.
    pub fn parse(tag: &AnlzTag) -> Result<Self> {
        let kind = tag.kind();
        let expected_header = match &kind {
            b"PWV3" | b"PWV4" | b"PWV5" | b"PWV7" => 24,
            b"PWV6" => 20,
            _ => bail!("{} is not a counted waveform tag", fourcc_text(&kind)),
        };
        if tag.header_len() != expected_header {
            bail!(
                "{} requires a {expected_header}-byte header",
                fourcc_text(&kind)
            );
        }
        let entry_bytes = read_be_u32(tag.raw(), 12, "waveform entry size")?;
        let entry_count = read_be_u32(tag.raw(), 16, "waveform entry count")? as usize;
        let payload_len = entry_count
            .checked_mul(entry_bytes as usize)
            .context("waveform payload length overflow")?;
        if tag.raw().len() != expected_header + payload_len {
            bail!(
                "{} entry shape does not match its byte length",
                fourcc_text(&kind)
            );
        }
        Ok(Self {
            kind,
            entry_bytes,
            header_unknown: (expected_header == 24)
                .then(|| read_be_u32(tag.raw(), 20, "waveform header unknown"))
                .transpose()?,
            entries: tag.raw()[expected_header..].to_vec(),
        })
    }

    /// Rebuild the section without altering entry bytes or unknown fields.
    pub fn to_tag(&self) -> Result<AnlzTag> {
        build_counted_waveform_tag(
            self.kind,
            self.entry_bytes,
            self.header_unknown,
            &self.entries,
        )
    }
}

/// Raw and partially understood fields of one PQT2 extended beat grid.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtendedBeatGrid {
    pub unknown_1: u32,
    pub format: u32,
    pub unknown_2: u32,
    pub anchors: [BeatGridEntry; 2],
    /// Wrapping sum of `beat + bpm_hundredths + time_ms` over every PQTZ entry.
    ///
    /// The compatibility-oriented field name predates the clean-room corpus proof.
    pub unknown_3: u32,
    pub unknown_4: u32,
    pub unknown_5: u32,
    /// Big-endian microsecond remainders (`0..=999`) paired with PQTZ entries.
    pub entries: Vec<[u8; 2]>,
}

impl ExtendedBeatGrid {
    /// Decode one PQT2 tag and retain all not-yet-understood words.
    pub fn parse(tag: &AnlzTag) -> Result<Self> {
        if tag.kind() != *b"PQT2" || tag.header_len() != 56 {
            bail!("expected a 56-byte PQT2 tag");
        }
        let entry_count = read_be_u32(tag.raw(), 40, "PQT2 entry count")? as usize;
        if tag.raw().len() != 56 + entry_count * 2 {
            bail!("PQT2 entry count does not match its byte length");
        }
        let read_anchor = |offset| -> Result<BeatGridEntry> {
            Ok(BeatGridEntry {
                beat: read_be_u16(tag.raw(), offset, "PQT2 anchor beat")?,
                bpm_hundredths: read_be_u16(tag.raw(), offset + 2, "PQT2 anchor BPM")?,
                time_ms: read_be_u32(tag.raw(), offset + 4, "PQT2 anchor time")?,
            })
        };
        let entries = tag.raw()[56..]
            .chunks_exact(2)
            .map(|entry| [entry[0], entry[1]])
            .collect();
        Ok(Self {
            unknown_1: read_be_u32(tag.raw(), 12, "PQT2 unknown 1")?,
            format: read_be_u32(tag.raw(), 16, "PQT2 format")?,
            unknown_2: read_be_u32(tag.raw(), 20, "PQT2 unknown 2")?,
            anchors: [read_anchor(24)?, read_anchor(32)?],
            unknown_3: read_be_u32(tag.raw(), 44, "PQT2 unknown 3")?,
            unknown_4: read_be_u32(tag.raw(), 48, "PQT2 unknown 4")?,
            unknown_5: read_be_u32(tag.raw(), 52, "PQT2 unknown 5")?,
            entries,
        })
    }

    /// Rebuild the section without altering unknown or entry bytes.
    pub fn to_tag(&self) -> Result<AnlzTag> {
        build_extended_beat_grid_tag(self)
    }
}

/// Complete canonical EXT analysis primitives.
///
/// Cue tags and retained song-structure tags stay opaque so unknown fields and
/// optional on-disk PSSI obfuscation round-trip without loss. New clean-room
/// song structures are synthesized by the phrase module before insertion.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtAnalysis {
    pub path: String,
    pub detail_waveform: CountedWaveform,
    pub hot_cues: AnlzTag,
    pub memory_cues: AnlzTag,
    pub hot_cues_extended: AnlzTag,
    pub memory_cues_extended: AnlzTag,
    pub extended_beat_grid: ExtendedBeatGrid,
    pub color_detail_waveform: CountedWaveform,
    pub color_preview_waveform: CountedWaveform,
    pub vbr_2: Option<AnlzTag>,
    pub song_structure: AnlzTag,
}

impl ExtAnalysis {
    /// Decode the EXT shape emitted by Rekordbox 6.8.2, preserving optional PVB2.
    pub fn parse(file: &AnlzFile) -> Result<Self> {
        let tags = file.tags();
        let expected_without_vbr = [
            *b"PPTH", *b"PWV3", *b"PCOB", *b"PCOB", *b"PCO2", *b"PCO2", *b"PQT2", *b"PWV5",
            *b"PWV4", *b"PSSI",
        ];
        let expected_with_vbr = [
            *b"PPTH", *b"PWV3", *b"PCOB", *b"PCOB", *b"PCO2", *b"PCO2", *b"PQT2", *b"PWV5",
            *b"PWV4", *b"PVB2", *b"PSSI",
        ];
        let has_vbr_2 = tags.get(9).is_some_and(|tag| tag.kind() == *b"PVB2");
        require_tag_order(
            tags,
            if has_vbr_2 {
                &expected_with_vbr
            } else {
                &expected_without_vbr
            },
            "EXT",
        )?;
        Ok(Self {
            path: parse_path_tag(&tags[0])?,
            detail_waveform: CountedWaveform::parse(&tags[1])?,
            hot_cues: tags[2].clone(),
            memory_cues: tags[3].clone(),
            hot_cues_extended: tags[4].clone(),
            memory_cues_extended: tags[5].clone(),
            extended_beat_grid: ExtendedBeatGrid::parse(&tags[6])?,
            color_detail_waveform: CountedWaveform::parse(&tags[7])?,
            color_preview_waveform: CountedWaveform::parse(&tags[8])?,
            vbr_2: has_vbr_2.then(|| tags[9].clone()),
            song_structure: tags[usize::from(has_vbr_2) + 9].clone(),
        })
    }

    /// Rebuild the canonical EXT shape from its retained primitives.
    pub fn to_file(&self) -> Result<AnlzFile> {
        require_kind(&self.detail_waveform.kind, b"PWV3", "detail waveform")?;
        require_kind(
            &self.color_detail_waveform.kind,
            b"PWV5",
            "color detail waveform",
        )?;
        require_kind(
            &self.color_preview_waveform.kind,
            b"PWV4",
            "color preview waveform",
        )?;
        for (tag, kind, context) in [
            (&self.hot_cues, b"PCOB", "hot cues"),
            (&self.memory_cues, b"PCOB", "memory cues"),
            (&self.hot_cues_extended, b"PCO2", "extended hot cues"),
            (&self.memory_cues_extended, b"PCO2", "extended memory cues"),
            (&self.song_structure, b"PSSI", "song structure"),
        ] {
            require_kind(&tag.kind(), kind, context)?;
        }
        if let Some(vbr_2) = &self.vbr_2 {
            require_kind(&vbr_2.kind(), b"PVB2", "secondary VBR index")?;
        }
        let mut tags = vec![
            build_path_tag(&self.path)?,
            self.detail_waveform.to_tag()?,
            self.hot_cues.clone(),
            self.memory_cues.clone(),
            self.hot_cues_extended.clone(),
            self.memory_cues_extended.clone(),
            self.extended_beat_grid.to_tag()?,
            self.color_detail_waveform.to_tag()?,
            self.color_preview_waveform.to_tag()?,
        ];
        tags.extend(self.vbr_2.iter().cloned());
        tags.push(self.song_structure.clone());
        AnlzFile::from_tags(tags)
    }
}

/// Three u16 values and one unknown u16 stored in PWVC.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WaveformColorConfig {
    pub unknown: u16,
    pub data: [u16; 3],
}

impl WaveformColorConfig {
    /// Decode one PWVC tag.
    pub fn parse(tag: &AnlzTag) -> Result<Self> {
        if tag.kind() != *b"PWVC" || tag.header_len() != 14 || tag.raw().len() != 20 {
            bail!("expected a 20-byte PWVC tag with a 14-byte header");
        }
        Ok(Self {
            unknown: read_be_u16(tag.raw(), 12, "PWVC unknown")?,
            data: [
                read_be_u16(tag.raw(), 14, "PWVC data 0")?,
                read_be_u16(tag.raw(), 16, "PWVC data 1")?,
                read_be_u16(tag.raw(), 18, "PWVC data 2")?,
            ],
        })
    }

    /// Rebuild one PWVC tag.
    pub fn to_tag(&self) -> Result<AnlzTag> {
        build_waveform_color_config_tag(*self)
    }
}

/// Complete canonical 2EX three-band waveform primitives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreeBandAnalysis {
    pub path: String,
    pub detail_waveform: CountedWaveform,
    pub preview_waveform: CountedWaveform,
    pub color_config: WaveformColorConfig,
}

impl ThreeBandAnalysis {
    /// Decode the four-section 2EX shape emitted by Rekordbox 6.8.2.
    pub fn parse(file: &AnlzFile) -> Result<Self> {
        let tags = file.tags();
        let expected = [*b"PPTH", *b"PWV7", *b"PWV6", *b"PWVC"];
        require_tag_order(tags, &expected, "2EX")?;
        Ok(Self {
            path: parse_path_tag(&tags[0])?,
            detail_waveform: CountedWaveform::parse(&tags[1])?,
            preview_waveform: CountedWaveform::parse(&tags[2])?,
            color_config: WaveformColorConfig::parse(&tags[3])?,
        })
    }

    /// Rebuild the canonical 2EX shape from its retained primitives.
    pub fn to_file(&self) -> Result<AnlzFile> {
        require_kind(
            &self.detail_waveform.kind,
            b"PWV7",
            "three-band detail waveform",
        )?;
        require_kind(
            &self.preview_waveform.kind,
            b"PWV6",
            "three-band preview waveform",
        )?;
        AnlzFile::from_tags(vec![
            build_path_tag(&self.path)?,
            self.detail_waveform.to_tag()?,
            self.preview_waveform.to_tag()?,
            self.color_config.to_tag()?,
        ])
    }
}

fn require_tag_order(tags: &[AnlzTag], expected: &[[u8; 4]], context: &str) -> Result<()> {
    if tags.len() != expected.len() {
        bail!(
            "canonical {context} requires {} tags, found {}",
            expected.len(),
            tags.len()
        );
    }
    for (index, expected_kind) in expected.iter().enumerate() {
        if tags[index].kind() != *expected_kind {
            bail!(
                "canonical {context} tag {index} must be {}, found {}",
                fourcc_text(expected_kind),
                tags[index].kind_text()
            );
        }
    }
    Ok(())
}

fn require_kind(actual: &[u8; 4], expected: &[u8; 4], context: &str) -> Result<()> {
    if actual != expected {
        bail!(
            "{context} must be {}, found {}",
            fourcc_text(expected),
            fourcc_text(actual)
        );
    }
    Ok(())
}

/// Build a PPTH tag using Rekordbox's UTF-16BE path representation.
pub fn build_path_tag(path: &str) -> Result<AnlzTag> {
    let normalized = path.replace('\\', "/");
    let mut encoded = Vec::with_capacity(normalized.len() * 2 + 2);
    for unit in normalized.encode_utf16() {
        encoded.extend_from_slice(&unit.to_be_bytes());
    }
    encoded.extend_from_slice(&[0, 0]);
    let total_len = 16usize
        .checked_add(encoded.len())
        .context("PPTH length overflow")?;
    let mut raw = vec![0; total_len];
    raw[..4].copy_from_slice(b"PPTH");
    write_be_u32(&mut raw, 4, 16);
    write_be_u32(&mut raw, 8, checked_u32(total_len, "PPTH tag")?);
    write_be_u32(&mut raw, 12, checked_u32(encoded.len(), "PPTH path")?);
    raw[16..].copy_from_slice(&encoded);
    AnlzTag::parse(&raw)
}

fn parse_path_tag(tag: &AnlzTag) -> Result<String> {
    if tag.kind() != *b"PPTH" || tag.header_len() != 16 {
        bail!("expected a 16-byte PPTH tag");
    }
    let encoded_len = read_be_u32(tag.raw(), 12, "PPTH path length")? as usize;
    if encoded_len < 2 || !encoded_len.is_multiple_of(2) || 16 + encoded_len != tag.raw().len() {
        bail!("PPTH has invalid UTF-16BE byte length {encoded_len}");
    }
    let encoded = &tag.raw()[16..16 + encoded_len - 2];
    let units = encoded
        .chunks_exact(2)
        .map(|bytes| u16::from_be_bytes([bytes[0], bytes[1]]))
        .collect::<Vec<_>>();
    String::from_utf16(&units).context("PPTH contains invalid UTF-16BE")
}

/// Build the fixed 400-entry PVBR seek table.
pub fn build_vbr_tag(entries: &[u32]) -> Result<AnlzTag> {
    build_vbr_tag_with_unknowns(0, entries, 0)
}

/// Build a PVBR seek table while preserving both still-unknown surrounding words.
pub fn build_vbr_tag_with_unknowns(
    header_unknown: u32,
    entries: &[u32],
    trailer_unknown: u32,
) -> Result<AnlzTag> {
    if entries.len() != VBR_ENTRY_COUNT {
        bail!(
            "PVBR requires {VBR_ENTRY_COUNT} entries, found {}",
            entries.len()
        );
    }
    let mut raw = vec![0; 20 + entries.len() * 4];
    let raw_len = raw.len();
    raw[..4].copy_from_slice(b"PVBR");
    write_be_u32(&mut raw, 4, 16);
    write_be_u32(&mut raw, 8, checked_u32(raw_len, "PVBR tag")?);
    write_be_u32(&mut raw, 12, header_unknown);
    for (index, value) in entries.iter().enumerate() {
        write_be_u32(&mut raw, 16 + index * 4, *value);
    }
    write_be_u32(&mut raw, 16 + entries.len() * 4, trailer_unknown);
    AnlzTag::parse(&raw)
}

fn parse_vbr_tag(tag: &AnlzTag) -> Result<(u32, Vec<u32>, u32)> {
    if tag.kind() != *b"PVBR"
        || tag.header_len() != 16
        || tag.raw().len() != 20 + VBR_ENTRY_COUNT * 4
    {
        bail!("expected a canonical 400-entry PVBR tag");
    }
    let header_unknown = read_be_u32(tag.raw(), 12, "PVBR header unknown")?;
    let entries = (0..VBR_ENTRY_COUNT)
        .map(|index| read_be_u32(tag.raw(), 16 + index * 4, "PVBR entry"))
        .collect::<Result<Vec<_>>>()?;
    let trailer_unknown = read_be_u32(tag.raw(), 16 + VBR_ENTRY_COUNT * 4, "PVBR trailer unknown")?;
    Ok((header_unknown, entries, trailer_unknown))
}

/// One Rekordbox FLAC `PVB2` seek-table entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Pvb2Entry {
    /// First interchannel sample represented by the selected FLAC frame.
    pub sample_index: u64,
    /// FLAC frame-header byte offset relative to the first audio frame.
    pub byte_offset: u64,
    /// Interchannel samples represented by the selected FLAC frame.
    pub frame_block_samples: u32,
}

/// Semantic fields of one canonical 400-entry FLAC `PVB2` tag.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pvb2Table {
    /// Total interchannel samples from FLAC STREAMINFO.
    pub total_samples: u32,
    /// Floor-targeted FLAC frame locations.
    pub entries: Vec<Pvb2Entry>,
}

impl Pvb2Table {
    /// Parse a canonical Rekordbox FLAC `PVB2` tag.
    pub fn parse(tag: &AnlzTag) -> Result<Self> {
        if tag.kind() != *b"PVB2"
            || tag.header_len() != PVB2_HEADER_LEN
            || tag.raw().len() != PVB2_HEADER_LEN + PVB2_ENTRY_COUNT * PVB2_ENTRY_BYTES
        {
            bail!("expected a canonical 400-entry PVB2 tag");
        }
        if read_be_u32(tag.raw(), 12, "PVB2 reserved word 0")? != 0
            || read_be_u32(tag.raw(), 16, "PVB2 reserved word 1")? != 0
            || read_be_u32(tag.raw(), 24, "PVB2 entry count")? as usize != PVB2_ENTRY_COUNT
            || read_be_u32(tag.raw(), 28, "PVB2 entry size")? as usize != PVB2_ENTRY_BYTES
        {
            bail!("PVB2 has unsupported reserved, count, or entry-size fields");
        }
        let entries = (0..PVB2_ENTRY_COUNT)
            .map(|index| {
                let offset = PVB2_HEADER_LEN + index * PVB2_ENTRY_BYTES;
                Ok(Pvb2Entry {
                    sample_index: read_be_u64(tag.raw(), offset, "PVB2 sample index")?,
                    byte_offset: read_be_u64(tag.raw(), offset + 8, "PVB2 byte offset")?,
                    frame_block_samples: read_be_u32(
                        tag.raw(),
                        offset + 16,
                        "PVB2 frame block size",
                    )?,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(Self {
            total_samples: read_be_u32(tag.raw(), 20, "PVB2 total samples")?,
            entries,
        })
    }

    /// Build the canonical 8,032-byte Rekordbox FLAC `PVB2` tag.
    pub fn to_tag(&self) -> Result<AnlzTag> {
        if self.entries.len() != PVB2_ENTRY_COUNT {
            bail!(
                "PVB2 requires {PVB2_ENTRY_COUNT} entries, found {}",
                self.entries.len()
            );
        }
        let total_len = PVB2_HEADER_LEN + PVB2_ENTRY_COUNT * PVB2_ENTRY_BYTES;
        let mut raw = vec![0_u8; total_len];
        raw[..4].copy_from_slice(b"PVB2");
        write_be_u32(&mut raw, 4, PVB2_HEADER_LEN as u32);
        write_be_u32(&mut raw, 8, total_len as u32);
        write_be_u32(&mut raw, 20, self.total_samples);
        write_be_u32(&mut raw, 24, PVB2_ENTRY_COUNT as u32);
        write_be_u32(&mut raw, 28, PVB2_ENTRY_BYTES as u32);
        for (index, entry) in self.entries.iter().enumerate() {
            let offset = PVB2_HEADER_LEN + index * PVB2_ENTRY_BYTES;
            write_be_u64(&mut raw, offset, entry.sample_index);
            write_be_u64(&mut raw, offset + 8, entry.byte_offset);
            write_be_u32(&mut raw, offset + 16, entry.frame_block_samples);
        }
        AnlzTag::parse(&raw)
    }
}

/// Build a standard PQTZ beat grid.
pub fn build_beat_grid_tag(entries: &[BeatGridEntry]) -> Result<AnlzTag> {
    let total_len = 24usize
        .checked_add(
            entries
                .len()
                .checked_mul(8)
                .context("PQTZ entry length overflow")?,
        )
        .context("PQTZ tag length overflow")?;
    let mut raw = vec![0; total_len];
    raw[..4].copy_from_slice(b"PQTZ");
    write_be_u32(&mut raw, 4, 24);
    write_be_u32(&mut raw, 8, checked_u32(total_len, "PQTZ tag")?);
    write_be_u32(&mut raw, 16, 0x0008_0000);
    write_be_u32(
        &mut raw,
        20,
        checked_u32(entries.len(), "PQTZ entry count")?,
    );
    for (index, entry) in entries.iter().enumerate() {
        let offset = 24 + index * 8;
        write_be_u16(&mut raw, offset, entry.beat);
        write_be_u16(&mut raw, offset + 2, entry.bpm_hundredths);
        write_be_u32(&mut raw, offset + 4, entry.time_ms);
    }
    AnlzTag::parse(&raw)
}

fn parse_beat_grid_tag(tag: &AnlzTag) -> Result<Vec<BeatGridEntry>> {
    if tag.kind() != *b"PQTZ" || tag.header_len() != 24 {
        bail!("expected a 24-byte PQTZ tag");
    }
    if read_be_u32(tag.raw(), 12, "PQTZ reserved field")? != 0
        || read_be_u32(tag.raw(), 16, "PQTZ format field")? != 0x0008_0000
    {
        bail!("PQTZ has unsupported reserved or format fields");
    }
    let count = read_be_u32(tag.raw(), 20, "PQTZ entry count")? as usize;
    if tag.raw().len() != 24 + count * 8 {
        bail!("PQTZ entry count does not match its byte length");
    }
    (0..count)
        .map(|index| {
            let offset = 24 + index * 8;
            Ok(BeatGridEntry {
                beat: read_be_u16(tag.raw(), offset, "PQTZ beat")?,
                bpm_hundredths: read_be_u16(tag.raw(), offset + 2, "PQTZ BPM")?,
                time_ms: read_be_u32(tag.raw(), offset + 4, "PQTZ time")?,
            })
        })
        .collect()
}

/// Build PWAV or PWV2 packed monochrome waveform bytes.
pub fn build_waveform_tag(kind: [u8; 4], entries: &[u8]) -> Result<AnlzTag> {
    if kind != *b"PWAV" && kind != *b"PWV2" {
        bail!("monochrome DAT waveform must be PWAV or PWV2");
    }
    let expected = if kind == *b"PWAV" {
        PREVIEW_ENTRY_COUNT
    } else {
        TINY_PREVIEW_ENTRY_COUNT
    };
    if entries.len() != expected {
        bail!(
            "{} requires {expected} entries, found {}",
            fourcc_text(&kind),
            entries.len()
        );
    }
    let mut raw = vec![0; 20 + entries.len()];
    let raw_len = raw.len();
    raw[..4].copy_from_slice(&kind);
    write_be_u32(&mut raw, 4, 20);
    write_be_u32(&mut raw, 8, checked_u32(raw_len, "waveform tag")?);
    write_be_u32(
        &mut raw,
        12,
        checked_u32(entries.len(), "waveform entry count")?,
    );
    write_be_u32(&mut raw, 16, 0x0001_0000);
    raw[20..].copy_from_slice(entries);
    AnlzTag::parse(&raw)
}

fn parse_waveform_tag(tag: &AnlzTag, kind: [u8; 4], count: usize) -> Result<Vec<u8>> {
    if tag.kind() != kind || tag.header_len() != 20 || tag.raw().len() != 20 + count {
        bail!(
            "expected a canonical {count}-entry {} tag",
            fourcc_text(&kind)
        );
    }
    if read_be_u32(tag.raw(), 12, "waveform entry count")? as usize != count
        || read_be_u32(tag.raw(), 16, "waveform format field")? != 0x0001_0000
    {
        bail!(
            "{} has unsupported count or format fields",
            fourcc_text(&kind)
        );
    }
    Ok(tag.raw()[20..].to_vec())
}

/// Build PWV3 through PWV7 from exact entry bytes.
pub fn build_counted_waveform_tag(
    kind: [u8; 4],
    entry_bytes: u32,
    header_unknown: Option<u32>,
    entries: &[u8],
) -> Result<AnlzTag> {
    let header_len = match &kind {
        b"PWV3" | b"PWV4" | b"PWV5" | b"PWV7" => 24,
        b"PWV6" => 20,
        _ => bail!("{} is not a counted waveform tag", fourcc_text(&kind)),
    };
    if entry_bytes == 0 || !entries.len().is_multiple_of(entry_bytes as usize) {
        bail!(
            "{} payload is not divisible by its {entry_bytes}-byte entry size",
            fourcc_text(&kind)
        );
    }
    if (header_len == 24) != header_unknown.is_some() {
        bail!(
            "{} requires {} header-unknown word",
            fourcc_text(&kind),
            if header_len == 24 { "one" } else { "no" }
        );
    }
    let total_len = header_len + entries.len();
    let mut raw = vec![0; total_len];
    raw[..4].copy_from_slice(&kind);
    write_be_u32(&mut raw, 4, header_len as u32);
    write_be_u32(&mut raw, 8, checked_u32(total_len, "waveform tag")?);
    write_be_u32(&mut raw, 12, entry_bytes);
    write_be_u32(
        &mut raw,
        16,
        checked_u32(entries.len() / entry_bytes as usize, "waveform entry count")?,
    );
    if let Some(unknown) = header_unknown {
        write_be_u32(&mut raw, 20, unknown);
    }
    raw[header_len..].copy_from_slice(entries);
    AnlzTag::parse(&raw)
}

/// Build a PQT2 extended beat grid while preserving unknown fields.
pub fn build_extended_beat_grid_tag(grid: &ExtendedBeatGrid) -> Result<AnlzTag> {
    let total_len = 56usize
        .checked_add(
            grid.entries
                .len()
                .checked_mul(2)
                .context("PQT2 payload length overflow")?,
        )
        .context("PQT2 tag length overflow")?;
    let mut raw = vec![0; total_len];
    raw[..4].copy_from_slice(b"PQT2");
    write_be_u32(&mut raw, 4, 56);
    write_be_u32(&mut raw, 8, checked_u32(total_len, "PQT2 tag")?);
    write_be_u32(&mut raw, 12, grid.unknown_1);
    write_be_u32(&mut raw, 16, grid.format);
    write_be_u32(&mut raw, 20, grid.unknown_2);
    for (index, anchor) in grid.anchors.iter().enumerate() {
        let offset = 24 + index * 8;
        write_be_u16(&mut raw, offset, anchor.beat);
        write_be_u16(&mut raw, offset + 2, anchor.bpm_hundredths);
        write_be_u32(&mut raw, offset + 4, anchor.time_ms);
    }
    write_be_u32(
        &mut raw,
        40,
        checked_u32(grid.entries.len(), "PQT2 entry count")?,
    );
    write_be_u32(&mut raw, 44, grid.unknown_3);
    write_be_u32(&mut raw, 48, grid.unknown_4);
    write_be_u32(&mut raw, 52, grid.unknown_5);
    for (index, entry) in grid.entries.iter().enumerate() {
        raw[56 + index * 2..58 + index * 2].copy_from_slice(entry);
    }
    AnlzTag::parse(&raw)
}

/// Build the small fixed PWVC color-configuration section.
pub fn build_waveform_color_config_tag(config: WaveformColorConfig) -> Result<AnlzTag> {
    let mut raw = vec![0; 20];
    raw[..4].copy_from_slice(b"PWVC");
    write_be_u32(&mut raw, 4, 14);
    write_be_u32(&mut raw, 8, 20);
    write_be_u16(&mut raw, 12, config.unknown);
    for (index, value) in config.data.iter().enumerate() {
        write_be_u16(&mut raw, 14 + index * 2, *value);
    }
    AnlzTag::parse(&raw)
}

/// Build an empty hot-cue (`cue_type = 1`) or memory-cue (`cue_type = 0`) PCOB tag.
pub fn build_empty_cue_tag(cue_type: u32) -> Result<AnlzTag> {
    if cue_type > 1 {
        bail!("PCOB cue type must be 0 (memory) or 1 (hot cue)");
    }
    let mut raw = vec![0; 24];
    raw[..4].copy_from_slice(b"PCOB");
    write_be_u32(&mut raw, 4, 24);
    write_be_u32(&mut raw, 8, 24);
    write_be_u32(&mut raw, 12, cue_type);
    write_be_u32(&mut raw, 20, u32::MAX);
    AnlzTag::parse(&raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synthetic_dat() -> DatAnalysis {
        DatAnalysis {
            path: "?/clean-room.wav".to_string(),
            vbr_header_unknown: 0,
            vbr_index: (0..VBR_ENTRY_COUNT as u32).collect(),
            vbr_trailer_unknown: 0x0122_b080,
            beat_grid: vec![
                BeatGridEntry {
                    beat: 1,
                    bpm_hundredths: 12_800,
                    time_ms: 250,
                },
                BeatGridEntry {
                    beat: 2,
                    bpm_hundredths: 12_800,
                    time_ms: 719,
                },
            ],
            preview_waveform: (0..PREVIEW_ENTRY_COUNT).map(|index| index as u8).collect(),
            tiny_preview_waveform: (0..TINY_PREVIEW_ENTRY_COUNT)
                .map(|index| (index * 2) as u8)
                .collect(),
            hot_cues: build_empty_cue_tag(1).expect("hot cues"),
            memory_cues: build_empty_cue_tag(0).expect("memory cues"),
        }
    }

    #[test]
    fn canonical_dat_semantic_roundtrip_is_byte_exact() {
        let first = synthetic_dat().to_file().expect("build DAT");
        let bytes = first.to_bytes().expect("serialize DAT");
        let parsed = AnlzFile::parse(&bytes).expect("parse DAT");
        let decoded = DatAnalysis::parse(&parsed).expect("decode DAT");
        let rebuilt = decoded.to_file().expect("rebuild DAT");
        assert_eq!(rebuilt.to_bytes().expect("serialize rebuilt DAT"), bytes);
    }

    #[test]
    fn canonical_pvb2_semantic_roundtrip_is_byte_exact() {
        let table = Pvb2Table {
            total_samples: 31_193_626,
            entries: (0..PVB2_ENTRY_COUNT)
                .map(|index| Pvb2Entry {
                    sample_index: index as u64 * 77_824,
                    byte_offset: index as u64 * 246_215,
                    frame_block_samples: 4_096,
                })
                .collect(),
        };
        let tag = table.to_tag().expect("build PVB2");
        assert_eq!(tag.kind(), *b"PVB2");
        assert_eq!(tag.header_len(), 32);
        assert_eq!(tag.raw().len(), 8_032);
        assert_eq!(&tag.raw()[12..20], &[0; 8]);
        assert_eq!(
            u32::from_be_bytes(tag.raw()[20..24].try_into().expect("sample count")),
            table.total_samples
        );
        assert_eq!(
            u32::from_be_bytes(tag.raw()[24..28].try_into().expect("entry count")),
            400
        );
        assert_eq!(
            u32::from_be_bytes(tag.raw()[28..32].try_into().expect("entry size")),
            20
        );

        let parsed = Pvb2Table::parse(&tag).expect("parse PVB2");
        assert_eq!(parsed, table);
        assert_eq!(parsed.to_tag().expect("rebuild PVB2").raw(), tag.raw());
    }

    #[test]
    fn malformed_pvb2_shape_fails_closed() {
        let table = Pvb2Table {
            total_samples: 1,
            entries: vec![
                Pvb2Entry {
                    sample_index: 0,
                    byte_offset: 0,
                    frame_block_samples: 1,
                };
                PVB2_ENTRY_COUNT
            ],
        };
        let mut raw = table.to_tag().expect("build PVB2").raw().to_vec();
        write_be_u32(&mut raw, 28, 16);
        let malformed = AnlzTag::parse(&raw).expect("generic tag envelope remains valid");
        assert!(Pvb2Table::parse(&malformed).is_err());
        assert!(
            Pvb2Table {
                total_samples: 1,
                entries: Vec::new(),
            }
            .to_tag()
            .is_err()
        );
    }

    #[test]
    fn parsed_unknown_bytes_roundtrip_without_changes() {
        let mut bytes = synthetic_dat()
            .to_file()
            .expect("build DAT")
            .to_bytes()
            .expect("serialize DAT");
        bytes[27] = 0xa5;
        let parsed = AnlzFile::parse(&bytes).expect("parse");
        assert_eq!(parsed.to_bytes().expect("serialize"), bytes);
    }

    #[test]
    fn malformed_lengths_fail_closed() {
        let mut bytes = synthetic_dat()
            .to_file()
            .expect("build DAT")
            .to_bytes()
            .expect("serialize DAT");
        write_be_u32(&mut bytes, 8, 12);
        assert!(AnlzFile::parse(&bytes).is_err());
    }

    #[test]
    fn packaged_rekordbox_templates_semantically_rebuild_byte_exact() {
        let template_root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/rekordbox-ts/vendor/rekordbox-analyzer-templates");
        if !template_root.is_dir() {
            // The clean crate package deliberately excludes repository-private oracle fixtures.
            return;
        }
        let dat = std::fs::read(template_root.join("ANLZ0000.DAT")).expect("read DAT template");
        let dat_file = AnlzFile::parse(&dat).expect("parse DAT template");
        let dat_rebuilt = DatAnalysis::parse(&dat_file)
            .expect("decode DAT template")
            .to_file()
            .expect("rebuild DAT template")
            .to_bytes()
            .expect("serialize DAT template");
        assert_eq!(dat_rebuilt, dat);

        let ext = std::fs::read(template_root.join("ANLZ0000.EXT")).expect("read EXT template");
        let ext_file = AnlzFile::parse(&ext).expect("parse EXT template");
        let ext_rebuilt = ExtAnalysis::parse(&ext_file)
            .expect("decode EXT template")
            .to_file()
            .expect("rebuild EXT template")
            .to_bytes()
            .expect("serialize EXT template");
        assert_eq!(ext_rebuilt, ext);
    }

    #[test]
    fn three_band_analysis_semantically_roundtrips() {
        let analysis = ThreeBandAnalysis {
            path: "?/clean-room.wav".to_string(),
            detail_waveform: CountedWaveform {
                kind: *b"PWV7",
                entry_bytes: 3,
                header_unknown: Some(0x0096_0000),
                entries: vec![1, 2, 3, 4, 5, 6],
            },
            preview_waveform: CountedWaveform {
                kind: *b"PWV6",
                entry_bytes: 3,
                header_unknown: None,
                entries: vec![7, 8, 9],
            },
            color_config: WaveformColorConfig {
                unknown: 0,
                data: [1, 2, 3],
            },
        };
        let bytes = analysis
            .to_file()
            .expect("build 2EX")
            .to_bytes()
            .expect("serialize 2EX");
        let parsed = AnlzFile::parse(&bytes).expect("parse 2EX");
        let rebuilt = ThreeBandAnalysis::parse(&parsed)
            .expect("decode 2EX")
            .to_file()
            .expect("rebuild 2EX")
            .to_bytes()
            .expect("serialize rebuilt 2EX");
        assert_eq!(rebuilt, bytes);
    }
}
