# Editor de fotos — La Católica

Web estática para colocar una foto dentro del marco institucional y descargar el resultado en JPG de 1200 × 1000 px. Incluye `logo.png`, recurso de marca proporcionado para el escudo.

## Uso

Abre `index.html` en un navegador moderno. También puedes servir la carpeta con cualquier servidor estático:

```powershell
python -m http.server 4173 --directory editor-marco-la-catolica
```

Luego visita `http://localhost:4173`.

Todo el procesamiento ocurre en el navegador. Ninguna foto se envía a un servidor.
