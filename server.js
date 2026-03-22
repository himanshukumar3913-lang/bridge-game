/**
 * Bridge Card Game – Server
 * RULE ORDER: Deal 1 (6 cards) → Bidding → Trump → Deal 2 (4 cards) → Ask → Play
 */

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  // Allow both polling AND websocket – client upgrades to websocket automatically.
  // This is the most compatible setup for Render.com.
  transports: ['polling', 'websocket'],
  allowUpgrades: true,
  pingTimeout: 60000,
  pingInterval: 25000,
  // Render sometimes needs a longer connect timeout
  connectTimeout: 45000,
});

app.use(express.static(path.join(__dirname, 'public')));

// Health-check endpoint so Render knows the server is alive
app.get('/health', (req, res) => res.send('OK'));

// ══════════════════════════════════════════════════════
//  CARD SYSTEM
// ══════════════════════════════════════════════════════

const SUITS     = ['spades', 'hearts', 'diamonds', 'clubs'];
const RANKS     = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const SUIT_SYMS = { spades:'♠', hearts:'♥', diamonds:'♦', clubs:'♣' };

function createDeck() {
  const deck = [];
  for (const suit of SUITS)
    for (const rank of RANKS) {
      if (rank === '2' && (suit === 'clubs' || suit === 'diamonds')) continue;
      deck.push({ rank, suit, id: `${rank}-${suit}` });
    }
  return deck;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function rankIndex(rank) { return RANKS.indexOf(rank); }

function cardPoints(card) {
  if (card.rank === 'A') return 20;
  if (['K','Q','J','10'].includes(card.rank)) return 10;
  if (card.rank === '5') return 5;
  if (card.rank === '3' && card.suit === 'spades') return 30;
  return 0;
}

function beats(challenger, current, leadSuit, trump) {
  const cT = challenger.suit === trump;
  const wT = current.suit   === trump;
  if ( cT && !wT) return true;
  if (!cT &&  wT) return false;
  if ( cT &&  wT) return rankIndex(challenger.rank) > rankIndex(current.rank);
  const cL = challenger.suit === leadSuit;
  const wL = current.suit    === leadSuit;
  if ( wL && !cL) return false;
  if (!wL &&  cL) return true;
  if (!wL && !cL) return false;
  return rankIndex(challenger.rank) > rankIndex(current.rank);
}

function sortCards(cards) {
  return [...cards].sort((a, b) => {
    const sd = SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit);
    return sd !== 0 ? sd : rankIndex(b.rank) - rankIndex(a.rank);
  });
}

// ══════════════════════════════════════════════════════
//  GAME CLASS
// ══════════════════════════════════════════════════════

class Game {
  constructor(roomId) {
    this.roomId  = roomId;
    this.players = [];
    this.phase   = 'waiting';
    this.dealer  = 0;
    this.deck    = [];

    this.currentBidder  = 0;
    this.highestBid     = 155;
    this.highestBidder  = -1;
    this.passed         = new Set();
    this.bidLog         = [];

    this.trump      = null;
    this.askedCards = [];
    this.teammates  = [];
    this.reveal     = {};

    this.round           = 0;
    this.turnPlayer      = 0;
    this.trick           = [];
    this.leadSuit        = null;
    this.trickPts        = {};
    this.lastTrickWinner = -1;

    this.roundScores  = {};
    this.totalScores  = {};
    this.lastGameover = null;
  }

  addPlayer(socketId, name) {
    if (this.players.length >= 5) return -1;
    const idx = this.players.length;
    this.players.push({ socketId, name, cards: [], disconnected: false, lastSeen: Date.now() });
    this.trickPts[idx]    = 0;
    this.roundScores[idx] = 0;
    this.totalScores[idx] = this.totalScores[idx] || 0;
    this.reveal[idx]      = 0;
    return idx;
  }

  reconnectPlayer(socketId, name, playerIndex) {
    // First try the stored index (fast path)
    let idx = -1;
    if (playerIndex >= 0 && playerIndex < this.players.length) {
      if (this.players[playerIndex].name === name) idx = playerIndex;
    }
    // Fallback: search by name in case index shifted (e.g. after a removal)
    if (idx === -1) {
      idx = this.players.findIndex(p => p.name === name);
    }
    if (idx === -1) return -1;

    const p        = this.players[idx];
    p.socketId     = socketId;
    p.disconnected = false;
    p.lastSeen     = Date.now();
    return idx;
  }

  markDisconnected(playerIndex) {
    const p = this.players[playerIndex];
    if (p) { p.disconnected = true; p.lastSeen = Date.now(); p.socketId = null; }
  }

  /**
   * Permanently remove a player from the lobby (waiting phase only).
   * Returns the removed player's socketId so the server can notify them,
   * or null if removal is not allowed.
   * All players after the removed index shift down by 1.
   */
  removePlayer(targetIdx) {
    if (this.phase !== 'waiting') return null; // lobby only
    if (targetIdx === 0)          return null; // host cannot be removed
    if (targetIdx < 0 || targetIdx >= this.players.length) return null;

    const removed = this.players[targetIdx];
    this.players.splice(targetIdx, 1);

    // Shift score/reveal maps down for players after the removed slot
    for (let i = targetIdx; i < this.players.length; i++) {
      this.trickPts[i]    = this.trickPts[i + 1]   || 0;
      this.roundScores[i] = this.roundScores[i + 1] || 0;
      this.totalScores[i] = this.totalScores[i + 1] || 0;
      this.reveal[i]      = this.reveal[i + 1]      || 0;
    }
    const last = this.players.length;
    delete this.trickPts[last];
    delete this.roundScores[last];
    delete this.totalScores[last];
    delete this.reveal[last];

    return removed.socketId; // caller notifies this socket
  }

  startRound() {
    this.deck          = shuffle(createDeck());
    this.phase         = 'bidding';
    this.passed        = new Set();
    this.bidLog        = [];
    this.highestBid    = 155;
    this.highestBidder = -1;
    this.trump         = null;
    this.askedCards    = [];
    this.teammates     = [];
    this.round         = 0;
    this.trick         = [];
    this.leadSuit      = null;
    this.lastTrickWinner = -1;
    this.lastGameover    = null;

    for (let i = 0; i < 5; i++) {
      this.players[i].cards = [];
      this.trickPts[i]      = 0;
      this.roundScores[i]   = 0;
      this.reveal[i]        = 0;
    }

    for (let c = 0; c < 6; c++)
      for (let p = 0; p < 5; p++)
        this.players[(this.dealer + 1 + p) % 5].cards.push(this.deck.pop());

    for (let i = 0; i < 5; i++)
      this.players[i].cards = sortCards(this.players[i].cards);

    this.currentBidder = (this.dealer + 4) % 5;
  }

  placeBid(playerIdx, amount) {
    if (this.phase !== 'bidding')         return 'Not the bidding phase';
    if (playerIdx !== this.currentBidder) return 'Not your turn to bid';
    if (this.passed.has(playerIdx))       return 'You have already passed';

    if (amount === 'pass') {
      this.passed.add(playerIdx);
      this.bidLog.push({ p: playerIdx, a: 'pass' });
    } else {
      const n = Number(amount);
      if (!Number.isInteger(n) || n < 160 || n > 290 || n % 5 !== 0)
        return 'Bid must be a multiple of 5 between 160 and 290';
      if (n <= this.highestBid)
        return `Must bid more than current highest (${this.highestBid})`;
      this.highestBid    = n;
      this.highestBidder = playerIdx;
      this.bidLog.push({ p: playerIdx, a: n });
    }

    if (this.passed.size === 4) {
      if (this.highestBidder === -1) {
        for (let i = 0; i < 5; i++) {
          if (!this.passed.has(i)) { this.highestBidder = i; this.highestBid = 160; break; }
        }
      }
      this.phase = 'trump';
      return null;
    }

    let next = (this.currentBidder + 4) % 5;
    let guard = 0;
    while (this.passed.has(next) && guard++ < 5) next = (next + 4) % 5;
    this.currentBidder = next;
    return null;
  }

  setTrump(playerIdx, suit) {
    if (this.phase !== 'trump')           return 'Not the trump selection phase';
    if (playerIdx !== this.highestBidder) return 'Only the highest bidder chooses trump';
    if (!SUITS.includes(suit))            return 'Invalid suit';

    this.trump = suit;

    for (let c = 0; c < 4; c++)
      for (let p = 0; p < 5; p++)
        this.players[(this.dealer + 1 + p) % 5].cards.push(this.deck.pop());

    for (let i = 0; i < 5; i++)
      this.players[i].cards = sortCards(this.players[i].cards);

    this.phase = 'ask';
    return null;
  }

  askForCards(playerIdx, cardIds) {
    if (this.phase !== 'ask')                            return 'Not the ask phase';
    if (playerIdx !== this.highestBidder)                return 'Only the highest bidder asks';
    if (!Array.isArray(cardIds) || cardIds.length !== 2) return 'Ask for exactly 2 cards';
    if (cardIds[0] === cardIds[1])                       return 'The 2 cards must be different';

    const myCardIds = this.players[playerIdx].cards.map(c => c.id);
    for (const cid of cardIds)
      if (myCardIds.includes(cid))
        return 'You already hold that card – ask for cards not in your hand';

    const deckMap = {};
    createDeck().forEach(c => { deckMap[c.id] = c; });
    const resolved = cardIds.map(id => deckMap[id]).filter(Boolean);
    if (resolved.length !== 2) return 'One or more card IDs are invalid';

    this.askedCards = resolved;
    this.teammates  = [];
    for (let i = 0; i < 5; i++) {
      if (i === playerIdx) continue;
      if (this.players[i].cards.some(c => cardIds.includes(c.id)) && !this.teammates.includes(i))
        this.teammates.push(i);
    }

    this.phase      = 'playing';
    this.turnPlayer = (this.dealer + 4) % 5;
    return null;
  }

  playCard(playerIdx, cardId) {
    if (this.phase !== 'playing')      return 'Game is not in the playing phase';
    if (playerIdx !== this.turnPlayer) return 'It is not your turn';

    const player  = this.players[playerIdx];
    const cardIdx = player.cards.findIndex(c => c.id === cardId);
    if (cardIdx === -1)                return 'You do not have that card';

    const card = player.cards[cardIdx];

    if (this.trick.length > 0 && this.leadSuit) {
      const hasLead = player.cards.some(c => c.suit === this.leadSuit);
      if (hasLead && card.suit !== this.leadSuit)
        return `You must play a ${this.leadSuit} card (you have one)`;
    }

    player.cards.splice(cardIdx, 1);
    this.trick.push({ playerIndex: playerIdx, card });
    if (this.trick.length === 1) this.leadSuit = card.suit;

    if (this.askedCards.some(ac => ac.id === cardId)) {
      if      (this.reveal[playerIdx] === 0) this.reveal[playerIdx] = 1;
      else if (this.reveal[playerIdx] === 1) this.reveal[playerIdx] = 2;
    }

    if (this.trick.length < 5) {
      this.turnPlayer = (this.turnPlayer + 4) % 5;
      return { cardPlayed: true };
    }

    return this.resolveTrick();
  }

  resolveTrick() {
    let winner = this.trick[0];
    for (let i = 1; i < this.trick.length; i++)
      if (beats(this.trick[i].card, winner.card, this.leadSuit, this.trump))
        winner = this.trick[i];

    let pts = 0;
    for (const play of this.trick) pts += cardPoints(play.card);
    this.trickPts[winner.playerIndex] += pts;
    this.lastTrickWinner = winner.playerIndex;
    this.round++;

    const result = {
      trickDone:   true,
      winnerIndex: winner.playerIndex,
      winnerName:  this.players[winner.playerIndex].name,
      ptsWon:      pts,
      trickPts:    { ...this.trickPts },
      trick:       [...this.trick],
    };

    this.trick    = [];
    this.leadSuit = null;

    if (this.round === 10) return { ...result, ...this.calculateFinalScores() };

    this.turnPlayer = winner.playerIndex;
    return result;
  }

  calculateFinalScores() {
    const bidder  = this.highestBidder;
    const bid     = this.highestBid;

    let teamPts = this.trickPts[bidder] || 0;
    for (const tm of this.teammates) teamPts += this.trickPts[tm] || 0;

    const won    = teamPts >= bid;
    const scores = {};
    for (let i = 0; i < 5; i++) scores[i] = 0;

    scores[bidder] = won ? bid : -bid;

    if (this.teammates.length === 2) {
      const share = Math.ceil(bid / 3 / 5) * 5;
      for (const tm of this.teammates) scores[tm] = won ? share : -share;
    } else if (this.teammates.length === 1) {
      const share = Math.ceil((2 * bid / 3) / 5) * 5;
      scores[this.teammates[0]] = won ? share : -share;
    }

    for (let i = 0; i < 5; i++) {
      this.roundScores[i] = scores[i];
      this.totalScores[i] = (this.totalScores[i] || 0) + scores[i];
    }

    this.phase = 'scoring';

    const gameoverData = {
      gameOver:    true,
      bid, bidder,
      bidderName:  this.players[bidder].name,
      teamPts, won,
      teammates:   this.teammates,
      roundScores: { ...this.roundScores },
      totalScores: { ...this.totalScores },
      trickPts:    { ...this.trickPts },
    };

    this.lastGameover = gameoverData;
    return gameoverData;
  }

  stateFor(playerIdx) {
    return {
      phase:    this.phase,
      myIndex:  playerIdx,
      myCards:  this.players[playerIdx]?.cards || [],

      players: this.players.map((p, i) => ({
        name:         p.name,
        cardCount:    p.cards.length,
        isDealer:     i === this.dealer,
        trickPts:     this.trickPts[i]    || 0,
        roundScore:   this.roundScores[i] || 0,
        totalScore:   this.totalScores[i] || 0,
        reveal:       this.reveal[i]      || 0,
        disconnected: p.disconnected      || false,
      })),

      dealer:          this.dealer,
      currentBidder:   this.currentBidder,
      highestBid:      this.highestBid,
      highestBidder:   this.highestBidder,
      passed:          [...this.passed],
      bidLog:          this.bidLog,
      trump:           this.trump,
      askedCardIds:    this.askedCards.map(c => c.id),
      turnPlayer:      this.turnPlayer,
      trick:           this.trick,
      round:           this.round,
      leadSuit:        this.leadSuit,
      lastTrickWinner: this.lastTrickWinner,
    };
  }
}

// ══════════════════════════════════════════════════════
//  SOCKET.IO
// ══════════════════════════════════════════════════════

const games = {};

function broadcastState(roomId) {
  const game    = games[roomId];
  if (!game) return;
  const sockets = io.sockets.adapter.rooms.get(roomId);
  if (!sockets) return;
  for (const sid of sockets) {
    const s = io.sockets.sockets.get(sid);
    if (s && s.playerIndex !== undefined)
      s.emit('state', game.stateFor(s.playerIndex));
  }
}

function broadcast(roomId, event, data) {
  io.to(roomId).emit(event, data);
}

io.on('connection', socket => {
  console.log('Connected:', socket.id, '| transport:', socket.conn.transport.name);

  // Log when transport upgrades from polling → websocket
  socket.conn.on('upgrade', transport => {
    console.log('Upgraded to:', transport.name, '| socket:', socket.id);
  });

  socket.on('create', ({ name }) => {
    let roomId;
    do { roomId = Math.random().toString(36).slice(2, 8).toUpperCase(); }
    while (games[roomId]);

    const game = new Game(roomId);
    const idx  = game.addPlayer(socket.id, name);
    games[roomId]      = game;
    socket.join(roomId);
    socket.roomId      = roomId;
    socket.playerIndex = idx;
    socket.emit('joined', { roomId, playerIndex: idx, name });
    broadcastState(roomId);
  });

  socket.on('join', ({ roomId, name }) => {
    const game = games[roomId];
    if (!game) { socket.emit('err', 'Room not found – check the code and try again'); return; }

    // Reconnect by name
    const existingIdx = game.players.findIndex(p => p.name === name);
    if (existingIdx !== -1) {
      const idx = game.reconnectPlayer(socket.id, name, existingIdx);
      if (idx !== -1) {
        socket.join(roomId);
        socket.roomId      = roomId;
        socket.playerIndex = idx;
        socket.emit('joined', { roomId, playerIndex: idx, name });
        broadcastState(roomId);
        if (game.lastGameover) socket.emit('gameover', game.lastGameover);
        broadcast(roomId, 'msg', { text: `${name} reconnected` });
        return;
      }
    }

    if (game.phase !== 'waiting') { socket.emit('err', 'Game already started – use your original name to rejoin'); return; }
    if (game.players.length >= 5) { socket.emit('err', 'Room is full (5/5)'); return; }

    const idx = game.addPlayer(socket.id, name);
    socket.join(roomId);
    socket.roomId      = roomId;
    socket.playerIndex = idx;
    socket.emit('joined', { roomId, playerIndex: idx, name });
    broadcastState(roomId);
    broadcast(roomId, 'msg', { text: `${name} joined!` });
  });

  socket.on('reconnect_player', ({ roomId, name, playerIndex }) => {
    const game = games[roomId];
    if (!game) { socket.emit('err', 'Session expired – please join again'); return; }

    const idx = game.reconnectPlayer(socket.id, name, playerIndex);
    if (idx === -1) { socket.emit('err', 'Could not restore session – please join again'); return; }

    socket.join(roomId);
    socket.roomId      = roomId;
    socket.playerIndex = idx;
    socket.emit('joined', { roomId, playerIndex: idx, name });
    broadcastState(roomId);
    if (game.lastGameover) socket.emit('gameover', game.lastGameover);
    broadcast(roomId, 'msg', { text: `${name} reconnected` });
  });

  socket.on('start', () => {
    const game = games[socket.roomId];
    if (!game || socket.playerIndex !== 0) return;
    if (game.players.length !== 5) { socket.emit('err', 'All 5 players must be connected to start'); return; }
    game.startRound();
    broadcastState(socket.roomId);
    broadcast(socket.roomId, 'msg', { text: 'Game started! Deal 1 done (6 cards each) – bidding begins.' });
  });

  socket.on('bid', ({ amount }) => {
    const game = games[socket.roomId];
    if (!game) return;
    const err = game.placeBid(socket.playerIndex, amount);
    if (err) { socket.emit('err', err); return; }
    const action = amount === 'pass' ? '✋ passed' : `bid ${amount}`;
    broadcast(socket.roomId, 'msg', { text: `${game.players[socket.playerIndex].name} ${action}` });
    broadcastState(socket.roomId);
  });

  socket.on('trump', ({ suit }) => {
    const game = games[socket.roomId];
    if (!game) return;
    const err = game.setTrump(socket.playerIndex, suit);
    if (err) { socket.emit('err', err); return; }
    broadcast(socket.roomId, 'msg', { text: `Trump: ${SUIT_SYMS[suit]} ${suit} – Deal 2 done! Ask phase.` });
    broadcastState(socket.roomId);
  });

  socket.on('ask', ({ cardIds }) => {
    const game = games[socket.roomId];
    if (!game) return;
    const err = game.askForCards(socket.playerIndex, cardIds);
    if (err) { socket.emit('err', err); return; }
    const asked = game.askedCards.map(c => c.rank + SUIT_SYMS[c.suit]).join(' & ');
    broadcast(socket.roomId, 'msg', { text: `${game.players[socket.playerIndex].name} asked for: ${asked} – game begins!` });
    broadcastState(socket.roomId);
  });

  socket.on('play', ({ cardId }) => {
    const game = games[socket.roomId];
    if (!game) return;
    const result = game.playCard(socket.playerIndex, cardId);
    if (typeof result === 'string') { socket.emit('err', result); return; }
    broadcastState(socket.roomId);
    if (result?.trickDone) broadcast(socket.roomId, 'trick', result);
    if (result?.gameOver)  broadcast(socket.roomId, 'gameover', result);
  });

  socket.on('next', () => {
    const game = games[socket.roomId];
    if (!game || socket.playerIndex !== 0) return;
    game.dealer = (game.dealer + 1) % 5;
    game.startRound();
    broadcastState(socket.roomId);
    broadcast(socket.roomId, 'msg', { text: 'New round! Dealer rotated. Bidding begins.' });
  });

  socket.on('disconnect', () => {
    const game = games[socket.roomId];
    if (game && socket.playerIndex !== undefined) {
      const name = game.players[socket.playerIndex]?.name || 'A player';
      if (game.phase === 'waiting') {
        // In the lobby, fully remove the player so the slot is freed
        game.removePlayer(socket.playerIndex);
        // Re-index all remaining sockets in the room
        const sockets = io.sockets.adapter.rooms.get(socket.roomId);
        if (sockets) {
          for (const sid of sockets) {
            const s = io.sockets.sockets.get(sid);
            if (s && s.playerIndex > socket.playerIndex) s.playerIndex--;
          }
        }
        broadcast(socket.roomId, 'msg', { text: `${name} left the room` });
      } else {
        // During game, keep slot so they can reconnect
        game.markDisconnected(socket.playerIndex);
        broadcast(socket.roomId, 'msg', { text: `⚠️ ${name} disconnected – they can rejoin with the same name` });
      }
      broadcastState(socket.roomId);
    }
  });

  // ── Player voluntarily leaves the lobby ──
  socket.on('leave', () => {
    const game = games[socket.roomId];
    if (!game || game.phase !== 'waiting') return;
    if (socket.playerIndex === 0) return; // host cannot leave, must close the room

    const name    = game.players[socket.playerIndex]?.name || 'A player';
    const removed = game.removePlayer(socket.playerIndex);

    // Re-index all remaining sockets in the room
    const sockets = io.sockets.adapter.rooms.get(socket.roomId);
    if (sockets) {
      for (const sid of sockets) {
        const s = io.sockets.sockets.get(sid);
        if (s && s.playerIndex > socket.playerIndex) s.playerIndex--;
      }
    }

    socket.leave(socket.roomId);
    socket.roomId      = undefined;
    socket.playerIndex = undefined;
    socket.emit('kicked', { reason: 'You left the room' });

    broadcast(game.roomId, 'msg', { text: `${name} left the room` });
    broadcastState(game.roomId);
  });

  // ── Host removes a player from the lobby ──
  socket.on('remove_player', ({ targetIndex }) => {
    const game = games[socket.roomId];
    if (!game)                       return;
    if (game.phase !== 'waiting')    { socket.emit('err', 'Can only remove players in the lobby'); return; }
    if (socket.playerIndex !== 0)    { socket.emit('err', 'Only the host can remove players'); return; }
    if (targetIndex === 0)           { socket.emit('err', 'Host cannot remove themselves'); return; }

    const targetName      = game.players[targetIndex]?.name || 'Player';
    const targetSocketId  = game.removePlayer(targetIndex);

    // Re-index all remaining sockets
    const sockets = io.sockets.adapter.rooms.get(socket.roomId);
    if (sockets) {
      for (const sid of sockets) {
        const s = io.sockets.sockets.get(sid);
        if (s && s.playerIndex > targetIndex) s.playerIndex--;
      }
    }

    // Notify the removed player's socket if they are still connected
    if (targetSocketId) {
      const targetSocket = io.sockets.sockets.get(targetSocketId);
      if (targetSocket) {
        targetSocket.leave(socket.roomId);
        targetSocket.roomId      = undefined;
        targetSocket.playerIndex = undefined;
        targetSocket.emit('kicked', { reason: 'You were removed from the room by the host' });
      }
    }

    broadcast(socket.roomId, 'msg', { text: `${targetName} was removed by the host` });
    broadcastState(socket.roomId);
  });
});

// Clean up dead rooms every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [roomId, game] of Object.entries(games)) {
    const allGone = game.players.every(p => p.disconnected && (now - p.lastSeen) > 30 * 60 * 1000);
    if (allGone) { delete games[roomId]; console.log(`Cleaned room ${roomId}`); }
  }
}, 10 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`\n🃏 Bridge running at http://localhost:${PORT}\n`));
