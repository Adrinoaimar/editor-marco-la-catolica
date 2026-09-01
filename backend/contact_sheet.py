from __future__ import annotations

from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageOps


def _build(paths: list[Path], output: Path, cell_size: tuple[int, int]) -> None:
    if not paths:
        return
    cell_w, cell_h = cell_size
    label_h = 28
    columns = min(3, len(paths))
    rows = (len(paths) + columns - 1) // columns
    sheet = Image.new("RGB", (columns * cell_w, rows * (cell_h + label_h)), "#18283b")
    draw = ImageDraw.Draw(sheet)
    for index, path in enumerate(paths):
        try:
            image = Image.open(path).convert("RGB")
        except (OSError, ValueError):
            continue
        thumb = ImageOps.contain(image, cell_size, Image.Resampling.LANCZOS)
        x = (index % columns) * cell_w + (cell_w - thumb.width) // 2
        y = (index // columns) * (cell_h + label_h)
        sheet.paste(thumb, (x, y))
        draw.text(((index % columns) * cell_w + 7, y + cell_h + 7), path.parent.name[:28], fill="white")
    output.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output, quality=92)


def build_contact_sheets(root: Path, report: list[dict[str, Any]]) -> None:
    control = root / "_control"
    horizontals = [root / item["horizontal"] for item in report if item.get("horizontal")]
    verticals = [root / item["vertical"] for item in report if item.get("vertical")]
    masks = [root / item["overlay"] for item in report if item.get("overlay")]
    _build(horizontals, control / "contacto_horizontales.jpg", (420, 236))
    _build(verticals, control / "contacto_verticales_4x5.jpg", (280, 350))
    _build(masks, control / "contacto_mascaras.jpg", (420, 236))

