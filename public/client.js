/**
 * Bridge Card Game – Client
 * Key fixes:
 *  - Starts with polling, upgrades to WebSocket automatically (works on all networks)
 *  - Shows visible connection status so you always know if it's connecting/connected/failed
 *  - Buttons disabled until connected – no more silent "nothing happens" on click
 *  - Session saved to localStorage for page-refresh recovery
 */

'use strict';

const SUIT_SYM  = { spades:'♠', hearts:'♥', diamonds:'♦', clubs:'♣' };
const SUIT_NAME = { spades:'Spades', hearts:'Hearts', diamonds:'Diamonds', clubs:'Clubs' };
const RANKS_ALL = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const SUITS_ALL = ['spades','hearts','diamonds','clubs'];

function fullDeck50() {
  const deck = [];
  for (const suit of SUITS_ALL)
    for (const rank of RANKS_ALL) {
      if (rank === '2' && (suit === 'clubs' || suit === 'diamonds')) continue;
      deck.push({ rank, suit, id: `${rank}-${suit}` });
    }
  return deck;
}

// ══════════════════════════════════════════════════════
//  SOCKET CONNECTION
//  Start with polling (always works), upgrade to WebSocket
//  automatically once the connection is established.
//  This is the most reliable approach for Render.com.
// ══════════════════════════════════════════════════════
const socket = io({
  transports: ['polling', 'websocket'],  // polling first, upgrade to WS
  upgrade: true,
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1500,
  reconnectionDelayMax: 8000,
  timeout: 20000,
});

let myIndex     = -1;
let myRoomId    = '';
let myName      = '';
let gameState   = null;
let askSelected = [];
let isConnected = false;

// ══════════════════════════════════════════════════════
//  CONNECTION STATUS INDICATOR
//  Shows clearly in the UI whether the server is reachable
// ══════════════════════════════════════════════════════

function setConnectionStatus(status) {
  // status: 'connecting' | 'connected' | 'disconnected'
  const bar = document.getElementById('conn-status');
  if (!bar) return;
  const configs = {
    connecting:   { text: '⏳ Connecting to server…', color: '#cc8800', show: true  },
    connected:    { text: '🟢 Connected',              color: '#44bb66', show: false }, // hide after short delay
    disconnected: { text: '🔴 Connection lost – retrying…', color: '#cc3333', show: true  },
  };
  const cfg = configs[status] || configs.connecting;
  bar.textContent   = cfg.text;
  bar.style.color   = cfg.color;
  bar.style.display = 'block';

  if (status === 'connected') {
    setTimeout(() => { bar.style.display = 'none'; }, 2000);
  }

  // Disable action buttons when not connected
  isConnected = (status === 'connected');
  document.querySelectorAll('.btn-primary, .btn-secondary').forEach(btn => {
    btn.disabled = !isConnected;
  });
}

// ══════════════════════════════════════════════════════
//  SESSION PERSISTENCE (page refresh recovery)
// ══════════════════════════════════════════════════════

function saveSession() {
  if (myRoomId && myName && myIndex !== -1)
    localStorage.setItem('bridge_session', JSON.stringify({ roomId: myRoomId, name: myName, playerIndex: myIndex }));
}

function clearSession() {
  localStorage.removeItem('bridge_session');
}

function loadSession() {
  try { return JSON.parse(localStorage.getItem('bridge_session')); }
  catch { return null; }
}

// ══════════════════════════════════════════════════════
//  SOCKET EVENTS
// ══════════════════════════════════════════════════════

socket.on('connect', () => {
  setConnectionStatus('connected');
  document.getElementById('login-error').textContent = '';

  // Auto-reconnect if we have a saved session
  const session = loadSession();
  if (session?.roomId && session?.name && session?.playerIndex !== undefined) {
    document.getElementById('login-error').textContent = `Reconnecting as "${session.name}"…`;
    socket.emit('reconnect_player', session);
  }
});

socket.on('connect_error', (err) => {
  setConnectionStatus('disconnected');
  console.error('Connection error:', err.message);
});

socket.on('disconnect', (reason) => {
  setConnectionStatus('disconnected');
  console.log('Disconnected:', reason);
});

socket.on('reconnect_attempt', () => {
  setConnectionStatus('connecting');
});

socket.on('reconnect', () => {
  setConnectionStatus('connected');
  const session = loadSession();
  if (session) socket.emit('reconnect_player', session);
});

socket.on('joined', ({ roomId, playerIndex, name }) => {
  myIndex  = playerIndex;
  myRoomId = roomId;
  myName   = name || myName;
  saveSession();
  document.getElementById('room-code-text').textContent = roomId;
  document.getElementById('login-error').textContent = '';
  showScreen('lobby-screen');
});

socket.on('err', msg => {
  setMsgBar(msg);
  document.getElementById('login-error').textContent = msg;
  if (msg.includes('Session expired') || msg.includes('Could not restore')) clearSession();
});

socket.on('state', state => {
  gameState = state;
  renderState(state);
});

socket.on('msg', ({ text }) => setMsgBar(text));

socket.on('trick', result => {
  setMsgBar(`🏆 ${result.winnerName} won the trick (+${result.ptsWon} pts)`);
});

socket.on('gameover', result => {
  showScoringScreen(result);
});

// ── Kicked / removed from room ──
socket.on('kicked', ({ reason }) => {
  clearSession();
  myIndex  = -1;
  myRoomId = '';
  myName   = '';
  gameState = null;
  showScreen('login-screen');
  document.getElementById('login-error').textContent = reason || 'You were removed from the room';
});

// Show connecting status immediately on page load
setConnectionStatus('connecting');

// ══════════════════════════════════════════════════════
//  SCREEN MANAGEMENT
// ══════════════════════════════════════════════════════

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s =>
    s.classList.toggle('hidden', s.id !== id)
  );
}

function setMsgBar(text) {
  const bar = document.getElementById('msg-bar');
  if (bar) bar.textContent = text;
}

// ══════════════════════════════════════════════════════
//  LOGIN
// ══════════════════════════════════════════════════════

function switchTab(tab) {
  document.getElementById('tab-create').classList.toggle('active', tab === 'create');
  document.getElementById('tab-join').classList.toggle('active',   tab === 'join');
  document.getElementById('pane-create').classList.toggle('hidden', tab !== 'create');
  document.getElementById('pane-join').classList.toggle('hidden',   tab !== 'join');
}

function createRoom() {
  if (!isConnected) { document.getElementById('login-error').textContent = 'Still connecting – please wait a moment…'; return; }
  const name = document.getElementById('name-input').value.trim();
  if (!name) { document.getElementById('login-error').textContent = 'Please enter your name.'; return; }
  myName = name;
  socket.emit('create', { name });
}

function joinRoom() {
  if (!isConnected) { document.getElementById('login-error').textContent = 'Still connecting – please wait a moment…'; return; }
  const name = document.getElementById('name-input').value.trim();
  const code = (document.getElementById('room-input').value || '').trim().toUpperCase();
  if (!name)           { document.getElementById('login-error').textContent = 'Please enter your name.'; return; }
  if (code.length < 6) { document.getElementById('login-error').textContent = 'Enter the 6-letter room code.'; return; }
  myName = name;
  socket.emit('join', { roomId: code, name });
}

document.getElementById('name-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    if (!document.getElementById('pane-join').classList.contains('hidden')) joinRoom();
    else createRoom();
  }
});

// ══════════════════════════════════════════════════════
//  LOBBY
// ══════════════════════════════════════════════════════

function copyRoomCode() {
  navigator.clipboard?.writeText(myRoomId).then(() => setMsgBar('Room code copied!'));
}

function startGame() { socket.emit('start'); }

function leaveRoom() {
  if (!confirm('Are you sure you want to leave the room?')) return;
  socket.emit('leave');
  clearSession();
  myIndex = -1; myRoomId = ''; myName = ''; gameState = null;
  showScreen('login-screen');
  document.getElementById('login-error').textContent = 'You left the room.';
}

function removePlayer(targetIndex) {
  const name = gameState?.players[targetIndex]?.name || 'this player';
  if (!confirm(`Remove ${name} from the room?`)) return;
  socket.emit('remove_player', { targetIndex });
}

// ══════════════════════════════════════════════════════
//  MAIN RENDERER
// ══════════════════════════════════════════════════════

function renderState(state) {
  if (state.phase === 'waiting') { renderLobby(state); return; }
  if (state.phase === 'scoring') {
    if (!document.getElementById('scoring-screen').classList.contains('hidden')) return;
  }
  showScreen('game-screen');
  renderPlayersRing(state);
  renderInfoStrip(state);
  renderTrickZone(state);
  renderActionPanel(state);
  renderMyHand(state);
}

function renderLobby(state) {
  showScreen('lobby-screen');
  const { players } = state;

  document.getElementById('player-count').textContent = players.length;
  const allReady = players.length === 5 && players.every(p => !p.disconnected);
  document.getElementById('lobby-status').textContent =
    allReady ? 'All 5 players ready!' : `Players connected: ${players.length}/5`;

  const icons = ['🎩','🎭','🃏','🌟','🎲'];
  const grid  = document.getElementById('seat-grid');
  grid.innerHTML = '';
  for (let i = 0; i < 5; i++) {
    const p    = players[i];
    const seat = document.createElement('div');
    seat.className = 'seat' + (p ? ' filled' : '') + (p?.disconnected ? ' dc' : '');

    // Host sees a ✕ Remove button next to every non-host occupied seat
    const removeBtn = (p && myIndex === 0 && i !== 0)
      ? `<button class="btn-remove" onclick="removePlayer(${i})" title="Remove ${escHtml(p.name)}">✕</button>`
      : '';

    seat.innerHTML = p
      ? `<span class="seat-icon">${p.disconnected ? '⚡' : icons[i]}</span>
         <span class="seat-name">${escHtml(p.name)}</span>
         ${i === 0       ? '<span class="seat-tag">HOST</span>'  : ''}
         ${i === myIndex ? '<span class="seat-tag">YOU</span>'   : ''}
         ${p.disconnected ? '<span class="seat-tag" style="color:#ff9900">Away</span>' : ''}
         ${removeBtn}`
      : `<span class="seat-icon" style="opacity:0.3">···</span>
         <span class="seat-name" style="opacity:0.3">Empty</span>`;
    grid.appendChild(seat);
  }

  const startBtn  = document.getElementById('start-btn');
  const leaveBtn  = document.getElementById('leave-btn');
  const hint      = document.getElementById('lobby-hint');

  // Leave button: visible for all non-host players
  if (leaveBtn) leaveBtn.classList.toggle('hidden', myIndex === 0);

  if (myIndex === 0) {
    if (allReady) {
      startBtn.classList.remove('hidden');
      hint.textContent = '';
    } else {
      startBtn.classList.add('hidden');
      hint.textContent = `Need ${5 - players.length} more player(s). Share the code above!`;
    }
  } else {
    startBtn.classList.add('hidden');
    hint.textContent = allReady ? 'Waiting for host to start…' : `Waiting for ${5 - players.length} more player(s)…`;
  }
}

function renderPlayersRing(state) {
  const ring = document.getElementById('players-ring');
  ring.innerHTML = '';

  state.players.forEach((p, i) => {
    let cls = 'player-chip';
    if (i === myIndex)                                          cls += ' me';
    if (p.isDealer)                                             cls += ' is-dealer';
    if (i === state.currentBidder && state.phase === 'bidding') cls += ' active-turn';
    if (i === state.turnPlayer    && state.phase === 'playing') cls += ' active-turn';
    if (i === state.highestBidder && state.phase !== 'waiting') cls += ' highest-bidder';
    if (p.reveal === 1)                                         cls += ' teammate-1';
    if (p.reveal === 2)                                         cls += ' teammate-2';
    if (state.passed?.includes(i))                              cls += ' passed';
    if (p.disconnected)                                         cls += ' disconnected';

    const tags = [];
    if (p.isDealer)                tags.push('🃏');
    if (p.reveal === 1)            tags.push('🤝');
    if (p.reveal === 2)            tags.push('🤝🤝');
    if (state.passed?.includes(i)) tags.push('pass');
    if (p.disconnected)            tags.push('⚡away');
    if (i === myIndex)             tags.push('you');

    const chip = document.createElement('div');
    chip.className = cls;
    chip.innerHTML = `
      <div class="pchip-name">${escHtml(p.name)}</div>
      <div class="pchip-sub">${p.cardCount} cards</div>
      ${(state.phase === 'playing' || state.phase === 'scoring')
        ? `<div class="pchip-pts">⭐ ${p.trickPts}</div>` : ''}
      ${tags.length ? `<div class="pchip-sub">${tags.join(' · ')}</div>` : ''}`;
    ring.appendChild(chip);
  });
}

function renderInfoStrip(state) {
  const PHASE_LABELS = {
    bidding: 'Bidding (Deal 1 done)',
    trump:   'Choose Trump',
    ask:     'Ask Phase (Deal 2 done)',
    playing: `Playing – Trick ${state.round + 1}/10`,
    scoring: 'Round Over',
  };
  document.getElementById('info-phase').textContent = PHASE_LABELS[state.phase] || state.phase;
  document.getElementById('info-trump').textContent = state.trump
    ? `Trump: ${SUIT_SYM[state.trump]} ${SUIT_NAME[state.trump]}` : '';
  document.getElementById('info-bid').textContent = state.highestBid > 155
    ? `Bid: ${state.highestBid} (${state.players[state.highestBidder]?.name || ''})` : '';

  if (state.phase === 'playing' && state.askedCardIds?.length === 2) {
    const asked = state.askedCardIds.map(id => {
      const [r, s] = id.split('-');
      return r + SUIT_SYM[s];
    }).join(' & ');
    document.getElementById('info-round').textContent = `Asked: ${asked}`;
  } else {
    document.getElementById('info-round').textContent = '';
  }
}

function renderTrickZone(state) {
  const row = document.getElementById('trick-cards-row');
  if (!state.trick || state.trick.length === 0) {
    row.innerHTML = `<span style="color:var(--text-dim);font-size:13px">No cards played yet</span>`;
    return;
  }
  row.innerHTML = state.trick.map(play => {
    const name = state.players[play.playerIndex]?.name || '?';
    return `<div class="trick-entry">
      <div class="trick-player-label">${escHtml(name)}</div>
      ${cardHTML(play.card, false, true)}
    </div>`;
  }).join('');
}

function renderActionPanel(state) {
  const panel = document.getElementById('action-panel');
  switch (state.phase) {
    case 'bidding': renderBidding(panel, state); break;
    case 'trump':   renderTrump(panel, state);   break;
    case 'ask':     renderAsk(panel, state);     break;
    case 'playing': renderPlaying(panel, state); break;
    default: panel.innerHTML = '';
  }
}

function renderBidding(panel, state) {
  const isMyTurn = state.currentBidder === myIndex;
  const iPassed  = state.passed?.includes(myIndex);

  if (isMyTurn && !iPassed) {
    const minBid = state.highestBid < 160 ? 160 : state.highestBid + 5;
    panel.innerHTML = `
      <div class="bid-row">
        <div style="text-align:center;font-size:13px;color:var(--text-dim)">
          Highest: <strong style="color:var(--gold-light)">${state.highestBid > 155 ? state.highestBid : 'none'}</strong>
          — Your turn to bid
        </div>
        <div class="bid-slider-wrap">
          <span style="font-size:12px;color:var(--text-dim)">Bid:</span>
          <input type="range" id="bid-slider" min="${minBid}" max="290" step="5" value="${minBid}"
            oninput="document.getElementById('bid-val-show').textContent=this.value;
                     document.getElementById('bid-submit-val').textContent=this.value">
          <span class="bid-val" id="bid-val-show">${minBid}</span>
        </div>
        <div class="bid-actions">
          <button class="btn-primary" onclick="doBid()" style="flex:2">
            Bid <span id="bid-submit-val">${minBid}</span>
          </button>
          <button class="btn-pass" onclick="doPass()">✋ Pass</button>
        </div>
      </div>`;
  } else {
    const bidder = state.players[state.currentBidder]?.name || '?';
    panel.innerHTML = `<p class="wait-msg">
      ${iPassed ? '✋ You passed. ' : ''}Waiting for <strong>${escHtml(bidder)}</strong> to bid…
    </p>`;
  }

  if (state.bidLog?.length) {
    const last5 = state.bidLog.slice(-5)
      .map(b => `${escHtml(state.players[b.p]?.name)}: ${b.a === 'pass' ? '✋' : b.a}`)
      .join(' | ');
    panel.insertAdjacentHTML('beforeend',
      `<p style="font-size:11px;color:var(--text-dim);margin-top:6px;text-align:center">${last5}</p>`);
  }
}

function renderTrump(panel, state) {
  if (state.highestBidder === myIndex) {
    panel.innerHTML = `
      <div style="text-align:center;margin-bottom:10px;font-size:13px;color:var(--text-dim)">
        You won with bid <strong style="color:var(--gold-light)">${state.highestBid}</strong>.<br>
        Choose trump – Deal 2 happens automatically after this.
      </div>
      <div class="suit-grid">
        <div class="suit-opt"     onclick="doTrump('spades')"  ><span class="suit-sym">♠</span>Spades</div>
        <div class="suit-opt red" onclick="doTrump('hearts')"  ><span class="suit-sym">♥</span>Hearts</div>
        <div class="suit-opt red" onclick="doTrump('diamonds')"><span class="suit-sym">♦</span>Diamonds</div>
        <div class="suit-opt"     onclick="doTrump('clubs')"   ><span class="suit-sym">♣</span>Clubs</div>
      </div>`;
  } else {
    const bidder = state.players[state.highestBidder]?.name || '?';
    panel.innerHTML = `<p class="wait-msg">Waiting for <strong>${escHtml(bidder)}</strong> to choose trump…</p>`;
  }
}

function renderAsk(panel, state) {
  if (state.highestBidder === myIndex) {
    panel.innerHTML = `
      <div style="text-align:center">
        <p style="font-size:14px;margin-bottom:8px">
          Trump: <strong style="color:var(--gold-light)">${SUIT_SYM[state.trump]} ${SUIT_NAME[state.trump]}</strong>
          &nbsp;|&nbsp; You now have <strong>10 cards</strong>.<br>
          <span style="color:var(--text-dim);font-size:12px">Ask for 2 cards not in your hand.</span>
        </p>
        <button class="btn-primary" style="max-width:280px" onclick="openAskModal()">
          🃏 Select 2 Cards to Ask For
        </button>
      </div>`;
  } else {
    const bidder = state.players[state.highestBidder]?.name || '?';
    panel.innerHTML = `<p class="wait-msg">Waiting for <strong>${escHtml(bidder)}</strong> to ask for 2 cards…</p>`;
  }
}

function renderPlaying(panel, state) {
  if (state.turnPlayer === myIndex) {
    panel.innerHTML = `
      <p class="turn-msg">▶ Your turn! Tap a card to play it.</p>
      ${state.leadSuit
        ? `<p class="lead-info">Lead: ${SUIT_SYM[state.leadSuit]} ${state.leadSuit}
           – ${state.myCards?.some(c => c.suit === state.leadSuit) ? 'you must follow suit' : 'play anything'}</p>`
        : ''}`;
  } else {
    const whose = state.players[state.turnPlayer]?.name || '?';
    const dc    = state.players[state.turnPlayer]?.disconnected;
    panel.innerHTML = `<p class="wait-msg">Waiting for <strong>${escHtml(whose)}</strong>${dc ? ' ⚡(away)' : ''} to play…</p>`;
  }
}

function renderMyHand(state) {
  const myCards = state.myCards || [];
  document.getElementById('hand-count').textContent = `(${myCards.length})`;
  const row     = document.getElementById('my-cards-row');
  const canPlay = state.phase === 'playing' && state.turnPlayer === myIndex;

  row.innerHTML = myCards.map(card => {
    const html = cardHTML(card, !canPlay, false);
    if (canPlay) return `<div onclick="doPlay('${card.id}')" style="display:contents">${html}</div>`;
    return html;
  }).join('');

  if (canPlay) row.querySelectorAll('.card').forEach(el => el.classList.add('playable'));
}

// ══════════════════════════════════════════════════════
//  CARD HTML
// ══════════════════════════════════════════════════════

function cardHTML(card, disabled = false, isTrick = false) {
  const isRed     = card.suit === 'hearts' || card.suit === 'diamonds';
  const isSpecial = card.rank === '3' && card.suit === 'spades';
  let cls = 'card';
  if (isRed)    cls += ' red';
  if (disabled) cls += ' disabled';
  if (isTrick)  cls += ' trick';
  return `<div class="${cls}">
    ${isSpecial ? '<span class="c-special">★30</span>' : ''}
    <div class="c-rank">${card.rank}</div>
    <div class="c-suit">${SUIT_SYM[card.suit]}</div>
  </div>`;
}

// ══════════════════════════════════════════════════════
//  GAME ACTIONS
// ══════════════════════════════════════════════════════

function doBid() {
  const slider = document.getElementById('bid-slider');
  if (!slider) return;
  socket.emit('bid', { amount: parseInt(slider.value, 10) });
}
function doPass()       { socket.emit('bid', { amount: 'pass' }); }
function doTrump(suit)  { socket.emit('trump', { suit }); }
function doPlay(cardId) { socket.emit('play', { cardId }); }

// ══════════════════════════════════════════════════════
//  ASK MODAL
// ══════════════════════════════════════════════════════

function openAskModal() {
  askSelected = [];
  const myCardIds = new Set((gameState?.myCards || []).map(c => c.id));
  const deck      = fullDeck50();
  const bySuit    = { spades:[], hearts:[], diamonds:[], clubs:[] };
  deck.forEach(card => bySuit[card.suit].push(card));

  let suitsHtml = '';
  for (const suit of SUITS_ALL) {
    const isRed = suit === 'hearts' || suit === 'diamonds';
    suitsHtml += `<div class="ask-suit-block">
      <div class="ask-suit-label">${SUIT_SYM[suit]} ${SUIT_NAME[suit]}</div>
      <div class="ask-cards-row">
        ${bySuit[suit].map(card => {
          const inHand = myCardIds.has(card.id);
          return `<div id="amc-${card.id}"
            class="ask-modal-card ${isRed ? 'red' : ''} ${inHand ? 'in-hand' : ''}"
            title="${inHand ? 'Already in your hand' : ''}"
            onclick="${inHand ? '' : `toggleAskCard('${card.id}')`}">
            <div class="amc-rank">${card.rank}</div>
            <div class="amc-suit">${SUIT_SYM[suit]}</div>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }

  document.getElementById('ask-suits').innerHTML = suitsHtml;
  document.getElementById('ask-count-label').textContent = '0 / 2 selected';
  document.getElementById('ask-confirm-btn').disabled = true;
  document.getElementById('ask-modal').classList.remove('hidden');
}

function toggleAskCard(cardId) {
  const el = document.getElementById(`amc-${cardId}`);
  if (!el) return;

  if (askSelected.includes(cardId)) {
    askSelected = askSelected.filter(c => c !== cardId);
    el.classList.remove('selected');
  } else if (askSelected.length < 2) {
    askSelected.push(cardId);
    el.classList.add('selected');
  } else {
    const old = askSelected.shift();
    document.getElementById(`amc-${old}`)?.classList.remove('selected');
    askSelected.push(cardId);
    el.classList.add('selected');
  }

  document.getElementById('ask-count-label').textContent = `${askSelected.length} / 2 selected`;
  document.getElementById('ask-confirm-btn').disabled = askSelected.length !== 2;
}

function confirmAsk() {
  if (askSelected.length !== 2) return;
  socket.emit('ask', { cardIds: [...askSelected] });
  closeAskModal();
}

function closeAskModal() {
  document.getElementById('ask-modal').classList.add('hidden');
}

// ══════════════════════════════════════════════════════
//  SCORING SCREEN
// ══════════════════════════════════════════════════════

function showScoringScreen(data) {
  showScreen('scoring-screen');

  document.getElementById('score-title').textContent =
    data.won ? '🏆 Bidder\'s Team Won!' : '❌ Bidder\'s Team Lost!';

  const bidderName = escHtml(data.bidderName);
  const teamNames  = (data.teammates || [])
    .map(i => escHtml(gameState?.players[i]?.name || `Player ${i + 1}`))
    .join(' & ') || 'nobody';

  document.getElementById('score-summary').innerHTML = `
    <strong>${bidderName}</strong> bid <strong>${data.bid}</strong> pts.<br>
    Teammates: <strong>${teamNames}</strong><br>
    Team's trick points: <strong>${data.teamPts}</strong> / ${data.bid} needed.<br>
    <span class="${data.won ? 'won' : 'lost'}">
      ${data.won ? '✅ Bid successful!' : '❌ Bid failed!'}
    </span>`;

  const tbody = document.getElementById('score-body');
  tbody.innerHTML = (gameState?.players || []).map((p, i) => {
    const rs   = data.roundScores?.[i] ?? 0;
    const ts   = data.totalScores?.[i] ?? 0;
    const tp   = data.trickPts?.[i]    ?? 0;
    const role = i === data.bidder ? '🎯' : (data.teammates?.includes(i) ? '🤝' : '⚔️');
    const rsCls = rs > 0 ? 'positive' : rs < 0 ? 'negative' : 'zero';
    return `<tr class="${i === myIndex ? 'me-row' : ''}">
      <td><span style="margin-right:4px">${role}</span>${escHtml(p.name)}${i === myIndex ? ' <em>(you)</em>' : ''}</td>
      <td>${tp}</td>
      <td class="${rsCls}">${rs >= 0 ? '+' : ''}${rs}</td>
      <td>${ts}</td>
    </tr>`;
  }).join('');

  const nextBtn    = document.getElementById('next-round-btn');
  const waitingMsg = document.getElementById('waiting-next');
  if (myIndex === 0) {
    nextBtn.classList.remove('hidden');
    waitingMsg.classList.add('hidden');
  } else {
    nextBtn.classList.add('hidden');
    waitingMsg.classList.remove('hidden');
  }
}

function nextRound() { socket.emit('next'); }

// ══════════════════════════════════════════════════════
//  UTILITIES
// ══════════════════════════════════════════════════════

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
