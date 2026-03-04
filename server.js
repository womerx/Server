const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.get('/', (req, res) => res.send('TAG GAME SERVER RUNNING'));
app.get('/health', (req, res) => res.json({ status: 'ok', lobbies: Object.keys(lobbies).length }));

const lobbies = {};
const playerToLobby = {};

function createLobby(name, hostName, hostColor) {
  const id = uuidv4().slice(0, 6).toUpperCase();
  lobbies[id] = {
    id,
    name,
    players: {},
    started: false,
    taggerId: null,
    tagHistory: []
  };
  return id;
}

function getLobbiesPublic() {
  return Object.values(lobbies).map(l => ({
    id: l.id,
    name: l.name,
    playerCount: Object.keys(l.players).length,
    started: l.started,
    isPrivate: !!l.isPrivate
  }));
}

function startGameIfReady(lobbyId) {
  const lobby = lobbies[lobbyId];
  if (!lobby || lobby.started) return;
  const players = Object.values(lobby.players);
  if (players.length >= 2) {
    lobby.started = true;
    // Pick random tagger
    const randomTagger = players[Math.floor(Math.random() * players.length)];
    lobby.taggerId = randomTagger.id;
    // Set tagger status
    Object.values(lobby.players).forEach(p => {
      p.isTagged = (p.id === lobby.taggerId);
    });
    io.to(lobbyId).emit('gameStart', {
      taggerId: lobby.taggerId,
      players: lobby.players
    });
    console.log(`Game started in lobby ${lobbyId}, tagger: ${randomTagger.name}`);
  }
}

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('getLobbies', () => {
    socket.emit('lobbiesList', getLobbiesPublic());
  });

  socket.on('createLobby', ({ lobbyName, playerName, playerColor, password, isPrivate }) => {
    const lobbyId = createLobby(lobbyName, playerName, playerColor);
    if (isPrivate && password) {
      lobbies[lobbyId].isPrivate = true;
      lobbies[lobbyId].password = password;
    }
    const player = {
      id: socket.id,
      name: playerName,
      color: playerColor,
      x: (Math.random() - 0.5) * 20,
      y: 0.5,
      z: (Math.random() - 0.5) * 20,
      rotY: 0,
      isTagged: false,
      isIt: false
    };
    lobbies[lobbyId].players[socket.id] = player;
    playerToLobby[socket.id] = lobbyId;
    socket.join(lobbyId);
    socket.emit('joinedLobby', { lobbyId, player, lobby: lobbies[lobbyId] });
    io.emit('lobbiesList', getLobbiesPublic());
  });

  socket.on('joinLobby', ({ lobbyId, playerName, playerColor, password }) => {
    const lobby = lobbies[lobbyId];
    if (!lobby) { socket.emit('error', 'Lobby not found'); return; }
    if (lobby.started) { socket.emit('error', 'Game already started'); return; }
    if (lobby.isPrivate && lobby.password && lobby.password !== password) {
      socket.emit('error', 'Wrong password!'); return;
    }
    const player = {
      id: socket.id,
      name: playerName,
      color: playerColor,
      x: (Math.random() - 0.5) * 20,
      y: 0.5,
      z: (Math.random() - 0.5) * 20,
      rotY: 0,
      isTagged: false,
      isIt: false
    };
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
    socket.to(lobbyId).emit('playerMoved', { id: socket.id, x, y, z, rotY });
  });

  socket.on('tagPlayer', ({ targetId }) => {
    const lobbyId = playerToLobby[socket.id];
    if (!lobbyId || !lobbies[lobbyId]) return;
    const lobby = lobbies[lobbyId];
    if (!lobby.started) return;
    // Only tagger can tag
    if (lobby.taggerId !== socket.id) return;
    const target = lobby.players[targetId];
    const tagger = lobby.players[socket.id];
    if (!target || !tagger) return;

    // Distance check (server-side)
    const dx = target.x - tagger.x;
    const dz = target.z - tagger.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist > 4) return; // too far

    // Transfer tag
    tagger.isTagged = false;
    tagger.isIt = false;
    target.isTagged = true;
    target.isIt = true;
    lobby.taggerId = targetId;
    lobby.tagHistory.push({ from: socket.id, to: targetId, time: Date.now() });

    io.to(lobbyId).emit('tagged', {
      newTaggerId: targetId,
      oldTaggerId: socket.id,
      players: lobby.players
    });
    console.log(`Tag! ${tagger.name} tagged ${target.name}`);
  });

  socket.on('leaveLobby', () => {
    handleLeave(socket);
  });

  socket.on('disconnect', () => {
    handleLeave(socket);
    console.log('Client disconnected:', socket.id);
  });
});

function handleLeave(socket) {
  const lobbyId = playerToLobby[socket.id];
  if (!lobbyId || !lobbies[lobbyId]) return;
  const lobby = lobbies[lobbyId];
  const player = lobby.players[socket.id];
  if (player) {
    delete lobby.players[socket.id];
    delete playerToLobby[socket.id];
    socket.leave(lobbyId);
    io.to(lobbyId).emit('playerLeft', { id: socket.id });

    // If game started and tagger left, pick new tagger
    if (lobby.started && lobby.taggerId === socket.id) {
      const remaining = Object.keys(lobby.players);
      if (remaining.length > 0) {
        const newTagger = remaining[0];
        lobby.taggerId = newTagger;
        lobby.players[newTagger].isTagged = true;
        io.to(lobbyId).emit('tagged', {
          newTaggerId: newTagger,
          oldTaggerId: socket.id,
          players: lobby.players
        });
      }
    }

    // If lobby empty, delete it
    if (Object.keys(lobby.players).length === 0) {
      delete lobbies[lobbyId];
    }

    // If game not started and only 1 player, reset
    if (!lobby.started && Object.keys(lobby.players).length < 2) {
      io.to(lobbyId).emit('waitingForPlayers');
    }

    io.emit('lobbiesList', getLobbiesPublic());
  }
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Tag Game Server running on port ${PORT}`));
