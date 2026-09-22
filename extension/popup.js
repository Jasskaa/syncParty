/**
 * popup.js — logica del popup de la extension.
 * Corre en el contexto del popup (no tiene acceso al DOM de YouTube),
 * asi que delega toda accion real al background, que a su vez la reenvia
 * al content script de la pestaña activa.
 */

const statusEl = document.getElementById('status');
const btnCreate = document.getElementById('btnCreate');
const btnJoin = document.getElementById('btnJoin');
const joinCodeInput = document.getElementById('joinCode');

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

function setBusy(busy) {
  btnCreate.disabled = busy;
  btnJoin.disabled = busy;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function ensureOnYouTubeWatch() {
  const tab = await getActiveTab();
  if (!tab?.url || !tab.url.includes('youtube.com/watch')) {
    setStatus('Abre un video de YouTube antes de crear o unirte a una sala.', true);
    return null;
  }
  return tab;
}

btnCreate.addEventListener('click', async () => {
  const tab = await ensureOnYouTubeWatch();
  if (!tab) return;

  setBusy(true);
  setStatus('Creando sala...');
  try {
    const response = await chrome.runtime.sendMessage({ type: 'CREATE_ROOM_REQUEST' });
    if (response?.ok) {
      setStatus(`Sala creada: ${response.roomId}. La barra lateral ya deberia estar abierta en la pestaña.`);
      window.close();
    } else {
      setStatus(response?.error || 'No se pudo crear la sala.', true);
    }
  } catch (err) {
    setStatus('Error de comunicacion con la pestaña. Recarga YouTube e intenta de nuevo.', true);
  } finally {
    setBusy(false);
  }
});

btnJoin.addEventListener('click', async () => {
  const code = joinCodeInput.value.trim().toUpperCase();
  if (code.length !== 6) {
    setStatus('El codigo de sala debe tener 6 caracteres.', true);
    return;
  }

  setBusy(true);
  setStatus('Uniendose a la sala...');
  try {
    const tab = await getActiveTab();
    const onYouTube = tab?.url?.includes('youtube.com');

    if (!onYouTube) {
      // No hay pestaña de YouTube activa: abrimos una nueva a youtube.com
      // y dejamos que el usuario reintente una vez cargue (evita adivinar
      // un videoId que no conocemos todavia).
      await chrome.tabs.create({ url: 'https://www.youtube.com' });
      setStatus('Se abrio YouTube. Vuelve a intentar unirte desde ahi.', true);
      return;
    }

    const response = await chrome.runtime.sendMessage({
      type: 'JOIN_ROOM_REQUEST',
      payload: { roomId: code },
    });

    if (response?.ok) {
      setStatus('Te uniste a la sala.');
      window.close();
    } else {
      setStatus(response?.error || 'No se pudo unir a la sala.', true);
    }
  } catch (err) {
    setStatus('Error de comunicacion con la pestaña. Recarga YouTube e intenta de nuevo.', true);
  } finally {
    setBusy(false);
  }
});

joinCodeInput.addEventListener('input', () => {
  joinCodeInput.value = joinCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

(async function init() {
  const tab = await getActiveTab();
  const session = await chrome.runtime.sendMessage({ type: 'GET_SESSION' });

  // La sesion guardada en background puede quedar obsoleta si la pestaña que
  // la creo se recargo o navego (el content script pierde su estado en
  // memoria sin avisar). Se valida contra el content script real antes de
  // confiar en ella; si no responde o dice que no hay sala, se limpia.
  let activeRoomId = null;
  if (session?.session?.roomId && tab?.id) {
    try {
      const liveStatus = await chrome.tabs.sendMessage(tab.id, { type: 'GET_ROOM_STATUS' });
      if (liveStatus?.roomId) activeRoomId = liveStatus.roomId;
    } catch {
      // el content script no respondio (pestaña distinta, recargando, etc.)
    }
    if (!activeRoomId) {
      await chrome.runtime.sendMessage({ type: 'SET_SESSION', payload: null });
    }
  }

  if (activeRoomId) {
    setStatus(`Ya estas en la sala ${activeRoomId}. Abre la barra lateral en YouTube para verla.`);
    btnCreate.textContent = 'Ya estas en una sala';
    btnCreate.disabled = true;
  } else if (!tab?.url?.includes('youtube.com/watch')) {
    setStatus('Abre un video de YouTube para crear una sala.');
  } else {
    setStatus('Listo para crear o unirte a una sala.');
  }
})();
