use std::io::BufRead;
use std::path::Path;

use anyhow::{Context, Result, bail};
use serde::Serialize;
use serde::de::DeserializeOwned;

pub fn render_document<T: Serialize>(frontmatter: &T, body: &str) -> Result<String> {
    let yaml = serde_yaml::to_string(frontmatter).context("failed to encode frontmatter")?;
    Ok(format!("---\n{yaml}---\n\n{body}"))
}

pub fn parse_document<T: DeserializeOwned>(content: &str) -> Result<(T, String)> {
    let mut lines = content.lines();
    if lines.next() != Some("---") {
        bail!("expected markdown frontmatter starting with '---'");
    }

    let mut yaml = Vec::new();
    let mut body_lines = Vec::new();
    let mut in_frontmatter = true;

    for line in lines {
        if in_frontmatter && line == "---" {
            in_frontmatter = false;
            continue;
        }

        if in_frontmatter {
            yaml.push(line);
        } else {
            body_lines.push(line);
        }
    }

    if in_frontmatter {
        bail!("frontmatter was not terminated");
    }

    let frontmatter = serde_yaml::from_str::<T>(&yaml.join("\n"))
        .context("failed to decode markdown frontmatter")?;
    Ok((frontmatter, body_lines.join("\n").trim().to_string()))
}

pub fn read_frontmatter<T: DeserializeOwned>(path: &Path) -> Result<T> {
    let file = std::fs::File::open(path)
        .with_context(|| format!("failed to read '{}'", path.display()))?;
    let mut lines = std::io::BufReader::new(file).lines();
    if lines.next().transpose()? != Some("---".to_string()) {
        bail!("expected markdown frontmatter starting with '---'");
    }

    let mut yaml = Vec::new();
    for line in lines {
        let line = line?;
        if line == "---" {
            return serde_yaml::from_str::<T>(&yaml.join("\n"))
                .context("failed to decode markdown frontmatter");
        }
        yaml.push(line);
    }

    bail!("frontmatter was not terminated")
}
