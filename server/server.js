'use strict';

/**
 * YouTube Sync Party — servidor de sincronizacion en tiempo real.
 *
 * Arquitectura: WebSocket puro (ws), estado de salas en memoria (Map),
 * diseñado para ser "Redis-ready": toda la lectura/escritura de estado de
 * sala pasa por la clase RoomStore, que es el unico punto a sustituir por
 * un backend distribuido (Redis) si se necesita escalar horizontalmente.
 */

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8787;
const HEARTBEAT_INTERVAL_MS = 30000;
const ROOM_ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O/1/I para evitar confusion
const ROOM_ID_LENGTH = 6;
const ROOM_TTL_EMPTY_MS = 5 * 60 * 1000; // salas vacias se limpian tras 5 min

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function generateRoomId() {
  let id = '';
  for (let i = 0; i < ROOM_ID_LENGTH; i++) {
    id += ROOM_ID_ALPHABET[crypto.randomInt(0, ROOM_ID_ALPHABET.length)];
  }
  return id;
}

function generateUserId() {
  return crypto.randomUUID();
}

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function nowTs() {
  return Date.now();
}

// ---------------------------------------------------------------------------
// RoomStore: estado de salas en memoria (interfaz Redis-ready)
// ---------------------------------------------------------------------------

class RoomStore {
  constructor() {
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
  }

  create(roomId, room) {
    this.rooms.set(roomId, room);
  }

  get(roomId) {
    return this.rooms.get(roomId) || null;
  }

  has(roomId) {
    return this.rooms.has(roomId);
  }

  delete(roomId) {
    this.rooms.delete(roomId);
  }

  generateUniqueRoomId() {
    let id;
    do {
      id = generateRoomId();
    } while (this.rooms.has(id));
    return id;
  }
}

// ---------------------------------------------------------------------------
// Modelo de Sala
// ---------------------------------------------------------------------------

class Room {
  constructor(roomId, hostUserId, options = {}) {
    this.roomId = roomId;
    this.hostUserId = hostUserId;
    this.hostOnlyControl = options.hostOnlyControl ?? false;

    /** @type {Map<string, {userId:string, username:string, avatar:string, ws:import('ws').WebSocket, isHost:boolean}>} */
    this.users = new Map();

    this.videoId = options.videoId || null;
    this.currentTime = options.currentTime || 0;
    this.playerState = options.playerState || 'paused'; // 'playing' | 'paused'
    this.lastSyncTimestamp = nowTs();

    this.emptySince = null;
  }

  toPublicState() {
    return {
      roomId: this.roomId,
      videoId: this.videoId,
      currentTime: this.getInterpolatedTime(),
      playerState: this.playerState,
      hostOnlyControl: this.hostOnlyControl,
      hostUserId: this.hostUserId,
      users: this.listUsers(),
    };
  }

  listUsers() {
    return Array.from(this.users.values()).map((u) => ({
      userId: u.userId,
      username: u.username,
      avatar: u.avatar,
      isHost: u.userId === this.hostUserId,
    }));
  }

  // Estima donde deberia estar el reproductor "ahora" si esta en play,
  // extrapolando desde el ultimo evento de sincronizacion conocido.
  getInterpolatedTime() {
    if (this.playerState !== 'playing') return this.currentTime;
    const elapsedSec = (nowTs() - this.lastSyncTimestamp) / 1000;
    return this.currentTime + Math.max(0, elapsedSec);
  }

  applySync(type, time, userId) {
    this.currentTime = time;
    this.lastSyncTimestamp = nowTs();
    if (type === 'PLAY') this.playerState = 'playing';
    else if (type === 'PAUSE') this.playerState = 'paused';
    // SEEK conserva el playerState actual
  }

  canControl(userId) {
    if (!this.hostOnlyControl) return true;
    return userId === this.hostUserId;
  }

  isEmpty() {
    return this.users.size === 0;
  }
}

const store = new RoomStore();

// ---------------------------------------------------------------------------
// Servidor HTTP (health check) + WebSocket
// ---------------------------------------------------------------------------

const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', rooms: store.rooms.size, uptime: process.uptime() }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

const wss = new WebSocketServer({ server: httpServer });

// Metadata por conexion: a que sala/usuario pertenece este socket.
const connMeta = new WeakMap();

function send(ws, type, payload) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ type, payload, ts: nowTs() }));
}

function broadcast(room, type, payload, { excludeUserId = null } = {}) {
  for (const user of room.users.values()) {
    if (excludeUserId && user.userId === excludeUserId) continue;
    send(user.ws, type, payload);
  }
}

function sendError(ws, code, message) {
  send(ws, 'ERROR', { code, message });
}

function broadcastUserList(room) {
  broadcast(room, 'USER_LIST', { users: room.listUsers(), hostUserId: room.hostUserId });
}

function broadcastSystemMessage(room, text) {
  broadcast(room, 'CHAT_MESSAGE', {
    messageId: crypto.randomUUID(),
    userId: 'system',
    username: 'Sistema',
    text,
    timestamp: nowTs(),
    system: true,
  });
}

// ---------------------------------------------------------------------------
// Handlers de mensajes entrantes
// ---------------------------------------------------------------------------

function handleCreateRoom(ws, payload) {
  const { userId, username, avatar, videoId, currentTime, playerState, hostOnlyControl } = payload || {};
  if (!userId || !username || !videoId) {
    return sendError(ws, 'INVALID_PAYLOAD', 'userId, username y videoId son requeridos para crear sala.');
  }

  const roomId = store.generateUniqueRoomId();
  const room = new Room(roomId, userId, {
    videoId,
    currentTime: currentTime || 0,
    playerState: playerState || 'paused',
    hostOnlyControl: !!hostOnlyControl,
  });

  room.users.set(userId, { userId, username, avatar: avatar || null, ws, isHost: true });
  store.create(roomId, room);
  connMeta.set(ws, { roomId, userId });

  send(ws, 'ROOM_CREATED', room.toPublicState());
}

function handleJoinRoom(ws, payload) {
  const { roomId, userId, username, avatar, currentVideoId } = payload || {};
  if (!roomId || !userId || !username) {
    return sendError(ws, 'INVALID_PAYLOAD', 'roomId, userId y username son requeridos para unirse.');
  }

  const room = store.get(String(roomId).toUpperCase());
  if (!room) {
    return sendError(ws, 'ROOM_NOT_FOUND', `La sala ${roomId} no existe o ha expirado.`);
  }

  room.emptySince = null;
  room.users.set(userId, { userId, username, avatar: avatar || null, ws, isHost: userId === room.hostUserId });
  connMeta.set(ws, { roomId: room.roomId, userId });

  send(ws, 'ROOM_JOINED', room.toPublicState());

  broadcastSystemMessage(room, `${username} se unio a la sala.`);
  broadcast(room, 'USER_JOINED', { userId, username, avatar: avatar || null }, { excludeUserId: userId });
  broadcastUserList(room);

  // Si el invitado esta en un video distinto al de la sala, se le indica
  // explicitamente el video correcto (el content script hara el redirect).
  if (currentVideoId && currentVideoId !== room.videoId) {
    send(ws, 'CHANGE_VIDEO', { videoId: room.videoId, currentTime: room.getInterpolatedTime(), playerState: room.playerState });
  }
}

function handleSyncAction(ws, payload) {
  const meta = connMeta.get(ws);
  if (!meta) return sendError(ws, 'NOT_IN_ROOM', 'No perteneces a ninguna sala.');

  const room = store.get(meta.roomId);
  if (!room) return sendError(ws, 'ROOM_NOT_FOUND', 'La sala ya no existe.');

  const { type, time } = payload || {};
  if (!['PLAY', 'PAUSE', 'SEEK'].includes(type) || typeof time !== 'number') {
    return sendError(ws, 'INVALID_PAYLOAD', 'SYNC_ACTION requiere type valido y time numerico.');
  }

  if (!room.canControl(meta.userId)) {
    return sendError(ws, 'FORBIDDEN', 'Solo el host puede controlar la reproduccion en esta sala.');
  }

  room.applySync(type, time, meta.userId);

  broadcast(room, 'SYNC_ACTION', {
    type,
    time,
    timestamp: room.lastSyncTimestamp,
    userId: meta.userId,
  }, { excludeUserId: meta.userId });
}

function handleChangeVideo(ws, payload) {
  const meta = connMeta.get(ws);
  if (!meta) return sendError(ws, 'NOT_IN_ROOM', 'No perteneces a ninguna sala.');

  const room = store.get(meta.roomId);
  if (!room) return sendError(ws, 'ROOM_NOT_FOUND', 'La sala ya no existe.');

  const { videoId } = payload || {};
  if (!videoId) return sendError(ws, 'INVALID_PAYLOAD', 'videoId es requerido.');

  if (!room.canControl(meta.userId)) {
    return sendError(ws, 'FORBIDDEN', 'Solo el host puede cambiar el video en esta sala.');
  }

  room.videoId = videoId;
  room.currentTime = 0;
  room.playerState = 'paused';
  room.lastSyncTimestamp = nowTs();

  const username = room.users.get(meta.userId)?.username || 'Alguien';
  broadcastSystemMessage(room, `${username} cambio el video.`);
  broadcast(room, 'CHANGE_VIDEO', { videoId, currentTime: 0, playerState: 'paused' }, { excludeUserId: meta.userId });
}

function handleChatMessage(ws, payload) {
  const meta = connMeta.get(ws);
  if (!meta) return sendError(ws, 'NOT_IN_ROOM', 'No perteneces a ninguna sala.');

  const room = store.get(meta.roomId);
  if (!room) return sendError(ws, 'ROOM_NOT_FOUND', 'La sala ya no existe.');

  const { text } = payload || {};
  if (!text || typeof text !== 'string' || !text.trim()) return;

  const trimmed = text.slice(0, 500); // limite anti-abuso
  const user = room.users.get(meta.userId);
  if (!user) return;

  broadcast(room, 'CHAT_MESSAGE', {
    messageId: crypto.randomUUID(),
    userId: meta.userId,
    username: user.username,
    text: trimmed,
    timestamp: nowTs(),
  });
}

function handleSetHostOnlyControl(ws, payload) {
  const meta = connMeta.get(ws);
  if (!meta) return sendError(ws, 'NOT_IN_ROOM', 'No perteneces a ninguna sala.');

  const room = store.get(meta.roomId);
  if (!room) return sendError(ws, 'ROOM_NOT_FOUND', 'La sala ya no existe.');

  if (meta.userId !== room.hostUserId) {
    return sendError(ws, 'FORBIDDEN', 'Solo el host puede cambiar este ajuste.');
  }

  room.hostOnlyControl = !!(payload && payload.hostOnlyControl);
  broadcast(room, 'ROOM_SETTINGS_UPDATED', { hostOnlyControl: room.hostOnlyControl });
}

function handleLeaveRoom(ws) {
  const meta = connMeta.get(ws);
  if (!meta) return;
  removeUserFromRoom(meta.roomId, meta.userId);
  connMeta.delete(ws);
}

function removeUserFromRoom(roomId, userId) {
  const room = store.get(roomId);
  if (!room) return;

  const user = room.users.get(userId);
  room.users.delete(userId);

  if (user) {
    broadcastSystemMessage(room, `${user.username} salio de la sala.`);
    broadcast(room, 'USER_LEFT', { userId, username: user.username });
  }

  // Transferencia de host si el host se va y quedan usuarios.
  if (userId === room.hostUserId && room.users.size > 0) {
    const nextHost = room.users.values().next().value;
    room.hostUserId = nextHost.userId;
    broadcastSystemMessage(room, `${nextHost.username} es ahora el host.`);
  }

  broadcastUserList(room);

  if (room.isEmpty()) {
    room.emptySince = nowTs();
  }
}

// ---------------------------------------------------------------------------
// Conexion WebSocket
// ---------------------------------------------------------------------------

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    const msg = safeJsonParse(raw.toString());
    if (!msg || typeof msg.type !== 'string') {
      return sendError(ws, 'INVALID_MESSAGE', 'Mensaje malformado.');
    }

    switch (msg.type) {
      case 'CREATE_ROOM': return handleCreateRoom(ws, msg.payload);
      case 'JOIN_ROOM': return handleJoinRoom(ws, msg.payload);
      case 'SYNC_ACTION': return handleSyncAction(ws, msg.payload);
      case 'CHANGE_VIDEO': return handleChangeVideo(ws, msg.payload);
      case 'CHAT_MESSAGE': return handleChatMessage(ws, msg.payload);
      case 'SET_HOST_ONLY_CONTROL': return handleSetHostOnlyControl(ws, msg.payload);
      case 'LEAVE_ROOM': return handleLeaveRoom(ws);
      case 'PING': return send(ws, 'PONG', {});
      default:
        return sendError(ws, 'UNKNOWN_TYPE', `Tipo de mensaje desconocido: ${msg.type}`);
    }
  });

  ws.on('close', () => handleLeaveRoom(ws));
  ws.on('error', () => handleLeaveRoom(ws));
});

// Heartbeat: cierra sockets muertos (p.ej. tras suspender el equipo o perder red).
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      handleLeaveRoom(ws);
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_INTERVAL_MS);

// Limpieza periodica de salas vacias con TTL vencido.
const roomReaper = setInterval(() => {
  const now = nowTs();
  for (const [roomId, room] of store.rooms) {
    if (room.isEmpty() && room.emptySince && now - room.emptySince > ROOM_TTL_EMPTY_MS) {
      store.delete(roomId);
    }
  }
}, 60000);

wss.on('close', () => {
  clearInterval(heartbeat);
  clearInterval(roomReaper);
});

httpServer.listen(PORT, () => {
  console.log(`[youtube-sync-party] Servidor WebSocket escuchando en puerto ${PORT}`);
});

process.on('SIGTERM', () => {
  clearInterval(heartbeat);
  clearInterval(roomReaper);
  httpServer.close(() => process.exit(0));
});
