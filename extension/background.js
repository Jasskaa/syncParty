/**
 * background.js — Service Worker (Manifest V3)
 *
 * Responsabilidades:
 *  - Persistir identidad del usuario (userId, username, avatar) y config
 *    (server URL, host-only control) en chrome.storage.
 *  - Actuar como bus de mensajes entre popup.js y contentScript.js, ya que
 *    ambos corren en contextos aislados y no pueden hablarse directamente.
 *  - Detectar el parametro `telepartyRoom` en URLs de YouTube via
 *    webNavigation-like listener (usamos chrome.tabs.onUpdated) para avisar
 *    al content script cuando debe auto-unirse a una sala.
 */

// URL del servidor de sincronizacion. Debe usar wss:// (TLS) para funcionar
// entre dos redes distintas (Chrome bloquea ws:// sin cifrar desde una
// extension hacia un host remoto que no sea localhost).
const DEFAULT_SERVER_URL = 'wss://youtube-sync-party-server.onrender.com';
const STORAGE_KEYS = {
  IDENTITY: 'ysp_identity',
  SETTINGS: 'ysp_settings',
  SESSION: 'ysp_session', // sala activa actual (si la hay), para reconectar tras recargar popup
};

// ---------------------------------------------------------------------------
// Identidad: se genera una sola vez y persiste entre sesiones.
// ---------------------------------------------------------------------------

function generateUserId() {
  return crypto.randomUUID();
}

function randomNickname() {
  const adjetivos = ['Veloz', 'Curioso', 'Tranquilo', 'Alegre', 'Astuto', 'Brillante'];
  const animales = ['Panda', 'Zorro', 'Halcon', 'Lince', 'Koala', 'Nutria'];
  const a = adjetivos[Math.floor(Math.random() * adjetivos.length)];
  const b = animales[Math.floor(Math.random() * animales.length)];
  return `${a}${b}${Math.floor(Math.random() * 90 + 10)}`;
}

async function getOrCreateIdentity() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.IDENTITY);
  if (stored[STORAGE_KEYS.IDENTITY]) return stored[STORAGE_KEYS.IDENTITY];

  const identity = {
    userId: generateUserId(),
    username: randomNickname(),
    avatar: null, // dataURL o emoji, configurable desde el popup
  };
  await chrome.storage.local.set({ [STORAGE_KEYS.IDENTITY]: identity });
  return identity;
}

async function getSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  return stored[STORAGE_KEYS.SETTINGS] || { serverUrl: DEFAULT_SERVER_URL };
}

async function updateSettings(partial) {
  const current = await getSettings();
  const next = { ...current, ...partial };
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: next });
  return next;
}

async function getSession() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.SESSION);
  return stored[STORAGE_KEYS.SESSION] || null;
}

async function setSession(session) {
  if (session) {
    await chrome.storage.local.set({ [STORAGE_KEYS.SESSION]: session });
  } else {
    await chrome.storage.local.remove(STORAGE_KEYS.SESSION);
  }
}

// ---------------------------------------------------------------------------
// Bus de mensajes: popup <-> background <-> contentScript
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch((err) => {
    sendResponse({ ok: false, error: err?.message || String(err) });
  });
  return true; // respuesta asincrona
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case 'GET_IDENTITY': {
      const identity = await getOrCreateIdentity();
      return { ok: true, identity };
    }

    case 'UPDATE_IDENTITY': {
      const current = await getOrCreateIdentity();
      const next = { ...current, ...message.payload };
      await chrome.storage.local.set({ [STORAGE_KEYS.IDENTITY]: next });
      return { ok: true, identity: next };
    }

    case 'GET_SETTINGS': {
      return { ok: true, settings: await getSettings() };
    }

    case 'UPDATE_SETTINGS': {
      return { ok: true, settings: await updateSettings(message.payload || {}) };
    }

    case 'GET_SESSION': {
      return { ok: true, session: await getSession() };
    }

    case 'SET_SESSION': {
      await setSession(message.payload || null);
      return { ok: true };
    }

    // El popup pide crear/unirse a una sala -> se delega al content script
    // de la pestaña activa, que es quien controla el reproductor real.
    case 'CREATE_ROOM_REQUEST':
    case 'JOIN_ROOM_REQUEST': {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return { ok: false, error: 'No hay pestaña activa de YouTube.' };
      return await chrome.tabs.sendMessage(tab.id, message);
    }

    // El content script informa al background del estado actual (para que
    // el popup pueda consultarlo aunque se haya cerrado y reabierto).
    case 'ROOM_STATE_UPDATE': {
      await setSession(message.payload);
      return { ok: true };
    }

    case 'ROOM_LEFT': {
      await setSession(null);
      return { ok: true };
    }

    default:
      return { ok: false, error: `Mensaje desconocido: ${message?.type}` };
  }
}

// ---------------------------------------------------------------------------
// Deteccion de enlaces de invitacion (?telepartyRoom=ROOMID)
// ---------------------------------------------------------------------------

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'loading' || !tab.url) return;
  if (!tab.url.includes('youtube.com/watch')) return;

  let roomId = null;
  try {
    roomId = new URL(tab.url).searchParams.get('telepartyRoom');
  } catch {
    return;
  }
  if (!roomId) return;

  // Se reintenta unos ms por si el content script aun no cargo.
  const tryNotify = (attempt = 0) => {
    chrome.tabs.sendMessage(tabId, { type: 'AUTO_JOIN_FROM_LINK', payload: { roomId } })
      .catch(() => {
        if (attempt < 5) setTimeout(() => tryNotify(attempt + 1), 400);
      });
  };
  setTimeout(() => tryNotify(), 600);
});

chrome.runtime.onInstalled.addListener(() => {
  getOrCreateIdentity();
  getSettings();
});
