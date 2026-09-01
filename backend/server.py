from __future__ import annotations

import cgi
import io
import json
import mimetypes
import os
import queue
import re
import threading
import time
import uuid
import zipfile
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from .pipeline import HQSamPipeline, PIPELINE_IMPORT_ERROR, PipelineError
from .contact_sheet import build_contact_sheets


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DATA_ROOT = Path(os.environ.get("PHOTO_EDITOR_DATA", str(PROJECT_ROOT / "data"))).resolve()
JOBS_ROOT = (DATA_ROOT / "jobs").resolve()
JOBS_ROOT.mkdir(parents=True, exist_ok=True)
MAX_FILES = int(os.environ.get("PHOTO_EDITOR_MAX_FILES", "20"))
MAX_FILE_BYTES = int(os.environ.get("PHOTO_EDITOR_MAX_FILE_MB", "50")) * 1024 * 1024
MAX_BATCH_BYTES = int(os.environ.get("PHOTO_EDITOR_MAX_BATCH_MB", "500")) * 1024 * 1024
ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"}
ALLOWED_ORIGIN = os.environ.get("PHOTO_EDITOR_ORIGIN", "*")

JOBS: dict[str, dict[str, Any]] = {}
JOBS_LOCK = threading.RLock()
JOB_QUEUE: queue.Queue[str] = queue.Queue(maxsize=int(os.environ.get("PHOTO_EDITOR_QUEUE", "8")))
PIPELINE: HQSamPipeline | None = None
PIPELINE_LOCK = threading.Lock()


def _safe_name(name: str, fallback: str = "foto") -> str:
    clean = Path(name).name
    clean = re.sub(r"[^\w.\- áéíóúÁÉÍÓÚñÑ]", "", clean, flags=re.UNICODE).strip()
    if not clean or clean in {".", ".."}:
        clean = fallback
    return clean[:140]


def _job_dir(job_id: str) -> Path:
    return (JOBS_ROOT / job_id).resolve()


def _jsonable_job(job: dict[str, Any]) -> dict[str, Any]:
    with JOBS_LOCK:
        result = {
            "id": job["id"],
            "status": job["status"],
            "created_at": job["created_at"],
            "updated_at": job["updated_at"],
            "progress": job["progress"],
            "items": [],
            "download": f"/api/jobs/{job['id']}/download" if job["status"] == "done" else None,
            "control": [],
            "error": job.get("error"),
        }
        if job["status"] == "done":
            for name in ("reporte.json", "_control/reporte.json", "_control/contacto_horizontales.jpg", "_control/contacto_verticales_4x5.jpg", "_control/contacto_mascaras.jpg"):
                if (_job_dir(job["id"]) / name).is_file():
                    result["control"].append({"type": Path(name).stem, "url": f"/api/jobs/{job['id']}/files/{name}"})
        for item in job["items"]:
            current = dict(item)
            current.pop("source_path", None)
            current["outputs"] = []
            for key in ("horizontal", "vertical", "mask", "overlay"):
                if current.get(key):
                    current["outputs"].append({
                        "type": key,
                        "url": f"/api/jobs/{job['id']}/files/{current[key]}",
                    })
            result["items"].append(current)
        return result


def _update(job_id: str, **changes: Any) -> None:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            return
        job.update(changes)
        job["updated_at"] = time.time()


def _get_pipeline() -> HQSamPipeline:
    global PIPELINE
    with PIPELINE_LOCK:
        if PIPELINE is None:
            PIPELINE = HQSamPipeline()
        return PIPELINE


def _annotation_map(raw: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(raw, list):
        return {}
    result: dict[str, dict[str, Any]] = {}
    for item in raw[:MAX_FILES]:
        if not isinstance(item, dict) or not isinstance(item.get("fileName"), str):
            continue
        result[_safe_name(item["fileName"]).lower()] = item
    return result


def _run_job(job_id: str) -> None:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
    if not job:
        return
    output_root = _job_dir(job_id)
    try:
        pipeline = _get_pipeline()
        _update(job_id, status="processing", progress={"completed": 0, "total": len(job["items"]), "stage": "starting"})
        annotations = _annotation_map(job.get("annotations"))
        report: list[dict[str, Any]] = []
        for index, item in enumerate(job["items"]):
            with JOBS_LOCK:
                if job.get("cancelled"):
                    _update(job_id, status="cancelled", progress={"completed": index, "total": len(job["items"]), "stage": "cancelled"})
                    return
                item["status"] = "processing"
            annotation = annotations.get(item["name"].lower(), {})

            def progress(stage: str, details: dict[str, Any]) -> None:
                _update(job_id, progress={"completed": index, "total": len(job["items"]), "current": item["name"], "stage": stage, **details})

            try:
                result = pipeline.process_file(Path(item["source_path"]), output_root, annotation, progress)
                item.update(result)
                item["status"] = result["status"]
                report.append(result)
            except PipelineError as exc:
                item["status"] = "error"
                item["error"] = str(exc)
                report.append({"source": item["name"], "status": "error", "error": str(exc)})
            except Exception:
                item["status"] = "error"
                item["error"] = "No se pudo procesar esta imagen."
                report.append({"source": item["name"], "status": "error", "error": item["error"]})
            _update(job_id, progress={"completed": index + 1, "total": len(job["items"]), "current": item["name"], "stage": "done"})
        report_json = json.dumps(report, ensure_ascii=False, indent=2)
        (output_root / "reporte.json").write_text(report_json, encoding="utf-8")
        (output_root / "_control" / "reporte.json").write_text(report_json, encoding="utf-8")
        build_contact_sheets(output_root, report)
        failed = any(item.get("status") == "error" for item in job["items"])
        _update(job_id, status="error" if failed and not report else "done", progress={"completed": len(job["items"]), "total": len(job["items"]), "stage": "done"})
    except PipelineError as exc:
        _update(job_id, status="error", error=str(exc), progress={"completed": 0, "total": len(job["items"]), "stage": "error"})
    except Exception:
        _update(job_id, status="error", error="El servicio de procesamiento no pudo completar el lote.", progress={"completed": 0, "total": len(job["items"]), "stage": "error"})


def _worker_loop() -> None:
    while True:
        job_id = JOB_QUEUE.get()
        try:
            _run_job(job_id)
        finally:
            JOB_QUEUE.task_done()


threading.Thread(target=_worker_loop, name="photo-editor-worker", daemon=True).start()


def _enqueue_server_paths(paths: list[Path]) -> str | None:
    """Crea un lote desde una carpeta administrada en el servidor."""
    valid_paths = [path for path in paths if path.is_file() and path.suffix.lower() in ALLOWED_EXTENSIONS]
    if not valid_paths or len(valid_paths) > MAX_FILES:
        return None
    job_id = uuid.uuid4().hex
    root = _job_dir(job_id)
    originals = root / "originals"
    originals.mkdir(parents=True, exist_ok=False)
    items: list[dict[str, Any]] = []
    for index, source in enumerate(valid_paths):
        name = _safe_name(source.name, f"foto-{index + 1}{source.suffix.lower()}")
        target = originals / name
        target.write_bytes(source.read_bytes())
        if target.stat().st_size > MAX_FILE_BYTES:
            target.unlink(missing_ok=True)
            continue
        items.append({"id": uuid.uuid4().hex[:12], "name": name, "source_path": str(target), "status": "queued"})
    if not items:
        return None
    now = time.time()
    job = {"id": job_id, "status": "queued", "created_at": now, "updated_at": now, "progress": {"completed": 0, "total": len(items), "stage": "queued"}, "items": items, "annotations": [], "cancelled": False}
    with JOBS_LOCK:
        JOBS[job_id] = job
    try:
        JOB_QUEUE.put_nowait(job_id)
    except queue.Full:
        _update(job_id, status="error", error="La cola está llena; intenta de nuevo más tarde.")
    return job_id


def _watch_loop() -> None:
    watch_value = os.environ.get("PHOTO_EDITOR_WATCH_DIR", "").strip()
    if not watch_value:
        return
    watch_dir = Path(watch_value).expanduser().resolve()
    if not watch_dir.is_dir():
        print("PHOTO_EDITOR_WATCH_DIR no existe; carpeta vigilada desactivada.")
        return
    interval = max(10, int(os.environ.get("PHOTO_EDITOR_WATCH_INTERVAL_SEC", "60")))
    seen: set[str] = set()
    while True:
        try:
            candidates = sorted(path for path in watch_dir.iterdir() if path.is_file() and path.suffix.lower() in ALLOWED_EXTENSIONS)
            fresh = [path for path in candidates if str(path) not in seen]
            if fresh:
                batch = fresh[:MAX_FILES]
                if _enqueue_server_paths(batch):
                    seen.update(str(path) for path in batch)
            time.sleep(interval)
        except Exception:
            time.sleep(interval)


if os.environ.get("PHOTO_EDITOR_WATCH_DIR"):
    threading.Thread(target=_watch_loop, name="photo-editor-watcher", daemon=True).start()


class Handler(BaseHTTPRequestHandler):
    server_version = "LaCatolicaPhotoEditor/1.0"

    def log_message(self, format: str, *args: Any) -> None:
        if os.environ.get("PHOTO_EDITOR_ACCESS_LOG", "0") == "1":
            super().log_message(format, *args)

    def _headers(self, content_type: str, length: int | None = None) -> None:
        self.send_header("Content-Type", content_type)
        self.send_header("Access-Control-Allow-Origin", ALLOWED_ORIGIN)
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store")
        if length is not None:
            self.send_header("Content-Length", str(length))

    def _send_json(self, status: int, payload: Any) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._headers("application/json; charset=utf-8", len(data))
        self.end_headers()
        self.wfile.write(data)

    def _not_found(self) -> None:
        self._send_json(HTTPStatus.NOT_FOUND, {"error": "Recurso no encontrado."})

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self._headers("text/plain", 0)
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        parts = [unquote(part) for part in parsed.path.split("/") if part]
        if parts == ["api", "health"]:
            checkpoint = os.environ.get("SAM_HQ_CHECKPOINT") or str(PROJECT_ROOT.parent / "tools" / "sam-hq" / "pretrained_checkpoint" / "sam_hq_vit_tiny.pth")
            self._send_json(HTTPStatus.OK, {"ok": True, "queue": JOB_QUEUE.qsize(), "model_available": Path(checkpoint).exists() and PIPELINE_IMPORT_ERROR is None})
            return
        if len(parts) >= 3 and parts[:2] == ["api", "jobs"]:
            job_id = parts[2]
            with JOBS_LOCK:
                job = JOBS.get(job_id)
            if not job:
                self._not_found()
                return
            if len(parts) == 3:
                self._send_json(HTTPStatus.OK, _jsonable_job(job))
                return
            if parts[3] == "download":
                self._send_zip(job)
                return
            if parts[3] == "files" and len(parts) >= 5:
                relative = Path(*parts[4:])
                root = _job_dir(job_id).resolve()
                target = (root / relative).resolve()
                if root not in target.parents or not target.is_file():
                    self._not_found()
                    return
                self._send_file(target)
                return
        self._not_found()

    def _send_file(self, path: Path) -> None:
        content = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self._headers(mimetypes.guess_type(path.name)[0] or "application/octet-stream", len(content))
        self.end_headers()
        self.wfile.write(content)

    def _send_zip(self, job: dict[str, Any]) -> None:
        if job.get("status") != "done":
            self._send_json(HTTPStatus.CONFLICT, {"error": "El lote todavía no está listo."})
            return
        stream = io.BytesIO()
        root = _job_dir(job["id"]).resolve()
        with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
            for path in sorted((root / "outputs").rglob("*")) if (root / "outputs").exists() else []:
                if path.is_file() and root in path.resolve().parents:
                    archive.write(path, path.relative_to(root).as_posix())
            report = root / "reporte.json"
            if report.exists():
                archive.write(report, "reporte.json")
        content = stream.getvalue()
        self.send_response(HTTPStatus.OK)
        self._headers("application/zip", len(content))
        self.send_header("Content-Disposition", 'attachment; filename="fotos-la-catolica-hq-sam.zip"')
        self.end_headers()
        self.wfile.write(content)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        parts = [unquote(part) for part in parsed.path.split("/") if part]
        if parts == ["api", "jobs"]:
            self._create_job()
            return
        if len(parts) == 4 and parts[:2] == ["api", "jobs"] and parts[3] == "cancel":
            job_id = parts[2]
            with JOBS_LOCK:
                job = JOBS.get(job_id)
                if not job:
                    self._not_found()
                    return
                job["cancelled"] = True
                job["status"] = "cancelled"
            self._send_json(HTTPStatus.OK, _jsonable_job(job))
            return
        self._not_found()

    def _create_job(self) -> None:
        content_length = int(self.headers.get("Content-Length", "0"))
        if content_length <= 0 or content_length > MAX_BATCH_BYTES:
            self._send_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "El lote supera el límite permitido."})
            return
        content_type = self.headers.get("Content-Type", "")
        if not content_type.lower().startswith("multipart/form-data"):
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Envía las fotos como formulario multipart."})
            return
        try:
            form = cgi.FieldStorage(fp=self.rfile, headers=self.headers, environ={"REQUEST_METHOD": "POST", "CONTENT_TYPE": content_type, "CONTENT_LENGTH": str(content_length)}, keep_blank_values=True)
            fields = form.list or []
            files = [field for field in fields if field.name in {"files", "file"} and getattr(field, "filename", None)]
            if not files or len(files) > MAX_FILES:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": f"Selecciona entre 1 y {MAX_FILES} fotos."})
                return
            job_id = uuid.uuid4().hex
            root = _job_dir(job_id)
            originals = root / "originals"
            originals.mkdir(parents=True, exist_ok=False)
            annotations_raw = next((field.value for field in fields if field.name == "annotations"), "[]")
            try:
                annotations = json.loads(annotations_raw) if annotations_raw else []
            except json.JSONDecodeError:
                annotations = []
            items: list[dict[str, Any]] = []
            used: set[str] = set()
            for index, field in enumerate(files):
                name = _safe_name(field.filename or f"foto-{index + 1}.jpg", f"foto-{index + 1}.jpg")
                suffix = Path(name).suffix.lower()
                if suffix not in ALLOWED_EXTENSIONS:
                    self._send_json(HTTPStatus.BAD_REQUEST, {"error": f"Formato no compatible: {suffix or 'desconocido'}."})
                    return
                base = Path(name).stem
                candidate = name
                counter = 2
                while candidate.lower() in used:
                    candidate = f"{base}-{counter}{suffix}"
                    counter += 1
                used.add(candidate.lower())
                target = originals / candidate
                data = field.file.read(MAX_FILE_BYTES + 1)
                if len(data) > MAX_FILE_BYTES:
                    self._send_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "Una de las fotos supera el límite de 50 MB."})
                    return
                target.write_bytes(data)
                items.append({"id": uuid.uuid4().hex[:12], "name": candidate, "source_path": str(target), "status": "queued"})
            now = time.time()
            job = {"id": job_id, "status": "queued", "created_at": now, "updated_at": now, "progress": {"completed": 0, "total": len(items), "stage": "queued"}, "items": items, "annotations": annotations, "cancelled": False}
            with JOBS_LOCK:
                JOBS[job_id] = job
            try:
                JOB_QUEUE.put_nowait(job_id)
            except queue.Full:
                _update(job_id, status="error", error="La cola está llena; intenta de nuevo en unos minutos.")
                self._send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "La cola está llena; intenta de nuevo en unos minutos."})
                return
            self._send_json(HTTPStatus.ACCEPTED, _jsonable_job(job))
        except Exception:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "No se pudo recibir el lote."})


def main() -> None:
    host = os.environ.get("PHOTO_EDITOR_HOST", "127.0.0.1")
    port = int(os.environ.get("PHOTO_EDITOR_PORT", "8787"))
    print(f"Editor HQ-SAM API escuchando en http://{host}:{port}")
    ThreadingHTTPServer((host, port), Handler).serve_forever()


if __name__ == "__main__":
    main()
