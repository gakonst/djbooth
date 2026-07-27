use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::anlz::{AnlzFile, AnlzTag};

const OUTPUT_NAMES: [&str; 3] = ["ANLZ0000.DAT", "ANLZ0000.EXT", "ANLZ0000.2EX"];

/// First byte at which two files differ.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FirstDifference {
    pub offset: usize,
    pub reference: Option<u8>,
    pub candidate: Option<u8>,
}

/// Structural and byte comparison for one same-position tag.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagDifferential {
    pub index: usize,
    pub reference_kind: Option<String>,
    pub candidate_kind: Option<String>,
    pub reference_len: Option<usize>,
    pub candidate_len: Option<usize>,
    pub reference_sha256: Option<String>,
    pub candidate_sha256: Option<String>,
    pub exact: bool,
    pub first_difference: Option<FirstDifference>,
}

/// Byte and tag differential for one DAT, EXT, or 2EX file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDifferential {
    pub name: String,
    pub reference_path: PathBuf,
    pub candidate_path: PathBuf,
    pub reference_len: usize,
    pub candidate_len: usize,
    pub reference_sha256: String,
    pub candidate_sha256: String,
    pub exact: bool,
    pub first_difference: Option<FirstDifference>,
    pub tags: Vec<TagDifferential>,
}

/// Complete three-file analyzer differential.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DifferentialReport {
    pub reference_directory: PathBuf,
    pub candidate_directory: PathBuf,
    pub exact: bool,
    pub files: Vec<FileDifferential>,
}

/// Compare DAT, EXT, and 2EX outputs byte-for-byte and section-by-section.
pub fn compare_output_directories(
    reference_directory: &Path,
    candidate_directory: &Path,
) -> Result<DifferentialReport> {
    let mut files = Vec::with_capacity(OUTPUT_NAMES.len());
    for name in OUTPUT_NAMES {
        let reference_path = reference_directory.join(name);
        let candidate_path = candidate_directory.join(name);
        files.push(compare_file(name, &reference_path, &candidate_path)?);
    }
    Ok(DifferentialReport {
        reference_directory: reference_directory.to_path_buf(),
        candidate_directory: candidate_directory.to_path_buf(),
        exact: files.iter().all(|file| file.exact),
        files,
    })
}

fn compare_file(
    name: &str,
    reference_path: &Path,
    candidate_path: &Path,
) -> Result<FileDifferential> {
    let reference = std::fs::read(reference_path)
        .with_context(|| format!("failed to read reference {}", reference_path.display()))?;
    let candidate = std::fs::read(candidate_path)
        .with_context(|| format!("failed to read candidate {}", candidate_path.display()))?;
    let reference_file = AnlzFile::parse(&reference)
        .with_context(|| format!("invalid reference {}", reference_path.display()))?;
    let candidate_file = AnlzFile::parse(&candidate)
        .with_context(|| format!("invalid candidate {}", candidate_path.display()))?;
    let tag_count = reference_file.tags().len().max(candidate_file.tags().len());
    let tags = (0..tag_count)
        .map(|index| {
            compare_tag(
                index,
                reference_file.tags().get(index),
                candidate_file.tags().get(index),
            )
        })
        .collect();
    Ok(FileDifferential {
        name: name.to_string(),
        reference_path: reference_path.to_path_buf(),
        candidate_path: candidate_path.to_path_buf(),
        reference_len: reference.len(),
        candidate_len: candidate.len(),
        reference_sha256: sha256(&reference),
        candidate_sha256: sha256(&candidate),
        exact: reference == candidate,
        first_difference: first_difference(&reference, &candidate),
        tags,
    })
}

fn compare_tag(
    index: usize,
    reference: Option<&AnlzTag>,
    candidate: Option<&AnlzTag>,
) -> TagDifferential {
    let reference_raw = reference.map(AnlzTag::raw);
    let candidate_raw = candidate.map(AnlzTag::raw);
    TagDifferential {
        index,
        reference_kind: reference.map(AnlzTag::kind_text),
        candidate_kind: candidate.map(AnlzTag::kind_text),
        reference_len: reference_raw.map(<[u8]>::len),
        candidate_len: candidate_raw.map(<[u8]>::len),
        reference_sha256: reference_raw.map(sha256),
        candidate_sha256: candidate_raw.map(sha256),
        exact: reference_raw == candidate_raw,
        first_difference: match (reference_raw, candidate_raw) {
            (Some(reference), Some(candidate)) => first_difference(reference, candidate),
            _ => None,
        },
    }
}

fn first_difference(reference: &[u8], candidate: &[u8]) -> Option<FirstDifference> {
    let shared_len = reference.len().min(candidate.len());
    let offset = (0..shared_len)
        .find(|index| reference[*index] != candidate[*index])
        .or_else(|| (reference.len() != candidate.len()).then_some(shared_len))?;
    Some(FirstDifference {
        offset,
        reference: reference.get(offset).copied(),
        candidate: candidate.get(offset).copied(),
    })
}

fn sha256(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;
    use crate::anlz::{AnlzFile, build_empty_cue_tag};

    fn fixture() -> Vec<u8> {
        AnlzFile::from_tags(vec![
            build_empty_cue_tag(1).expect("cue"),
            build_empty_cue_tag(0).expect("cue"),
        ])
        .expect("file")
        .to_bytes()
        .expect("bytes")
    }

    #[test]
    fn reports_exact_outputs_and_one_changed_payload_byte() {
        let reference = tempdir().expect("reference");
        let candidate = tempdir().expect("candidate");
        for name in OUTPUT_NAMES {
            fs::write(reference.path().join(name), fixture()).expect("reference fixture");
            fs::write(candidate.path().join(name), fixture()).expect("candidate fixture");
        }
        let exact =
            compare_output_directories(reference.path(), candidate.path()).expect("exact diff");
        assert!(exact.exact);

        let path = candidate.path().join("ANLZ0000.EXT");
        let mut changed = fs::read(&path).expect("read candidate");
        let last = changed.len() - 1;
        changed[last] ^= 1;
        fs::write(&path, changed).expect("write candidate");
        let report =
            compare_output_directories(reference.path(), candidate.path()).expect("changed diff");
        assert!(!report.exact);
        let ext = &report.files[1];
        assert_eq!(
            ext.first_difference,
            Some(FirstDifference {
                offset: fixture().len() - 1,
                reference: Some(0xff),
                candidate: Some(0xfe),
            })
        );
        assert!(!ext.tags[1].exact);
    }
}
