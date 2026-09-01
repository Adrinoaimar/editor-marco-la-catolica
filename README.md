# Editor de fotos — La Católica

Web estática para colocar una foto dentro del marco institucional y descargar el resultado local en JPG de 1200 × 1000 px. Mantiene además un panel de procesamiento profesional HQ‑SAM en segundo plano para lotes: segmentación guiada, desenfoque natural, corrección de color, versiones 1920 × 1080 y 1080 × 1350, QA y ZIP. Incluye `logo.png`, recurso de marca proporcionado para el escudo.

## Uso

Abre `index.html` en un navegador moderno. También puedes servir la carpeta con cualquier servidor estático:

```powershell
python -m http.server 4173 --directory editor-marco-la-catolica
```

Luego visita `http://localhost:4173`.

La edición rápida y el ZIP local ocurren en el navegador. El botón HQ‑SAM solo aparece cuando se configura una API de backend; las fotos se envían únicamente a ese servidor administrado por el operador. El navegador no recibe rutas locales, checkpoint ni credenciales.

## Conectar el procesamiento HQ‑SAM

Desde la carpeta del proyecto instala `backend/requirements.txt` y ejecuta `python -m backend.server`. Para una web servida desde otro origen puedes definir `window.PHOTO_EDITOR_API` antes de `app.js` o usar el parámetro de desarrollo `?api=http://127.0.0.1:8787/api`. Consulta [backend/README.md](backend/README.md) para límites, anotaciones manuales, carpeta vigilada y programación.

En Windows puedes abrir `ABRIR_EDITOR_PRO.bat`: inicia el backend y el servidor local, y abre el editor ya conectado. Si el botón muestra “Solo edición local”, recarga la página después de iniciar ese archivo.

## Demo pública

https://adrinoaimar.github.io/editor-marco-la-catolica/
