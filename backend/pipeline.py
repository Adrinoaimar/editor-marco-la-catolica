from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Callable

import cv2
import numpy as np
import torch


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = PROJECT_ROOT.parent / "scripts"
SAM_DIR = PROJECT_ROOT.parent / "tools" / "sam-hq"
if str(SAM_DIR) not in sys.path:
    sys.path.insert(0, str(SAM_DIR))
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

PIPELINE_IMPORT_ERROR: Exception | None = None
try:
    from edit_hqsam_batch import (  # noqa: E402
        apply_exclusions,
        apply_inclusions,
        compose,
        keep_prompted_components,
        predict_mask,
    )
    from segment_anything import SamPredictor, sam_model_registry  # noqa: E402
except Exception as exc:  # Dependencias pesadas: el endpoint health sigue disponible.
    PIPELINE_IMPORT_ERROR = exc


DEFAULT_GRADE: dict[str, Any] = {
    "blue": 0.985,
    "green": 1.0,
    "red": 1.015,
    "exposure": 1.015,
    "black": -0.008,
    "gamma": 0.98,
    "contrast": 1.045,
    "saturation": 1.025,
    "clahe": 1.2,
    "subject_exposure": 1.02,
    "subject_beta": 0,
    "subject_detail_sigma": 1.05,
    "subject_sharpen": 0.06,
    "blur_sigma": 2.8,
    "edge_feather": 1.2,
    "inpaint_dilate": 7,
    "inpaint_radius": 2.0,
    "background_saturation": 0.96,
    "background_exposure": 1.0,
}

Progress = Callable[[str, dict[str, Any]], None]


class PipelineError(RuntimeError):
    """Error seguro para mostrar al cliente sin revelar rutas del servidor."""


def _safe_stem(name: str) -> str:
    stem = Path(name).stem
    stem = re.sub(r"[^\w\- áéíóúÁÉÍÓÚñÑ]", "", stem, flags=re.UNICODE).strip()
    return re.sub(r"\s+", "-", stem)[:80] or "foto"


def _decode_image(path: Path) -> np.ndarray:
    suffix = path.suffix.lower()
    if suffix not in {".heic", ".heif"}:
        image = cv2.imread(str(path), cv2.IMREAD_COLOR)
        if image is not None:
            return image
    try:
        from pillow_heif import register_heif_opener  # type: ignore
        from PIL import Image, ImageOps  # type: ignore

        register_heif_opener()
        with Image.open(path) as source:
            rgb = ImageOps.exif_transpose(source).convert("RGB")
            return cv2.cvtColor(np.asarray(rgb), cv2.COLOR_RGB2BGR)
    except ImportError as exc:
        raise PipelineError(
            "El servidor necesita pillow-heif para convertir fotos HEIC. "
            "Instala las dependencias de backend y vuelve a intentarlo."
        ) from exc
    except Exception as exc:
        raise PipelineError("No se pudo decodificar la imagen HEIC.") from exc
    raise PipelineError("No se pudo leer la imagen.")


def _point_list(value: Any, width: int, height: int) -> list[list[float]]:
    if not isinstance(value, list):
        return []
    points: list[list[float]] = []
    for point in value[:64]:
        if not isinstance(point, (list, tuple)) or len(point) != 2:
            continue
        try:
            x = min(max(float(point[0]), 0.0), float(width - 1))
            y = min(max(float(point[1]), 0.0), float(height - 1))
        except (TypeError, ValueError):
            continue
        points.append([x, y])
    return points


def _default_segment(image: np.ndarray, annotation: dict[str, Any] | None) -> dict[str, Any]:
    height, width = image.shape[:2]
    data = annotation if isinstance(annotation, dict) else {}
    default_box = [round(width * 0.08), round(height * 0.03), round(width * 0.92), round(height * 0.98)]
    box = data.get("box", default_box)
    if not isinstance(box, list) or len(box) != 4:
        box = default_box
    x1, y1, x2, y2 = [float(value) for value in box]
    x1, x2 = sorted((min(max(x1, 0), width - 1), min(max(x2, 1), width)))
    y1, y2 = sorted((min(max(y1, 0), height - 1), min(max(y2, 1), height)))
    center_x = float(data.get("center_x", (x1 + x2) / 2))
    positives = _point_list(data.get("positive"), width, height)
    negatives = _point_list(data.get("negative"), width, height)
    if not positives:
        positives = [
            [center_x, y1 + (y2 - y1) * 0.12],
            [center_x, y1 + (y2 - y1) * 0.35],
            [center_x, y1 + (y2 - y1) * 0.58],
            [center_x, y1 + (y2 - y1) * 0.82],
            [x1 + (x2 - x1) * 0.28, y1 + (y2 - y1) * 0.52],
            [x1 + (x2 - x1) * 0.72, y1 + (y2 - y1) * 0.52],
        ]
    if not negatives:
        negatives = [
            [max(0, x1 - width * 0.03), y1],
            [min(width - 1, x2 + width * 0.03), y1],
            [max(0, x1 - width * 0.03), y2],
            [min(width - 1, x2 + width * 0.03), y2],
        ]
    segment = {"box": [x1, y1, x2, y2], "center_x": center_x, "positive": positives, "negative": negatives}
    for key in ("add_segments", "subtract_segments", "inclusions", "exclusions"):
        if isinstance(data.get(key), list):
            segment[key] = data[key][:32]
    return segment


def _crop_resize(image: np.ndarray, target_size: tuple[int, int], focus_x: float, focus_y: float | None = None) -> np.ndarray:
    target_w, target_h = target_size
    height, width = image.shape[:2]
    target_ratio = target_w / target_h
    source_ratio = width / height
    if source_ratio > target_ratio:
        crop_h = height
        crop_w = max(1, min(width, round(height * target_ratio)))
    else:
        crop_w = width
        crop_h = max(1, min(height, round(width / target_ratio)))
    center_x = min(max(float(focus_x), 0), width - 1)
    center_y = min(max(float(focus_y if focus_y is not None else height / 2), 0), height - 1)
    left = int(round(center_x - crop_w / 2))
    top = int(round(center_y - crop_h / 2))
    left = min(max(left, 0), width - crop_w)
    top = min(max(top, 0), height - crop_h)
    crop = image[top : top + crop_h, left : left + crop_w]
    return cv2.resize(crop, (target_w, target_h), interpolation=cv2.INTER_LANCZOS4)


def _write_jpg(path: Path, image: np.ndarray, quality: int = 96) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not cv2.imwrite(str(path), image, [cv2.IMWRITE_JPEG_QUALITY, quality]):
        raise PipelineError("No se pudo guardar una imagen procesada.")


def _institutional_frame(image: np.ndarray) -> np.ndarray:
    """Conserva el marco de la interfaz en las salidas profesionales."""
    result = image.copy()
    height, width = result.shape[:2]
    gradient = np.zeros_like(result, dtype=np.float32)
    start = int(height * 0.56)
    for y in range(start, height):
        progress = (y - start) / max(1, height - start)
        alpha = 0.58 * progress if progress < 0.52 else 0.58 + (0.98 - 0.58) * ((progress - 0.52) / 0.48)
        gradient[y, :, :] = max(0.0, min(alpha, 0.98))
    alpha_map = gradient[..., :1]
    dark = np.array([4, 17, 43], dtype=np.float32)
    result = np.clip(result.astype(np.float32) * (1.0 - alpha_map) + dark * alpha_map, 0, 255).astype(np.uint8)

    logo_path = PROJECT_ROOT / "logo.png"
    logo = cv2.imread(str(logo_path), cv2.IMREAD_UNCHANGED)
    if logo is not None:
        if logo.ndim == 3 and logo.shape[2] >= 3:
            bgr = logo[:, :, :3]
            brightness = bgr.mean(axis=2)
            saturation = bgr.max(axis=2) - bgr.min(axis=2)
            alpha = np.where((brightness > 242) & (saturation < 22), 0, 255).astype(np.uint8)
            ys, xs = np.where(alpha > 10)
            if len(xs):
                crop = bgr[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]
                crop_alpha = alpha[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]
                logo_h = max(80, round(height * 0.14))
                logo_w = max(60, round(logo_h * crop.shape[1] / crop.shape[0]))
                resized = cv2.resize(crop, (logo_w, logo_h), interpolation=cv2.INTER_AREA)
                resized_alpha = cv2.resize(crop_alpha, (logo_w, logo_h), interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0
                left = max(0, round(width * 0.12))
                top = max(0, height - logo_h - round(height * 0.035))
                right = min(width, left + logo_w)
                visible_w = right - left
                if visible_w > 0:
                    base = result[top : top + logo_h, left:right].astype(np.float32)
                    a = resized_alpha[:, :visible_w, None]
                    result[top : top + logo_h, left:right] = np.clip(resized[:, :visible_w].astype(np.float32) * a + base * (1 - a), 0, 255).astype(np.uint8)

    font_scale = max(0.65, width / 1850)
    line1 = "CENTRO DE CAPACITACIÓN PROFESIONAL"
    line2 = "LA CATÓLICA"
    def centered_text(text: str, scale: float, thickness: int, y: int) -> None:
        (text_w, text_h), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, scale, thickness)
        x = max(0, (width - text_w) // 2)
        cv2.putText(result, text, (x, y), cv2.FONT_HERSHEY_SIMPLEX, scale, (248, 248, 248), thickness, cv2.LINE_AA)
    centered_text(line1, 0.74 * font_scale, 2, height - round(height * 0.115))
    centered_text(line2, 1.35 * font_scale, 4, height - round(height * 0.045))
    return result


class HQSamPipeline:
    def __init__(self, checkpoint: Path | None = None, config: Path | None = None) -> None:
        if PIPELINE_IMPORT_ERROR is not None:
            raise PipelineError(
                "Faltan dependencias del worker HQ-SAM. Instala backend/requirements.txt "
                "y timm antes de iniciar el procesamiento profesional."
            ) from PIPELINE_IMPORT_ERROR
        self.checkpoint = checkpoint or Path(
            os.environ.get(
                "SAM_HQ_CHECKPOINT",
                str(PROJECT_ROOT.parent / "tools" / "sam-hq" / "pretrained_checkpoint" / "sam_hq_vit_tiny.pth"),
            )
        )
        self.config_path = config or Path(
            os.environ.get("SAM_HQ_CONFIG", str(SCRIPTS_DIR / "hqsam_prompts.json"))
        )
        if not self.checkpoint.exists():
            raise PipelineError("El modelo HQ-SAM no está instalado en el servidor.")
        try:
            self.model = sam_model_registry["vit_tiny"](checkpoint=str(self.checkpoint))
            self.model.to(device=os.environ.get("SAM_HQ_DEVICE", "cpu")).eval()
            self.predictor = SamPredictor(self.model)
        except Exception as exc:
            raise PipelineError("No se pudo cargar el modelo HQ-SAM.") from exc
        self.reference_config: dict[str, Any] = {}
        try:
            self.reference_config = json.loads(self.config_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            self.reference_config = {}

    def process_file(
        self,
        source: Path,
        output_root: Path,
        annotation: dict[str, Any] | None = None,
        progress: Progress | None = None,
    ) -> dict[str, Any]:
        image = _decode_image(source)
        height, width = image.shape[:2]
        if progress:
            progress("segmenting", {"width": width, "height": height})
        segment = _default_segment(image, annotation)
        self.predictor.set_image(cv2.cvtColor(image, cv2.COLOR_BGR2RGB))
        mask, score, positives, negatives = predict_mask(self.predictor, segment)
        keep_points = positives.copy()
        for extra in segment.get("add_segments", []):
            addition, _, extra_positive, _ = predict_mask(self.predictor, extra)
            addition = keep_prompted_components(addition, extra_positive)
            mask = cv2.bitwise_or(mask, addition)
            keep_points = np.vstack((keep_points, extra_positive))
        for extra in segment.get("subtract_segments", []):
            subtraction, _, extra_positive, _ = predict_mask(self.predictor, extra)
            subtraction = keep_prompted_components(subtraction, extra_positive)
            mask[subtraction > 127] = 0
        apply_exclusions(mask, segment.get("exclusions", []))
        mask = keep_prompted_components(mask, keep_points)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
        apply_inclusions(mask, segment.get("inclusions", []))

        grade = {**DEFAULT_GRADE, **self.reference_config.get("grade", {})}
        if isinstance(annotation, dict) and isinstance(annotation.get("grade"), dict):
            grade.update(annotation["grade"])
        if progress:
            progress("composing", {})
        focus_x = float(segment.get("center_x", (segment["box"][0] + segment["box"][2]) / 2))
        focus_y = float(annotation.get("focus_y", height / 2)) if isinstance(annotation, dict) else height / 2
        result = compose(image, mask, grade, (int(focus_x), int(focus_y)))
        horizontal = _institutional_frame(_crop_resize(result, (1920, 1080), focus_x, focus_y))
        vertical = _institutional_frame(_crop_resize(result, (1080, 1350), focus_x, focus_y))

        stem = _safe_stem(source.name)
        output_dir = output_root / "outputs" / stem
        control_dir = output_root / "_control" / stem
        horizontal_path = output_dir / f"{stem}_horizontal.jpg"
        vertical_path = output_dir / f"{stem}_vertical_4x5.jpg"
        mask_path = control_dir / f"{stem}_mask.png"
        overlay_path = control_dir / f"{stem}_overlay.jpg"
        _write_jpg(horizontal_path, horizontal)
        _write_jpg(vertical_path, vertical)
        mask_path.parent.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(mask_path), mask)
        overlay = image.copy()
        overlay[mask > 127] = (0, 255, 0)
        overlay = cv2.addWeighted(image, 0.72, overlay, 0.28, 0)
        _write_jpg(overlay_path, overlay, 92)

        coverage = float((mask > 127).mean())
        positive_hits = int(sum(mask[int(y), int(x)] > 127 for x, y in positives))
        negative_hits = int(sum(mask[int(y), int(x)] > 127 for x, y in negatives))
        needs_review = score < 0.78 or coverage < 0.03 or coverage > 0.9 or negative_hits > 0
        reason = []
        if score < 0.78:
            reason.append("confianza_baja")
        if coverage < 0.03 or coverage > 0.9:
            reason.append("cobertura_atipica")
        if negative_hits > 0:
            reason.append("puntos_negativos_incluidos")
        if progress:
            progress("qa", {"score": score, "coverage": coverage, "needs_review": needs_review})
        return {
            "source": source.name,
            "score": round(float(score), 6),
            "coverage": round(coverage, 6),
            "positive_hits": f"{positive_hits}/{len(positives)}",
            "negative_hits": f"{negative_hits}/{len(negatives)}",
            "status": "needs_review" if needs_review else "done",
            "needs_review": needs_review,
            "reason": reason,
            "horizontal": f"outputs/{stem}/{horizontal_path.name}",
            "vertical": f"outputs/{stem}/{vertical_path.name}",
            "mask": f"_control/{stem}/{mask_path.name}",
            "overlay": f"_control/{stem}/{overlay_path.name}",
        }
