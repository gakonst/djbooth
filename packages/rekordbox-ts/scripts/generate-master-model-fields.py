#!/usr/bin/env python3
"""Generate TypeScript master.db column augmentations from the pinned Python models."""

from __future__ import annotations

import ast
import sys
from pathlib import Path


TYPE_MAP = {
    "Any": "unknown",
    "bytes": "Buffer",
    "datetime": "Date",
    "float": "number",
    "int": "number",
    "str": "string",
}

EXISTING_FIELDS = {
    "DjmdAlbum": {"ID", "Name"},
    "DjmdArtist": {"ID", "Name"},
    "DjmdContent": {
        "ID", "Title", "FolderPath", "FileNameL", "ArtistID", "AlbumID", "GenreID",
        "AnalysisDataPath",
    },
    "DjmdGenre": {"ID", "Name"},
    "DjmdKey": {"ID", "ScaleName"},
    "DjmdLabel": {"ID", "Name"},
    "DjmdPlaylist": {"ID", "Seq", "Name", "Attribute", "ParentID", "SmartList"},
    "DjmdSongMyTag": {"MyTagID"},
    "DjmdSongPlaylist": {"ID", "PlaylistID", "ContentID", "TrackNo"},
}


def mapped_type(annotation: ast.expr) -> str | None:
    if not isinstance(annotation, ast.Subscript):
        return None
    if not isinstance(annotation.value, ast.Name) or annotation.value.id != "Mapped":
        return None
    value = annotation.slice
    if isinstance(value, ast.Name):
        return TYPE_MAP.get(value.id, "unknown")
    return "unknown"


def generate(source: Path) -> str:
    tree = ast.parse(source.read_text())
    field_map: dict[str, list[tuple[str, str]]] = {}
    for node in tree.body:
        if not isinstance(node, ast.ClassDef):
            continue
        fields: list[tuple[str, str]] = []
        for item in node.body:
            if isinstance(item, ast.AnnAssign) and isinstance(item.target, ast.Name):
                value_type = mapped_type(item.annotation)
                if value_type is not None:
                    fields.append((item.target.id, f"{value_type} | null"))
        field_map[node.name] = fields

    models: list[tuple[str, list[tuple[str, str]]]] = []
    for node in tree.body:
        if not isinstance(node, ast.ClassDef):
            continue
        if not any(
            isinstance(item, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == "__tablename__" for target in item.targets)
            for item in node.body
        ):
            continue
        fields = []
        for base in node.bases:
            if isinstance(base, ast.Name):
                fields.extend(field_map.get(base.id, []))
        fields.extend(field_map.get(node.name, []))
        fields = list(dict(fields).items())
        fields = [
            field
            for field in fields
            if field[0] not in EXISTING_FIELDS.get(node.name, set())
        ]
        if fields:
            models.append((node.name, fields))

    lines = [
        "/** Generated from pyrekordbox masterdb/models.py at the pinned source revision. */",
        'import "./models.js";',
        "",
        'declare module "./models.js" {',
    ]
    for name, fields in models:
        lines.append(f"  interface {name} {{")
        for field, value_type in fields:
            lines.append(f"    {field}: {value_type};")
        lines.append("  }")
    lines.extend(["}", "", "export {};", ""])
    return "\n".join(lines)


def find_default_source(root: Path) -> Path:
    relative = Path("dylanljones/pyrekordbox/pyrekordbox/masterdb/models.py")
    for ancestor in root.parents:
        candidate = ancestor / relative
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(
        "Could not find dylanljones/pyrekordbox. Pass the path to pyrekordbox/masterdb/models.py "
        "as the first argument."
    )


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    source = (
        Path(sys.argv[1])
        if len(sys.argv) > 1
        else find_default_source(root)
    )
    output = root / "src/masterdb/model-fields.ts"
    output.write_text(generate(source))


if __name__ == "__main__":
    main()
