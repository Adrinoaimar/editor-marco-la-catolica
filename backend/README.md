# Servicio profesional HQ-SAM

Este servicio se integra con la interfaz existente. La web sigue ofreciendo la edición rápida local y, cuando `PHOTO_EDITOR_API` apunta a este servicio, habilita la cola profesional.

## Ejecutar en local

Desde la carpeta del proyecto:

```powershell
python -m pip install -r backend/requirements.txt
$env:PHOTO_EDITOR_ORIGIN = "http://127.0.0.1:4173"
python -m backend.server
```

El modelo y la configuración se resuelven en el servidor. Se pueden cambiar con `SAM_HQ_CHECKPOINT` y `SAM_HQ_CONFIG`; esas rutas nunca se envían al navegador.

## API

- `POST /api/jobs`: recibe `files` (multipart) y, opcionalmente, `annotations` como JSON.
- `GET /api/jobs/{id}`: estado, progreso por imagen, score, cobertura y marca `needs_review`.
- `POST /api/jobs/{id}/cancel`: solicita cancelar un lote en cola o entre imágenes.
- `GET /api/jobs/{id}/download`: ZIP con JPG horizontal 1920×1080, JPG vertical 1080×1350 y `reporte.json`.
- `GET /api/jobs/{id}/files/...`: entrega únicamente resultados del trabajo.

Las anotaciones aceptan `positive`, `negative`, `box`, `add_segments`, `subtract_segments`, `inclusions` y `exclusions`, con coordenadas de la imagen original. Así se conservan inclusiones/exclusiones manuales para accesorios finos sin exponer rutas del servidor.

## Carpeta vigilada / programada

Para automatizar un directorio administrado en el servidor, configura antes de iniciar:

```powershell
$env:PHOTO_EDITOR_WATCH_DIR = "C:\ruta\controlada"
$env:PHOTO_EDITOR_WATCH_INTERVAL_SEC = "900"
python -m backend.server
```

Cada archivo nuevo se convierte en un lote; el mismo intervalo sirve como ejecución programada. El directorio debe estar fuera del navegador y bajo control del operador; no se aceptan rutas recibidas por la API. La activación visual de esta función se deja deliberadamente administrativa para evitar que un usuario pueda leer carpetas arbitrarias.
