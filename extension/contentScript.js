/**
 * contentScript.js — YouTube Sync Party
 *
 * Se inyecta en cada pagina de youtube.com. Responsabilidades:
 *   1. Motor de sincronizacion del reproductor HTML5 nativo de YouTube.
 *   2. Puente WebSocket con el servidor de salas.
 *   3. Inyeccion y manejo de la UI (sidebar, chat, drawer de usuarios).
 *   4. Deteccion de navegacion SPA de YouTube (yt-navigate-finish) y de
 *      parametros de invitacion en la URL (?telepartyRoom=).
 *
 * Todo vive en un IIFE para no filtrar globals a la pagina de YouTube.
 */

(function () {
  'use strict';

  if (window.__yspInjected) return; // evita doble inyeccion en SPA reloads
  window.__yspInjected = true;

  const DESYNC_THRESHOLD_SEC = 1.5;
  const RECONNECT_BASE_DELAY_MS = 1000;
  const RECONNECT_MAX_DELAY_MS = 15000;
  const SEEK_DEBOUNCE_MS = 400;

  const EMOJI_SET = ['😀', '😂', '😍', '👍', '🔥', '🎉', '😢', '😮', '❤️', '👀', '🙌', '💀'];

  // ---------------------------------------------------------------------
  // Estado global del modulo
  // ---------------------------------------------------------------------

  const state = {
    ws: null,
    wsUrl: null,
    connected: false,
    reconnectAttempts: 0,
    reconnectTimer: null,

    identity: null, // { userId, username, avatar } — persistente, compartida por todo el perfil de Chrome
    sessionId: crypto.randomUUID(), // id de conexion propio de ESTA pestaña; evita colisiones cuando el mismo perfil abre varias pestañas en la misma sala
    roomId: null,
    hostUserId: null,
    hostOnlyControl: false,
    users: [],
    lastKnownVideoId: null, // ultimo videoId confirmado por la sala; evita CHANGE_VIDEO espurios en cada yt-navigate-finish

    isRemoteAction: false, // evita bucles de eventos al aplicar sync remoto
    isRemoteNavigation: false, // evita re-emitir CHANGE_VIDEO al navegar por instruccion remota
    pendingSeekDebounce: null,

    sidebarCollapsed: false,
    userDrawerOpen: false,
  };

  // ---------------------------------------------------------------------
  // Utilidades
  // ---------------------------------------------------------------------

  function getCurrentVideoId() {
    try {
      return new URL(window.location.href).searchParams.get('v');
    } catch {
      return null;
    }
  }

  function getVideoEl() {
    return document.querySelector('video.html5-main-video') || document.querySelector('video');
  }

  function sendRuntimeMessage(type, payload) {
    return chrome.runtime.sendMessage({ type, payload });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ---------------------------------------------------------------------
  // WebSocket bridge
  // ---------------------------------------------------------------------

  const listeners = new Map(); // type -> Set<fn>

  function on(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
  }

  function emit(type, payload) {
    listeners.get(type)?.forEach((fn) => fn(payload));
  }

  function wsSend(type, payload) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    state.ws.send(JSON.stringify({ type, payload }));
  }

  function connectWs(url) {
    state.wsUrl = url;
    clearTimeout(state.reconnectTimer);

    const ws = new WebSocket(url);
    state.ws = ws;

    ws.addEventListener('open', () => {
      state.connected = true;
      state.reconnectAttempts = 0;
      emit('CONNECTION_CHANGE', { connected: true });
    });

    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      emit(msg.type, msg.payload);
    });

    ws.addEventListener('close', () => {
      state.connected = false;
      emit('CONNECTION_CHANGE', { connected: false });
      scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      ws.close();
    });
  }

  function scheduleReconnect() {
    if (!state.roomId) return; // no reconectar si el usuario salio voluntariamente
    const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** state.reconnectAttempts, RECONNECT_MAX_DELAY_MS);
    state.reconnectAttempts += 1;
    state.reconnectTimer = setTimeout(() => connectWs(state.wsUrl), delay);
  }

  function disconnectWs() {
    clearTimeout(state.reconnectTimer);
    if (state.ws) {
      state.ws.onclose = null;
      state.ws.close();
      state.ws = null;
    }
    state.connected = false;
  }

  // ---------------------------------------------------------------------
  // Motor de sincronizacion del reproductor
  // ---------------------------------------------------------------------

  function withRemoteAction(fn) {
    state.isRemoteAction = true;
    try {
      fn();
    } finally {
      // El siguiente tick de eventos del <video> ya habra disparado;
      // liberamos la bandera en un microtask para no bloquear eventos futuros.
      setTimeout(() => { state.isRemoteAction = false; }, 50);
    }
  }

  function applyRemoteSync({ type, time }) {
    const video = getVideoEl();
    if (!video) return;

    const localTime = video.currentTime;
    const diff = Math.abs(localTime - time);

    withRemoteAction(() => {
      if (diff > DESYNC_THRESHOLD_SEC) {
        video.currentTime = time;
      }
      if (type === 'PLAY' && video.paused) video.play().catch(() => {});
      if (type === 'PAUSE' && !video.paused) video.pause();
    });
  }

  function attachPlayerListeners() {
    const video = getVideoEl();
    if (!video || video.__yspListenersAttached) return;
    video.__yspListenersAttached = true;

    video.addEventListener('play', () => {
      if (state.isRemoteAction || !state.roomId) return;
      if (!canLocalUserControl()) { revertUnauthorizedAction(); return; }
      wsSend('SYNC_ACTION', { type: 'PLAY', time: video.currentTime });
    });

    video.addEventListener('pause', () => {
      if (state.isRemoteAction || !state.roomId) return;
      if (!canLocalUserControl()) { revertUnauthorizedAction(); return; }
      wsSend('SYNC_ACTION', { type: 'PAUSE', time: video.currentTime });
    });

    video.addEventListener('seeking', () => {
      if (state.isRemoteAction || !state.roomId) return;
      if (!canLocalUserControl()) { revertUnauthorizedAction(); return; }
      // Debounce: 'seeking' puede dispararse muchas veces al arrastrar la barra.
      clearTimeout(state.pendingSeekDebounce);
      state.pendingSeekDebounce = setTimeout(() => {
        wsSend('SYNC_ACTION', { type: 'SEEK', time: video.currentTime });
      }, SEEK_DEBOUNCE_MS);
    });
  }

  function canLocalUserControl() {
    if (!state.hostOnlyControl) return true;
    return state.sessionId === state.hostUserId;
  }

  let lastKnownGoodTime = 0;
  function revertUnauthorizedAction() {
    const video = getVideoEl();
    if (!video) return;
    withRemoteAction(() => {
      video.currentTime = lastKnownGoodTime;
      if (video.paused) video.play().catch(() => {}); // solo el host controla -> se restaura reproduccion
    });
    pushSystemMessage('Solo el host puede controlar la reproduccion en esta sala.');
  }

  setInterval(() => {
    const video = getVideoEl();
    if (video && !video.seeking) lastKnownGoodTime = video.currentTime;
  }, 1000);

  // ---------------------------------------------------------------------
  // Manejo de la sala (crear / unir / salir)
  // ---------------------------------------------------------------------

  async function ensureIdentity() {
    if (state.identity) return state.identity;
    const res = await sendRuntimeMessage('GET_IDENTITY');
    state.identity = res.identity;
    return state.identity;
  }

  async function getServerUrl() {
    const res = await sendRuntimeMessage('GET_SETTINGS');
    return res.settings.serverUrl;
  }

  async function createRoom(options = {}) {
    const identity = await ensureIdentity();
    const video = getVideoEl();
    const videoId = getCurrentVideoId();
    if (!videoId || !video) throw new Error('No se detecto un video de YouTube activo.');

    const url = await getServerUrl();
    connectWs(url);

    return new Promise((resolve, reject) => {
      const onCreated = (payload) => {
        applyRoomState(payload);
        persistSession();
        listeners.get('ROOM_CREATED')?.delete(onCreated);
        resolve(payload);
      };
      on('ROOM_CREATED', onCreated);

      const openOrSend = () => {
        wsSend('CREATE_ROOM', {
          userId: state.sessionId,
          username: identity.username,
          avatar: identity.avatar,
          videoId,
          currentTime: video.currentTime,
          playerState: video.paused ? 'paused' : 'playing',
          hostOnlyControl: !!options.hostOnlyControl,
        });
      };

      if (state.ws.readyState === WebSocket.OPEN) openOrSend();
      else state.ws.addEventListener('open', openOrSend, { once: true });

      setTimeout(() => reject(new Error('Timeout al crear la sala.')), 8000);
    });
  }

  async function joinRoom(roomId) {
    const identity = await ensureIdentity();
    const url = await getServerUrl();
    connectWs(url);

    return new Promise((resolve, reject) => {
      const onJoined = (payload) => {
        applyRoomState(payload);
        persistSession();
        cleanup();
        resolve(payload);
      };
      const onError = (payload) => {
        cleanup();
        reject(new Error(payload.message || 'No se pudo unir a la sala.'));
      };
      function cleanup() {
        listeners.get('ROOM_JOINED')?.delete(onJoined);
        listeners.get('ERROR')?.delete(onError);
      }

      on('ROOM_JOINED', onJoined);
      on('ERROR', onError);

      const openOrSend = () => {
        wsSend('JOIN_ROOM', {
          roomId: roomId.toUpperCase(),
          userId: state.sessionId,
          username: identity.username,
          avatar: identity.avatar,
          currentVideoId: getCurrentVideoId(),
        });
      };

      if (state.ws.readyState === WebSocket.OPEN) openOrSend();
      else state.ws.addEventListener('open', openOrSend, { once: true });

      setTimeout(() => { cleanup(); reject(new Error('Timeout al unirse a la sala.')); }, 8000);
    });
  }

  function applyRoomState(payload) {
    state.roomId = payload.roomId;
    state.hostUserId = payload.hostUserId;
    state.hostOnlyControl = payload.hostOnlyControl;
    state.users = payload.users;
    state.lastKnownVideoId = payload.videoId;

    ensureSidebar();
    showSidebar();
    renderHeader();
    renderUserList();
    attachPlayerListeners();

    // Alinea el reproductor local al estado de la sala al entrar.
    applyRemoteSync({ type: payload.playerState === 'playing' ? 'PLAY' : 'PAUSE', time: payload.currentTime });
  }

  function persistSession() {
    sendRuntimeMessage('SET_SESSION', {
      roomId: state.roomId,
      hostUserId: state.hostUserId,
    });
  }

  function leaveRoom() {
    wsSend('LEAVE_ROOM', {});
    disconnectWs();
    state.roomId = null;
    state.hostUserId = null;
    state.users = [];
    hideSidebar();
    sendRuntimeMessage('ROOM_LEFT');
  }

  // ---------------------------------------------------------------------
  // Listeners de eventos del servidor
  // ---------------------------------------------------------------------

  on('CONNECTION_CHANGE', ({ connected }) => {
    const dot = document.getElementById('ysp-connection-dot');
    if (dot) dot.classList.toggle('ysp-online', connected);
  });

  on('SYNC_ACTION', (payload) => applyRemoteSync(payload));

  // Correccion periodica de deriva: el servidor manda su posicion autoritativa
  // cada pocos segundos. Reutiliza el mismo umbral de 1.5s, asi que en el caso
  // normal no hace nada; solo actua si alguien se atraso (p.ej. por un anuncio).
  on('HEARTBEAT_SYNC', (payload) => {
    applyRemoteSync({ type: payload.playerState === 'playing' ? 'PLAY' : 'PAUSE', time: payload.time });
  });

  on('CHANGE_VIDEO', (payload) => {
    state.isRemoteNavigation = true;
    state.lastKnownVideoId = payload.videoId;
    const newUrl = new URL(window.location.href);
    newUrl.searchParams.set('v', payload.videoId);
    newUrl.searchParams.delete('telepartyRoom');
    window.location.href = newUrl.toString();
  });

  on('CHAT_MESSAGE', (payload) => appendChatMessage(payload));

  on('USER_JOINED', () => {});
  on('USER_LEFT', () => {});

  on('USER_LIST', ({ users, hostUserId }) => {
    state.users = users;
    state.hostUserId = hostUserId;
    renderUserList();
    renderHeader();
  });

  on('ROOM_SETTINGS_UPDATED', ({ hostOnlyControl }) => {
    state.hostOnlyControl = hostOnlyControl;
    pushSystemMessage(hostOnlyControl ? 'Solo el host puede controlar la reproduccion.' : 'Todos pueden controlar la reproduccion.');
  });

  on('ERROR', (payload) => {
    console.warn('[YouTube Sync Party]', payload.code, payload.message);
  });

  // ---------------------------------------------------------------------
  // UI: construccion del sidebar
  // ---------------------------------------------------------------------

  let sidebarBuilt = false;

  function ensureSidebar() {
    if (sidebarBuilt) return;
    sidebarBuilt = true;

    const root = document.createElement('div');
    root.id = 'ysp-root';
    root.innerHTML = `
      <div id="ysp-header">
        <div id="ysp-header-top">
          <div id="ysp-connection-indicator">
            <span id="ysp-connection-dot"></span>
            <span id="ysp-connection-label">Conectando...</span>
          </div>
          <div id="ysp-user-count" title="Ver participantes">👥 <span id="ysp-user-count-num">0</span></div>
        </div>
        <div id="ysp-room-row">
          <span id="ysp-room-code">------</span>
          <button id="ysp-copy-link-btn">Copiar enlace</button>
          <button id="ysp-leave-btn" title="Salir de la sala" style="margin-left:auto;background:transparent;border:none;color:var(--ysp-text-dim);cursor:pointer;font-size:16px;">✕</button>
        </div>
      </div>
      <div id="ysp-user-drawer"></div>
      <div id="ysp-chat-area"></div>
      <div id="ysp-input-area" style="position:relative;">
        <div id="ysp-emoji-picker"></div>
        <button id="ysp-emoji-btn" title="Emojis">😊</button>
        <input id="ysp-chat-input" type="text" placeholder="Escribe un mensaje..." maxlength="500" autocomplete="off" />
        <button id="ysp-send-btn" title="Enviar">➤</button>
      </div>
    `;
    document.body.appendChild(root);

    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'ysp-toggle-btn';
    toggleBtn.title = 'Mostrar/ocultar chat';
    toggleBtn.textContent = '💬';
    document.body.appendChild(toggleBtn);

    toggleBtn.addEventListener('click', toggleSidebarCollapsed);

    document.getElementById('ysp-copy-link-btn').addEventListener('click', copyInviteLink);
    document.getElementById('ysp-leave-btn').addEventListener('click', () => {
      if (confirm('¿Salir de la sala?')) leaveRoom();
    });
    document.getElementById('ysp-user-count').addEventListener('click', toggleUserDrawer);

    const emojiPicker = document.getElementById('ysp-emoji-picker');
    emojiPicker.innerHTML = EMOJI_SET.map((e) => `<div class="ysp-emoji-item">${e}</div>`).join('');
    emojiPicker.addEventListener('click', (e) => {
      const target = e.target.closest('.ysp-emoji-item');
      if (!target) return;
      const input = document.getElementById('ysp-chat-input');
      input.value += target.textContent;
      input.focus();
    });
    document.getElementById('ysp-emoji-btn').addEventListener('click', () => {
      emojiPicker.classList.toggle('ysp-open');
    });

    const input = document.getElementById('ysp-chat-input');
    document.getElementById('ysp-send-btn').addEventListener('click', () => sendChatFromInput(input));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendChatFromInput(input);
    });
  }

  function sendChatFromInput(input) {
    const text = input.value.trim();
    if (!text) return;
    wsSend('CHAT_MESSAGE', { text });
    input.value = '';
    document.getElementById('ysp-emoji-picker')?.classList.remove('ysp-open');
  }

  function showSidebar() {
    document.getElementById('ysp-root')?.classList.remove('ysp-collapsed');
    document.getElementById('ysp-toggle-btn')?.classList.remove('ysp-collapsed');
    document.documentElement.classList.add('ysp-sidebar-open');
  }

  function hideSidebar() {
    document.getElementById('ysp-root')?.remove();
    document.getElementById('ysp-toggle-btn')?.remove();
    document.documentElement.classList.remove('ysp-sidebar-open');
    sidebarBuilt = false;
  }

  function toggleSidebarCollapsed() {
    state.sidebarCollapsed = !state.sidebarCollapsed;
    document.getElementById('ysp-root')?.classList.toggle('ysp-collapsed', state.sidebarCollapsed);
    document.getElementById('ysp-toggle-btn')?.classList.toggle('ysp-collapsed', state.sidebarCollapsed);
    document.documentElement.classList.toggle('ysp-sidebar-open', !state.sidebarCollapsed);
  }

  function toggleUserDrawer() {
    state.userDrawerOpen = !state.userDrawerOpen;
    document.getElementById('ysp-user-drawer')?.classList.toggle('ysp-open', state.userDrawerOpen);
  }

  function renderHeader() {
    const codeEl = document.getElementById('ysp-room-code');
    if (codeEl) codeEl.textContent = state.roomId || '------';

    const label = document.getElementById('ysp-connection-label');
    if (label) label.textContent = state.connected ? 'Conectado' : 'Reconectando...';

    const countEl = document.getElementById('ysp-user-count-num');
    if (countEl) countEl.textContent = String(state.users.length);
  }

  function renderUserList() {
    const drawer = document.getElementById('ysp-user-drawer');
    if (!drawer) return;
    drawer.innerHTML = state.users.map((u) => `
      <div class="ysp-user-row">
        <div class="ysp-user-avatar">${escapeHtml((u.username || '?').slice(0, 1).toUpperCase())}</div>
        <span>${escapeHtml(u.username)}</span>
        ${u.userId === state.hostUserId ? '<span class="ysp-host-badge">HOST</span>' : ''}
      </div>
    `).join('');
  }

  function appendChatMessage(payload) {
    const chatArea = document.getElementById('ysp-chat-area');
    if (!chatArea) return;

    const el = document.createElement('div');

    if (payload.system) {
      el.className = 'ysp-msg ysp-msg-system';
      el.textContent = payload.text;
    } else {
      const isOwn = payload.userId === state.sessionId;
      el.className = `ysp-msg${isOwn ? ' ysp-msg-own' : ''}`;
      el.innerHTML = `
        <div class="ysp-msg-meta">
          <span class="ysp-msg-username">${escapeHtml(payload.username)}</span>
          <span>${new Date(payload.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
        <div class="ysp-msg-bubble">${escapeHtml(payload.text)}</div>
      `;
    }

    chatArea.appendChild(el);
    chatArea.scrollTop = chatArea.scrollHeight;
  }

  function pushSystemMessage(text) {
    appendChatMessage({ system: true, text });
  }

  async function copyInviteLink() {
    const url = new URL(window.location.href);
    url.searchParams.set('telepartyRoom', state.roomId);
    url.searchParams.delete('t');
    try {
      await navigator.clipboard.writeText(url.toString());
      const btn = document.getElementById('ysp-copy-link-btn');
      const original = btn.textContent;
      btn.textContent = '¡Copiado!';
      setTimeout(() => { btn.textContent = original; }, 1500);
    } catch {
      prompt('Copia el enlace manualmente:', url.toString());
    }
  }

  // ---------------------------------------------------------------------
  // Navegacion SPA de YouTube y cambio de video
  // ---------------------------------------------------------------------

  document.addEventListener('yt-navigate-finish', () => {
    if (state.isRemoteNavigation) {
      state.isRemoteNavigation = false;
      // Espera a que el nuevo <video> exista antes de re-enganchar listeners.
      waitForVideoEl().then(attachPlayerListeners);
      return;
    }

    // Auto-join por parametro de URL (?telepartyRoom=...)
    const roomIdFromUrl = new URL(window.location.href).searchParams.get('telepartyRoom');
    if (roomIdFromUrl && roomIdFromUrl !== state.roomId) {
      waitForVideoEl().then(() => joinRoom(roomIdFromUrl).catch((err) => console.warn('[YouTube Sync Party] auto-join fallo:', err.message)));
      return;
    }

    // Si el usuario (host) navego manualmente a otro video estando en sala.
    // Se compara contra lastKnownVideoId (no solo "hay sala activa") para no
    // reemitir CHANGE_VIDEO en cada yt-navigate-finish cuando el video no cambio.
    if (state.roomId) {
      const videoId = getCurrentVideoId();
      if (videoId && videoId !== state.lastKnownVideoId && canLocalUserControl()) {
        state.lastKnownVideoId = videoId;
        waitForVideoEl().then(() => {
          attachPlayerListeners();
          wsSend('CHANGE_VIDEO', { videoId });
        });
      }
    }
  });

  function waitForVideoEl(timeoutMs = 5000) {
    return new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        const v = getVideoEl();
        if (v) return resolve(v);
        if (Date.now() - start > timeoutMs) return resolve(null);
        requestAnimationFrame(check);
      };
      check();
    });
  }

  // ---------------------------------------------------------------------
  // Mensajes desde popup.js / background.js
  // ---------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleExternalMessage(message).then(sendResponse).catch((err) => {
      sendResponse({ ok: false, error: err?.message || String(err) });
    });
    return true;
  });

  async function handleExternalMessage(message) {
    switch (message?.type) {
      case 'CREATE_ROOM_REQUEST': {
        const result = await createRoom(message.payload || {});
        return { ok: true, roomId: result.roomId };
      }
      case 'JOIN_ROOM_REQUEST': {
        const result = await joinRoom(message.payload.roomId);
        return { ok: true, roomId: result.roomId };
      }
      case 'AUTO_JOIN_FROM_LINK': {
        if (state.roomId === message.payload.roomId) return { ok: true };
        const result = await joinRoom(message.payload.roomId);
        return { ok: true, roomId: result.roomId };
      }
      case 'GET_ROOM_STATUS': {
        return { ok: true, roomId: state.roomId || null };
      }
      default:
        return { ok: false, error: 'Mensaje no soportado por el content script.' };
    }
  }

  // ---------------------------------------------------------------------
  // Bootstrap: si la URL ya trae ?telepartyRoom= al cargar la pagina.
  // ---------------------------------------------------------------------

  (async function bootstrap() {
    await ensureIdentity();
    const roomIdFromUrl = new URL(window.location.href).searchParams.get('telepartyRoom');
    if (roomIdFromUrl) {
      await waitForVideoEl();
      joinRoom(roomIdFromUrl).catch((err) => console.warn('[YouTube Sync Party] auto-join fallo:', err.message));
    }
  })();
})();
