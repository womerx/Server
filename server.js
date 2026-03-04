const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });

app.get('/', (req, res) => res.send('TAG GAME SERVER OK'));
app.get('/health', (req, res) => res.json({ status: 'ok', lobbies: Object.keys(lobbies).length }));

const lobbies = {};
const playerToLobby = {};

function getLobbiesPublic() {
  return Object.values(lobbies).map(l => ({
    id: l.id, name: l.name,
    playerCount: Object.keys(l.players).length,
    started: l.started,
    isPrivate: !!l.isPrivate,
    mode: l.mode || 'tag'
  }));
}

function startGameIfReady(lobbyId) {
  const lobby = lobbies[lobbyId];
  if (!lobby || lobby.started) return;
  const players = Object.values(lobby.players).filter(p => !p.eliminated);
  if (players.length < 2) return;

  lobby.started = true;

  if (lobby.mode === 'freeplay') {
    // Freeplay – no tagger, just notify
    io.to(lobbyId).emit('gameStart', { taggerId: null, players: lobby.players, mode: 'freeplay' });
    return;
  }

  // Pick random tagger
  const tagger = players[Math.floor(Math.random() * players.length)];
  lobby.taggerId = tagger.id;
  Object.values(lobby.players).forEach(p => { p.isTagged = (p.id === lobby.taggerId); p.isIt = p.isTagged; });

  io.to(lobbyId).emit('gameStart', { taggerId: lobby.taggerId, players: lobby.players, mode: lobby.mode });

  if (lobby.mode === 'hotpotato') startHPTimer(lobbyId);
}

// ── Hot Potato Timer ──
function startHPTimer(lobbyId) {
  const lobby = lobbies[lobbyId];
  if (!lobby) return;
  clearHPTimer(lobby);
  lobby.hpTimeLeft = 15;

  lobby.hpTickInterval = setInterval(() => {
    const l = lobbies[lobbyId];
    if (!l || !l.started) { clearHPTimer(l); return; }
    l.hpTimeLeft--;
    io.to(lobbyId).emit('hpTick', { timeLeft: l.hpTimeLeft });

    if (l.hpTimeLeft <= 0) {
      // Eliminate current tagger
      clearHPTimer(l);
      const eliminatedId = l.taggerId;
      const eliminated = l.players[eliminatedId];
      if (!eliminated) return;
      eliminated.eliminated = true;
      eliminated.isTagged = false;
      eliminated.isIt = false;

      const survivors = Object.values(l.players).filter(p => !p.eliminated);
      io.to(lobbyId).emit('playerEliminated', {
        eliminatedId,
        eliminatedName: eliminated.name,
        survivors: survivors.map(p => p.id)
      });

      if (survivors.length <= 1) {
        // Game over
        const winner = survivors[0];
        io.to(lobbyId).emit('gameOver', {
          winnerId: winner?.id || null,
          winnerName: winner?.name || 'Nobody',
          reason: 'Last player standing!'
        });
        l.started = false;
        l.taggerId = null;
        return;
      }

      // Pass tag to a random survivor
      const next = survivors[Math.floor(Math.random() * survivors.length)];
      l.taggerId = next.id;
      next.isTagged = true; next.isIt = true;
      l.hpTimeLeft = 15;

      io.to(lobbyId).emit('tagged', {
        newTaggerId: next.id,
        oldTaggerId: eliminatedId,
        players: l.players
      });

      // Restart timer
      startHPTimer(lobbyId);
    }
  }, 1000);
}

function clearHPTimer(lobby) {
  if (lobby && lobby.hpTickInterval) {
    clearInterval(lobby.hpTickInterval);
    lobby.hpTickInterval = null;
  }
}

io.on('connection', (socket) => {
  console.log('+ connect', socket.id);

  socket.on('getLobbies', () => socket.emit('lobbiesList', getLobbiesPublic()));

  socket.on('createLobby', ({ lobbyName, playerName, playerColor, password, isPrivate, mode }) => {
    const id = uuidv4().slice(0, 6).toUpperCase();
    lobbies[id] = {
      id, name: lobbyName || 'Lobby',
      players: {}, started: false, taggerId: null,
      isPrivate: !!isPrivate, password: password || null,
      mode: mode || 'tag',
      hpTimeLeft: 15, hpTickInterval: null
    };
    const player = makePlayer(socket.id, playerName, playerColor);
    lobbies[id].players[socket.id] = player;
    playerToLobby[socket.id] = id;
    socket.join(id);
    socket.emit('joinedLobby', { lobbyId: id, player, lobby: lobbies[id] });
    io.emit('lobbiesList', getLobbiesPublic());
  });

  socket.on('joinLobby', ({ lobbyId, playerName, playerColor, password }) => {
    const lobby = lobbies[lobbyId];
    if (!lobby) { socket.emit('error', 'Lobby not found'); return; }
    if (lobby.started) { socket.emit('error', 'Game already started'); return; }
    if (lobby.isPrivate && lobby.password && lobby.password !== password) { socket.emit('error', 'Wrong password!'); return; }

    const player = makePlayer(socket.id, playerName, playerColor);
    lobby.players[socket.id] = player;
    playerToLobby[socket.id] = lobbyId;
    socket.join(lobbyId);
    socket.emit('joinedLobby', { lobbyId, player, lobby });
    socket.to(lobbyId).emit('playerJoined', player);
    io.emit('lobbiesList', getLobbiesPublic());
    startGameIfReady(lobbyId);
  });

  socket.on('playerMove', ({ x, y, z, rotY }) => {
    const lobbyId = playerToLobby[socket.id];
    if (!lobbyId || !lobbies[lobbyId]) return;
    const player = lobbies[lobbyId].players[socket.id];
    if (!player) return;
    player.x = x; player.y = y; player.z = z; player.rotY = rotY;
    // Broadcast to others only (not back to sender)
    socket.to(lobbyId).emit('playerMoved', { id: socket.id, x, y, z, rotY });
  });

  socket.on('tagPlayer', ({ targetId }) => {
    const lobbyId = playerToLobby[socket.id];
    if (!lobbyId || !lobbies[lobbyId]) return;
    const lobby = lobbies[lobbyId];
    if (!lobby.started || lobby.mode === 'freeplay') return;
    if (lobby.taggerId !== socket.id) return;

    const target = lobby.players[targetId];
    const tagger = lobby.players[socket.id];
    if (!target || !tagger || target.eliminated) return;

    // Distance check
    const dx = target.x - tagger.x, dz = target.z - tagger.z;
    if (Math.sqrt(dx*dx + dz*dz) > 4.5) return;

    // Transfer tag
    tagger.isTagged = false; tagger.isIt = false;
    target.isTagged = true; target.isIt = true;
    lobby.taggerId = targetId;

    io.to(lobbyId).emit('tagged', { newTaggerId: targetId, oldTaggerId: socket.id, players: lobby.players });

    if (lobby.mode === 'hotpotato') {
      clearHPTimer(lobby);
      startHPTimer(lobbyId);
    }
  });

  socket.on('chatMessage', ({ lobbyId, text }) => {
    const lobby = lobbies[lobbyId];
    if (!lobby) return;
    const player = lobby.players[socket.id];
    if (!player) return;
    const clean = String(text).slice(0, 120).trim();
    if (!clean) return;
    io.to(lobbyId).emit('chatMessage', { name: player.name, color: player.color, text: clean, time: Date.now() });
  });

  socket.on('leaveLobby', () => handleLeave(socket));
  socket.on('disconnect', () => { handleLeave(socket); console.log('- disconnect', socket.id); });
});

function makePlayer(id, name, color) {
  return {
    id, name: name || 'Player',
    color: color || '#ffffff',
    x: (Math.random() - 0.5) * 20,
    y: 0.5, z: (Math.random() - 0.5) * 20,
    rotY: 0, isTagged: false, isIt: false, eliminated: false
  };
}

function handleLeave(socket) {
  const lobbyId = playerToLobby[socket.id];
  if (!lobbyId || !lobbies[lobbyId]) return;
  const lobby = lobbies[lobbyId];
  const player = lobby.players[socket.id];
  if (!player) return;

  delete lobby.players[socket.id];
  delete playerToLobby[socket.id];
  socket.leave(lobbyId);
  io.to(lobbyId).emit('playerLeft', { id: socket.id });

  const remaining = Object.values(lobby.players).filter(p => !p.eliminated);

  // If tagger left in an active game
  if (lobby.started && lobby.taggerId === socket.id && lobby.mode !== 'freeplay') {
    if (remaining.length > 0) {
      const next = remaining[Math.floor(Math.random() * remaining.length)];
      lobby.taggerId = next.id; next.isTagged = true; next.isIt = true;
      io.to(lobbyId).emit('tagged', { newTaggerId: next.id, oldTaggerId: socket.id, players: lobby.players });
      if (lobby.mode === 'hotpotato') { clearHPTimer(lobby); startHPTimer(lobbyId); }
    }
  }

  if (remaining.length <= 1 && lobby.started && lobby.mode === 'hotpotato') {
    clearHPTimer(lobby);
    if (remaining.length === 1) {
      io.to(lobbyId).emit('gameOver', { winnerId: remaining[0].id, winnerName: remaining[0].name, reason: 'Last player standing!' });
    }
    lobby.started = false;
  }

  if (Object.keys(lobby.players).length === 0) {
    clearHPTimer(lobby);
    delete lobbies[lobbyId];
  } else if (!lobby.started && Object.keys(lobby.players).length < 2) {
    io.to(lobbyId).emit('waitingForPlayers');
  }

  io.emit('lobbiesList', getLobbiesPublic());
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Tag Server on :${PORT}`));
