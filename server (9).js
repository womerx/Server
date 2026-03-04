const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use((req, res, next) => { res.header('Access-Control-Allow-Origin', '*'); next(); });
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: false
  },
  transports: ['websocket', 'polling']
});

app.get('/', (req, res) => res.send('TagiTopia Server OK'));
app.get('/health', (req, res) => res.json({ ok: true, lobbies: Object.keys(lobbies).length }));

const lobbies = {};
const playerToLobby = {};

// ── helpers ──────────────────────────────────────────────────
function lobbyPublic(l) {
  return {
    id: l.id, name: l.name,
    playerCount: Object.keys(l.players).length,
    started: l.started,
    isPrivate: !!l.isPrivate,
    mode: l.mode
  };
}
function broadcastLobbies() { io.emit('lobbiesList', Object.values(lobbies).map(lobbyPublic)); }

function makePlayer(id, name, color) {
  return {
    id,
    name: (name || 'Player').slice(0, 16),
    color: color || '#ffffff',
    x: (Math.random() - 0.5) * 18,
    y: 0.5,
    z: (Math.random() - 0.5) * 18,
    rotY: 0,
    isTagged: false,
    eliminated: false
  };
}

// ── hot-potato timer ─────────────────────────────────────────
function clearHPTimer(lobby) {
  if (lobby.hpTimer) { clearInterval(lobby.hpTimer); lobby.hpTimer = null; }
}

function startHPTimer(lobbyId) {
  const lobby = lobbies[lobbyId];
  if (!lobby || lobby.mode !== 'hotpotato') return;
  clearHPTimer(lobby);
  lobby.hpTimeLeft = 15;
  io.to(lobbyId).emit('hpTick', { timeLeft: lobby.hpTimeLeft });

  lobby.hpTimer = setInterval(() => {
    const l = lobbies[lobbyId];
    if (!l || !l.started) { clearInterval(l && l.hpTimer); return; }

    l.hpTimeLeft--;
    io.to(lobbyId).emit('hpTick', { timeLeft: l.hpTimeLeft });

    if (l.hpTimeLeft > 0) return;

    // ── tagger failed → eliminate them ──
    clearHPTimer(l);
    const elimId = l.taggerId;
    const elimPlayer = l.players[elimId];
    if (!elimPlayer) return;

    elimPlayer.eliminated = true;
    elimPlayer.isTagged = false;

    const survivors = Object.values(l.players).filter(p => !p.eliminated);
    io.to(lobbyId).emit('playerEliminated', {
      eliminatedId: elimId,
      eliminatedName: elimPlayer.name,
      survivors: survivors.map(p => p.id)
    });

    if (survivors.length <= 1) {
      const winner = survivors[0];
      io.to(lobbyId).emit('gameOver', {
        winnerId: winner ? winner.id : null,
        winnerName: winner ? winner.name : 'Nobody',
        reason: 'Last one standing!'
      });
      l.started = false;
      l.taggerId = null;
      return;
    }

    // pass tag to random survivor
    const next = survivors[Math.floor(Math.random() * survivors.length)];
    l.taggerId = next.id;
    next.isTagged = true;

    io.to(lobbyId).emit('tagged', {
      newTaggerId: next.id,
      oldTaggerId: elimId,
      players: l.players
    });

    startHPTimer(lobbyId); // restart 15s for new tagger
  }, 1000);
}

// ── start game when conditions met ───────────────────────────
function tryStartGame(lobbyId) {
  const l = lobbies[lobbyId];
  if (!l || l.started) return;

  if (l.mode === 'freeplay') {
    // Freeplay: start immediately for everyone, no tagger ever
    l.started = true;
    io.to(lobbyId).emit('gameStart', {
      mode: 'freeplay',
      taggerId: null,
      players: l.players
    });
    return;
  }

  // tag / hotpotato need ≥2 players
  const active = Object.values(l.players).filter(p => !p.eliminated);
  if (active.length < 2) return;

  l.started = true;

  // pick random tagger
  const tagger = active[Math.floor(Math.random() * active.length)];
  l.taggerId = tagger.id;
  Object.values(l.players).forEach(p => { p.isTagged = (p.id === l.taggerId); });

  io.to(lobbyId).emit('gameStart', {
    mode: l.mode,
    taggerId: l.taggerId,
    players: l.players
  });

  if (l.mode === 'hotpotato') startHPTimer(lobbyId);
}

// ── socket handlers ──────────────────────────────────────────
io.on('connection', socket => {
  console.log('+', socket.id);

  socket.on('getLobbies', () =>
    socket.emit('lobbiesList', Object.values(lobbies).map(lobbyPublic))
  );

  // CREATE
  socket.on('createLobby', ({ lobbyName, playerName, playerColor, password, isPrivate, mode }) => {
    const validMode = ['tag','hotpotato','freeplay'].includes(mode) ? mode : 'tag';
    const id = uuidv4().slice(0, 6).toUpperCase();

    lobbies[id] = {
      id, name: (lobbyName || 'Lobby').slice(0, 24),
      mode: validMode,
      players: {},
      started: false,
      taggerId: null,
      isPrivate: !!isPrivate,
      password: password || null,
      hpTimeLeft: 15,
      hpTimer: null
    };

    const player = makePlayer(socket.id, playerName, playerColor);
    lobbies[id].players[socket.id] = player;
    playerToLobby[socket.id] = id;
    socket.join(id);

    socket.emit('joinedLobby', {
      lobbyId: id,
      player,
      mode: validMode,
      players: lobbies[id].players
    });

    broadcastLobbies();

    // freeplay starts solo; others wait for 2nd player
    if (validMode === 'freeplay') tryStartGame(id);
  });

  // JOIN
  socket.on('joinLobby', ({ lobbyId, playerName, playerColor, password }) => {
    const l = lobbies[lobbyId];
    if (!l) return socket.emit('error', 'Lobby not found');
    // freeplay lobbies are always joinable; tag/hotpotato block after start
    if (l.started && l.mode !== 'freeplay') return socket.emit('error', 'Game already started');
    if (l.isPrivate && l.password && l.password !== password) return socket.emit('error', 'Wrong password!');
    // don't double-add same socket
    if (l.players[socket.id]) return;

    const player = makePlayer(socket.id, playerName, playerColor);
    l.players[socket.id] = player;
    playerToLobby[socket.id] = lobbyId;
    socket.join(lobbyId);

    socket.emit('joinedLobby', {
      lobbyId,
      player,
      mode: l.mode,
      players: l.players
    });

    socket.to(lobbyId).emit('playerJoined', player);
    broadcastLobbies();
    tryStartGame(lobbyId);
  });

  // MOVE – relay to others, don't bounce back
  socket.on('playerMove', ({ x, y, z, rotY }) => {
    const lobbyId = playerToLobby[socket.id];
    if (!lobbyId || !lobbies[lobbyId]) return;
    const p = lobbies[lobbyId].players[socket.id];
    if (!p) return;
    p.x = x; p.y = y; p.z = z; p.rotY = rotY;
    socket.to(lobbyId).emit('playerMoved', { id: socket.id, x, y, z, rotY });
  });

  // TAG – only valid in tag/hotpotato modes
  socket.on('tagPlayer', ({ targetId }) => {
    const lobbyId = playerToLobby[socket.id];
    if (!lobbyId) return;
    const l = lobbies[lobbyId];
    if (!l || !l.started) return;
    if (l.mode === 'freeplay') return;           // ← freeplay: tag does nothing
    if (l.taggerId !== socket.id) return;        // must actually be IT

    const tagger = l.players[socket.id];
    const target = l.players[targetId];
    if (!tagger || !target || target.eliminated) return;

    // server-side distance check
    const dx = target.x - tagger.x, dz = target.z - tagger.z;
    if (Math.sqrt(dx * dx + dz * dz) > 4.5) return;

    // transfer tag
    tagger.isTagged = false;
    target.isTagged = true;
    l.taggerId = targetId;

    io.to(lobbyId).emit('tagged', {
      newTaggerId: targetId,
      oldTaggerId: socket.id,
      players: l.players
    });

    if (l.mode === 'hotpotato') {
      clearHPTimer(l);
      startHPTimer(lobbyId);
    }
  });

  // CHAT
  socket.on('chatMessage', ({ lobbyId, text }) => {
    const l = lobbies[lobbyId];
    if (!l) return;
    const p = l.players[socket.id];
    if (!p) return;
    const clean = String(text || '').slice(0, 120).trim();
    if (!clean) return;
    io.to(lobbyId).emit('chatMessage', {
      name: p.name, color: p.color, text: clean, time: Date.now()
    });
  });

  socket.on('leaveLobby', () => handleLeave(socket));
  socket.on('disconnect', () => { handleLeave(socket); console.log('-', socket.id); });
});

function handleLeave(socket) {
  const lobbyId = playerToLobby[socket.id];
  if (!lobbyId) return;
  const l = lobbies[lobbyId];
  if (!l) return;

  const leaving = l.players[socket.id];
  if (!leaving) return;

  delete l.players[socket.id];
  delete playerToLobby[socket.id];
  socket.leave(lobbyId);
  io.to(lobbyId).emit('playerLeft', { id: socket.id });

  const alive = Object.values(l.players).filter(p => !p.eliminated);

  // if the tagger left during a competitive game, pass tag to someone
  if (l.started && l.mode !== 'freeplay' && l.taggerId === socket.id) {
    if (alive.length > 0) {
      const next = alive[Math.floor(Math.random() * alive.length)];
      l.taggerId = next.id;
      next.isTagged = true;
      io.to(lobbyId).emit('tagged', {
        newTaggerId: next.id, oldTaggerId: socket.id, players: l.players
      });
      if (l.mode === 'hotpotato') { clearHPTimer(l); startHPTimer(lobbyId); }
    }
  }

  // hotpotato: check if only 1 survivor left
  if (l.started && l.mode === 'hotpotato' && alive.length <= 1) {
    clearHPTimer(l);
    if (alive.length === 1) {
      io.to(lobbyId).emit('gameOver', {
        winnerId: alive[0].id, winnerName: alive[0].name, reason: 'Last one standing!'
      });
    }
    l.started = false;
    l.taggerId = null;
  }

  // lobby empty → delete
  if (Object.keys(l.players).length === 0) {
    clearHPTimer(l);
    delete lobbies[lobbyId];
  } else if (!l.started && l.mode !== 'freeplay' && alive.length < 2) {
    io.to(lobbyId).emit('waitingForPlayers');
  }

  broadcastLobbies();
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`TagiTopia server :${PORT}`));
