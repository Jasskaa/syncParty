# YouTube Sync Party

Extension de Chrome (Manifest V3) + servidor Node.js para ver videos de YouTube
sincronizados en tiempo real con chat integrado.

## Estructura

```
youtube-sync-party/
├── server/              # Backend WebSocket (Node.js + ws)
│   ├── server.js
│   └── package.json
└── extension/           # Extension de Chrome
    ├── manifest.json
    ├── background.js    # Service worker
    ├── contentScript.js # UI + motor de sincronizacion, inyectado en youtube.com
    ├── sidebar.css
    ├── popup.html / popup.js
    └── icons/
```

## 1. Levantar el servidor

```bash
cd server
npm install
npm start
```

Por defecto escucha en `ws://localhost:8787` (health check en `http://localhost:8787/health`).
Para produccion, ponlo detras de un proxy TLS (nginx/Caddy) y expon `wss://tu-dominio`.

## 2. Configurar la URL del servidor en la extension

Por defecto la extension apunta a `wss://localhost:8787` (ver `background.js`,
`DEFAULT_SERVER_URL`). Para desarrollo local sin TLS, cambia esa constante a
`ws://localhost:8787`, o añade un `chrome.runtime.sendMessage({type:'UPDATE_SETTINGS', payload:{serverUrl:'ws://localhost:8787'}})`
desde la consola del service worker.

## 3. Cargar la extension en Chrome

1. Abre `chrome://extensions`.
2. Activa "Modo de desarrollador".
3. Clic en "Cargar descomprimida" y selecciona la carpeta `extension/`.

## 4. Uso

- Abre un video en `youtube.com/watch?v=...`.
- Clic en el icono de la extension → "Crear Sala".
- Comparte el codigo de 6 caracteres o el enlace de invitacion
  (`?telepartyRoom=CODIGO`) generado con "Copiar enlace".
- Los invitados pueden pegar el codigo en el popup o simplemente abrir el enlace.

## Notas de arquitectura

- El estado de salas vive en memoria (`RoomStore` en `server.js`); la clase
  esta aislada para poder sustituirse por un backend Redis sin tocar el
  resto del servidor.
- La sincronizacion usa un umbral de 1.5s: desfases menores se ignoran,
  mayores fuerzan un `seekTo` limpio.
- Una bandera `isRemoteAction` evita bucles infinitos entre eventos locales
  del `<video>` y acciones aplicadas por el servidor.
