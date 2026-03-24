/**
 * Bridge – Client (All 10 Features)
 * 1. No Trump option
 * 2. Illegal deal modal (auto-redeal)
 * 3. Skip to scorecard (host)
 * 4. Auto last trick animation
 * 5. Sorted scorecard
 * 6. More card animations
 * 7. Better animated background
 * 8. Real card design (rank+suit in corners + central pip)
 * 9. Improved bots (server-side)
 * 10. Viewers
 */

'use strict';

const SUIT_SYM  = { spades:'♠', hearts:'♥', diamonds:'♦', clubs:'♣' };
const SUIT_NAME = { spades:'Spades', hearts:'Hearts', diamonds:'Diamonds', clubs:'Clubs' };
const RANKS_ALL = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const SUITS_ALL = ['spades','hearts','diamonds','clubs'];
const NO_TRUMP  = 'notrump';

function fullDeck50() {
  const deck=[];
  for (const suit of SUITS_ALL)
    for (const rank of RANKS_ALL) {
      if (rank==='2'&&(suit==='clubs'||suit==='diamonds')) continue;
      deck.push({rank,suit,id:`${rank}-${suit}`});
    }
  return deck;
}

/* ══════════════════════════════════════════════
   BACKGROUND  (Feature 7)
   ══════════════════════════════════════════════ */
function initBackground() {
  const canvas = document.getElementById('bg-canvas');
  if (!canvas) return;
  const suits = ['♠','♥','♦','♣'];
  const colors = { '♠':'rgba(255,255,255,0.06)', '♣':'rgba(255,255,255,0.05)',
                   '♥':'rgba(220,40,40,0.07)',    '♦':'rgba(220,40,40,0.06)' };
  for (let i=0;i<24;i++) {
    const el=document.createElement('span');
    el.className='bg-suit';
    const sym=suits[Math.floor(Math.random()*4)];
    el.textContent=sym;
    el.style.cssText=`
      left:${Math.random()*100}%;
      font-size:${28+Math.random()*52}px;
      color:${colors[sym]};
      animation-duration:${14+Math.random()*22}s;
      animation-delay:${-Math.random()*30}s;
    `;
    canvas.appendChild(el);
  }
}
initBackground();

/* ══════════════════════════════════════════════
   AUDIO
   ══════════════════════════════════════════════ */
let _ac=null;
function ac() { if (!_ac) _ac=new (window.AudioContext||window.webkitAudioContext)(); return _ac; }
function playSound(type) {
  try {
    const ctx=ac();
    const g=ctx.createGain(); g.connect(ctx.destination);
    const cfgs={
      deal:    {freq:[320,220],dur:.09,vol:.1,wave:'triangle'},
      shuffle: {freq:[380,280,180],dur:.06,vol:.07,wave:'sawtooth'},
      play:    {freq:[480,380],dur:.1,vol:.14,wave:'sine'},
      trump:   {freq:[280,420,560],dur:.15,vol:.18,wave:'square'},
      win:     {freq:[480,580,680,780],dur:.12,vol:.16,wave:'sine'},
      error:   {freq:[200,150],dur:.1,vol:.1,wave:'sawtooth'},
      auto:    {freq:[300,350],dur:.07,vol:.09,wave:'triangle'},
    };
    const cfg=cfgs[type]||cfgs.play;
    cfg.freq.forEach((f,i)=>{
      const osc=ctx.createOscillator(); const env=ctx.createGain();
      osc.connect(env); env.connect(g);
      osc.type=cfg.wave;
      osc.frequency.setValueAtTime(f,ctx.currentTime+i*cfg.dur*.8);
      env.gain.setValueAtTime(cfg.vol,ctx.currentTime+i*cfg.dur*.8);
      env.gain.exponentialRampToValueAtTime(.001,ctx.currentTime+(i+1)*cfg.dur);
      osc.start(ctx.currentTime+i*cfg.dur*.8);
      osc.stop(ctx.currentTime+(i+1)*cfg.dur);
    });
  } catch(e) {}
}

/* ══════════════════════════════════════════════
   SOCKET
   ══════════════════════════════════════════════ */
const socket=io({
  transports:['polling','websocket'],upgrade:true,
  reconnection:true,reconnectionAttempts:Infinity,
  reconnectionDelay:1500,reconnectionDelayMax:8000,timeout:20000,
});

let myIndex=-1, myRoomId='', myName='', gameState=null;
let askSelected=[], isConnected=false, isViewer=false;

/* ── Session ── */
function saveSession() { if(myRoomId&&myName&&myIndex!==-1) localStorage.setItem('bridge_session',JSON.stringify({roomId:myRoomId,name:myName,playerIndex:myIndex})); }
function clearSession() { localStorage.removeItem('bridge_session'); }
function loadSession()  { try{return JSON.parse(localStorage.getItem('bridge_session'));}catch{return null;} }

/* ── Connection status ── */
function setConnectionStatus(status) {
  const bar=document.getElementById('conn-status'); if (!bar) return;
  const cfgs={connecting:{text:'⏳ Connecting…',color:'#cc8800'},connected:{text:'🟢 Connected',color:'#44bb66'},disconnected:{text:'🔴 Connection lost…',color:'#cc3333'}};
  const cfg=cfgs[status]||cfgs.connecting;
  bar.textContent=cfg.text; bar.style.color=cfg.color; bar.style.display='block';
  if (status==='connected') setTimeout(()=>{bar.style.display='none';},2000);
  isConnected=(status==='connected');
  document.querySelectorAll('.btn-primary,.btn-secondary').forEach(b=>{b.disabled=!isConnected;});
}

/* ══════════════════════════════════════════════
   SOCKET EVENTS
   ══════════════════════════════════════════════ */
socket.on('connect',()=>{
  setConnectionStatus('connected');
  document.getElementById('login-error').textContent='';
  const s=loadSession();
  if (s?.roomId&&s?.name&&s?.playerIndex!==undefined) {
    document.getElementById('login-error').textContent=`Reconnecting as "${s.name}"…`;
    socket.emit('reconnect_player',s);
  }
});
socket.on('connect_error',()=>setConnectionStatus('disconnected'));
socket.on('disconnect',()=>setConnectionStatus('disconnected'));
socket.on('reconnect_attempt',()=>setConnectionStatus('connecting'));
socket.on('reconnect',()=>{
  setConnectionStatus('connected');
  const s=loadSession(); if(s) socket.emit('reconnect_player',s);
});

socket.on('joined',({roomId,playerIndex,name})=>{
  myIndex=playerIndex; myRoomId=roomId; myName=name||myName; isViewer=false;
  saveSession();
  document.getElementById('room-code-text').textContent=roomId;
  document.getElementById('login-error').textContent='';
  showScreen('lobby-screen');
});

// Feature 10: viewer join
socket.on('joined_as_viewer',({roomId,name})=>{
  myRoomId=roomId; myName=name; isViewer=true;
  document.getElementById('viewer-room-code').textContent=roomId;
  document.getElementById('login-error').textContent='';
  showScreen('viewer-screen');
});

socket.on('err',msg=>{
  setMsgBar(msg);
  document.getElementById('login-error').textContent=msg;
  if (msg.includes('Session expired')||msg.includes('Could not restore')) {
    const s=loadSession(); clearSession(); myIndex=-1; myRoomId=''; myName='';
    if (s?.name) {
      document.getElementById('name-input').value=s.name;
      document.getElementById('room-input').value=s.roomId||'';
      switchTab('join');
      document.getElementById('login-error').textContent='Session expired – your details are filled in, click Join / Watch.';
    }
  }
});

socket.on('state',state=>{
  gameState=state;
  if (isViewer) { renderViewerState(state); return; }
  renderState(state);
});

socket.on('msg',({text})=>setMsgBar(text));
socket.on('trick',result=>{ setMsgBar(`🏆 ${result.winnerName} won the trick (+${result.ptsWon} pts)`); playSound('win'); });
socket.on('gameover',result=>showScoringScreen(result));
socket.on('trump_event',data=>showTrumpToast(data));
socket.on('early_loss',data=>showEarlyLossModal(data));
socket.on('podium',data=>showPodium(data));

// Feature 2: illegal deal
socket.on('illegal_deal',({playerName})=>{
  document.getElementById('illegal-deal-body').textContent=
    `${playerName} was dealt all 4 Aces – this is an illegal deal. Cards are being redealt automatically in 3 seconds.`;
  document.getElementById('illegal-deal-modal').classList.remove('hidden');
  playSound('error');
  setTimeout(()=>document.getElementById('illegal-deal-modal').classList.add('hidden'),4000);
});

socket.on('kicked',({reason})=>{
  clearSession(); myIndex=-1; myRoomId=''; myName=''; gameState=null; isViewer=false;
  showScreen('login-screen');
  document.getElementById('login-error').textContent=reason||'Removed from room';
});

setConnectionStatus('connecting');

/* ══════════════════════════════════════════════
   SCREENS
   ══════════════════════════════════════════════ */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s=>s.classList.toggle('hidden',s.id!==id));
}
function setMsgBar(text) { const b=document.getElementById('msg-bar'); if(b) b.textContent=text; }

/* ══════════════════════════════════════════════
   LOGIN
   ══════════════════════════════════════════════ */
function switchTab(tab) {
  document.getElementById('tab-create').classList.toggle('active',tab==='create');
  document.getElementById('tab-join').classList.toggle('active',tab==='join');
  document.getElementById('pane-create').classList.toggle('hidden',tab!=='create');
  document.getElementById('pane-join').classList.toggle('hidden',tab!=='join');
}
function createRoom() {
  if (!isConnected){document.getElementById('login-error').textContent='Still connecting…';return;}
  const name=document.getElementById('name-input').value.trim();
  if (!name){document.getElementById('login-error').textContent='Please enter your name.';return;}
  myName=name; socket.emit('create',{name});
}
function joinRoom() {
  if (!isConnected){document.getElementById('login-error').textContent='Still connecting…';return;}
  const name=document.getElementById('name-input').value.trim();
  const code=(document.getElementById('room-input').value||'').trim().toUpperCase();
  if (!name){document.getElementById('login-error').textContent='Please enter your name.';return;}
  if (code.length<6){document.getElementById('login-error').textContent='Enter the 6-letter room code.';return;}
  myName=name; socket.emit('join',{roomId:code,name});
}
document.getElementById('name-input').addEventListener('keydown',e=>{
  if (e.key==='Enter'){if(!document.getElementById('pane-join').classList.contains('hidden'))joinRoom();else createRoom();}
});

/* ══════════════════════════════════════════════
   LOBBY
   ══════════════════════════════════════════════ */
function copyRoomCode() { navigator.clipboard?.writeText(myRoomId).then(()=>setMsgBar('Code copied!')); }
function startGame()    { socket.emit('start'); playSound('shuffle'); }
function leaveViewer()  { socket.emit('leave'); clearSession(); isViewer=false; myRoomId=''; myName=''; showScreen('login-screen'); }

function addNBots(n) {
  const cur=gameState?.players?.length||0, avail=5-cur, toAdd=Math.min(n,avail);
  if (!isConnected){setMsgBar('Not connected');return;}
  for (let i=0;i<toAdd;i++) {
    setTimeout(()=>socket.emit('add_bot',{name:`Bot ${cur+i+1}`}),i*180);
  }
}

function leaveRoom() {
  if (!confirm('Leave the room?')) return;
  socket.emit('leave'); clearSession(); myIndex=-1; myRoomId=''; myName=''; gameState=null;
  showScreen('login-screen'); document.getElementById('login-error').textContent='You left the room.';
}
function removePlayer(idx) { const n=gameState?.players[idx]?.name||'this player'; if(!confirm(`Remove ${n}?`))return; socket.emit('remove_player',{targetIndex:idx}); }
function removeBot(idx)    { if(!confirm('Remove this bot?'))return; socket.emit('remove_bot',{botIndex:idx}); }

function renderLobby(state) {
  showScreen('lobby-screen');
  const {players}=state; const isHost=myIndex===0;
  const allReady=players.length===5&&players.every(p=>!p.disconnected);
  const pcEl=document.getElementById('player-count'); const stEl=document.getElementById('lobby-status');
  if (pcEl) pcEl.textContent=players.length;
  if (stEl) stEl.textContent=allReady?'All 5 ready!':`${players.length}/5 connected`;

  const icons=['🎩','🎭','🃏','🌟','🎲'];
  const grid=document.getElementById('seat-grid'); grid.innerHTML='';
  for (let i=0;i<5;i++) {
    const p=players[i]; const seat=document.createElement('div');
    seat.className='seat'+(p?' filled':'')+(p?.disconnected?' dc':'');
    const isBot=p?.isBot;
    const hRemove=(p&&isHost&&i!==0&&!isBot)?`<button class="btn-remove" onclick="removePlayer(${i})">✕</button>`:'';
    const bRemove=(p&&isHost&&isBot)?`<button class="btn-remove" onclick="removeBot(${i})">✕Bot</button>`:'';
    seat.innerHTML=p
      ?`<span class="seat-icon">${p.disconnected?'⚡':isBot?'🤖':icons[i]}</span>
        <span class="seat-name">${escHtml(p.name)}</span>
        ${i===0?'<span class="seat-tag">HOST</span>':''}${i===myIndex?'<span class="seat-tag">YOU</span>':''}
        ${isBot?'<span class="seat-tag" style="color:#88ccff">BOT</span>':''}
        ${p.disconnected?'<span class="seat-tag" style="color:#ff9900">Away</span>':''}
        ${hRemove}${bRemove}`
      :`<span class="seat-icon" style="opacity:.3">···</span><span class="seat-name" style="opacity:.3">Empty</span>`;
    grid.appendChild(seat);
  }

  const botSection=document.getElementById('bot-section'); const slotsLeft=5-players.length;
  if (botSection) {
    if (isHost&&slotsLeft>0) {
      botSection.style.display='block';
      botSection.innerHTML=`<div style="background:rgba(100,180,255,.08);border:1px solid rgba(100,180,255,.2);border-radius:10px;padding:12px 16px;width:100%;max-width:380px;text-align:center;"><div style="font-size:12px;color:var(--text-dim);margin-bottom:10px">🤖 Add bots to fill empty seats (${slotsLeft} slot${slotsLeft!==1?'s':''} left)</div><div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">${Array.from({length:slotsLeft},(_,k)=>`<button class="btn-bot" onclick="addNBots(${k+1})">+${k+1} Bot${k>0?'s':''}</button>`).join('')}</div></div>`;
    } else { botSection.style.display='none'; botSection.innerHTML=''; }
  }

  const startBtn=document.getElementById('start-btn');
  const leaveBtn=document.getElementById('leave-btn');
  const cancelLobbyBtn=document.getElementById('cancel-lobby-btn');
  const hint=document.getElementById('lobby-hint');
  if (leaveBtn)       leaveBtn.classList.toggle('hidden',isHost);
  if (cancelLobbyBtn) cancelLobbyBtn.classList.toggle('hidden',!isHost);
  if (startBtn) { if(isHost&&allReady){startBtn.classList.remove('hidden');if(hint)hint.textContent='';}else{startBtn.classList.add('hidden');if(hint)hint.textContent=isHost?`${slotsLeft} slot${slotsLeft!==1?'s':''} empty.`:'Waiting for host to start…';} }
}

/* ══════════════════════════════════════════════
   VIEWER STATE (Feature 10)
   ══════════════════════════════════════════════ */
function renderViewerState(state) {
  // Show game screen in viewer mode
  showScreen('game-screen');
  renderPlayersRing(state);
  renderInfoStrip(state);
  renderTrickZone(state);
  renderLastTrick(state);
  renderTeammatePanel(state);
  // Action panel: just show who's turn it is
  const panel=document.getElementById('action-panel');
  if (state.phase==='playing') {
    const whose=state.players[state.turnPlayer]?.name||'?';
    panel.innerHTML=`<p class="wait-msg">👁 Watching – ${escHtml(whose)}'s turn to play</p>`;
  } else if (state.phase==='bidding') {
    const whose=state.players[state.currentBidder]?.name||'?';
    panel.innerHTML=`<p class="wait-msg">👁 Watching – ${escHtml(whose)}'s turn to bid</p>`;
  } else {
    panel.innerHTML=`<p class="wait-msg">👁 Watching…</p>`;
  }
  // No hand zone for viewers
  const handZone=document.getElementById('my-hand-zone');
  if (handZone) { handZone.querySelector('#my-hand-label').textContent='You are viewing this game'; document.getElementById('my-cards-row').innerHTML='<span style="color:var(--text-dim);font-size:12px">Viewers cannot see player cards</span>'; }
}

/* ══════════════════════════════════════════════
   MAIN RENDERER
   ══════════════════════════════════════════════ */
function renderState(state) {
  if (state.phase==='waiting') { renderLobby(state); return; }
  if (state.phase==='scoring') { if(!document.getElementById('scoring-screen').classList.contains('hidden')) return; }
  showScreen('game-screen');
  renderPlayersRing(state);
  renderInfoStrip(state);
  renderTrickZone(state);
  renderLastTrick(state);
  renderTeammatePanel(state);
  renderActionPanel(state);
  renderMyHand(state);
}

function renderPlayersRing(state) {
  const ring=document.getElementById('players-ring'); ring.innerHTML='';
  state.players.forEach((p,i)=>{
    let cls='player-chip';
    if (i===myIndex) cls+=' me';
    if (p.isDealer) cls+=' is-dealer';
    if (i===state.currentBidder&&state.phase==='bidding') cls+=' active-turn';
    if (i===state.turnPlayer&&state.phase==='playing') cls+=' active-turn';
    if (i===state.highestBidder&&state.phase!=='waiting') cls+=' highest-bidder';
    if (p.reveal===1) cls+=' teammate-1';
    if (p.reveal===2) cls+=' teammate-2';
    if (state.passed?.includes(i)) cls+=' passed';
    if (p.disconnected) cls+=' disconnected';
    if (p.isBot) cls+=' bot-chip';
    const tags=[];
    if (p.isDealer) tags.push('🃏');
    if (p.isBot) tags.push('🤖');
    if (p.reveal===1) tags.push('🤝');
    if (p.reveal===2) tags.push('🤝🤝');
    if (state.passed?.includes(i)) tags.push('pass');
    if (p.disconnected) tags.push('⚡away');
    if (i===myIndex) tags.push('you');
    const chip=document.createElement('div'); chip.className=cls;
    chip.innerHTML=`<div class="pchip-name">${escHtml(p.name)}</div><div class="pchip-sub">${p.cardCount} cards</div>${(state.phase==='playing'||state.phase==='scoring')?`<div class="pchip-pts">⭐${p.trickPts}</div>`:''}${tags.length?`<div class="pchip-sub">${tags.join('·')}</div>`:''}`;
    ring.appendChild(chip);
  });
}

function renderInfoStrip(state) {
  const LABELS={bidding:'Bidding (Deal 1)',trump:'Choose Trump',ask:'Ask (Deal 2 done)',playing:`Trick ${state.round+1}/10`,scoring:'Round Over'};
  document.getElementById('info-phase').textContent=LABELS[state.phase]||state.phase;

  // Feature 1: show No Trump correctly
  let trumpLabel='';
  if (state.trump) {
    trumpLabel=state.trump===NO_TRUMP?'🚫 No Trump':`Trump: ${SUIT_SYM[state.trump]} ${SUIT_NAME[state.trump]}`;
  }
  document.getElementById('info-trump').textContent=trumpLabel;
  document.getElementById('info-bid').textContent=state.highestBid>155?`Bid: ${state.highestBid} (${state.players[state.highestBidder]?.name||''})`:'';

  if (state.phase==='playing'&&state.askedCardIds?.length===2) {
    const asked=state.askedCardIds.map(id=>{const[r,s]=id.split('-');return r+SUIT_SYM[s];}).join(' & ');
    document.getElementById('info-round').textContent=`Asked: ${asked}`;
  } else document.getElementById('info-round').textContent='';

  // Viewer count
  const viewerSpan=document.getElementById('info-viewer');
  const vcountEl=document.getElementById('viewer-count');
  if (viewerSpan&&vcountEl) {
    const vc=state.viewerCount||0;
    vcountEl.textContent=vc;
    viewerSpan.classList.toggle('hidden',vc===0);
  }

  const cancelBtn=document.getElementById('cancel-game-btn');
  const skipBtn=document.getElementById('skip-score-btn');
  if (cancelBtn) cancelBtn.classList.toggle('hidden',myIndex!==0||isViewer);
  if (skipBtn)   skipBtn.classList.toggle('hidden',myIndex!==0||state.phase!=='playing'||isViewer);
}

function renderTrickZone(state) {
  const row=document.getElementById('trick-cards-row');
  if (!state.trick||state.trick.length===0) {
    row.innerHTML=`<span style="color:var(--text-dim);font-size:12px">Waiting for first card…</span>`;
    return;
  }
  const trickKey=state.trick.map(t=>t.card.id).join(',');
  if (row.dataset.key===trickKey) return;
  row.dataset.key=trickKey;

  // Find current trick winner for winner glow
  let winnerIdx=state.trick[0].playerIndex;
  for (const t of state.trick) {
    const w=state.trick.find(x=>x.playerIndex===winnerIdx);
    if (beats_client(t.card, w.card, state.leadSuit, state.trump)) winnerIdx=t.playerIndex;
  }

  row.innerHTML=state.trick.map(play=>{
    const name=state.players[play.playerIndex]?.name||'?';
    const isWinner=play.playerIndex===winnerIdx&&state.trick.length===5;
    return `<div class="trick-entry">
      <div class="trick-player-label">${escHtml(name)}</div>
      ${cardHTML(play.card,false,true,isWinner?'winner':'')}
    </div>`;
  }).join('');
  playSound('play');
}

// Client-side beats for trick winner highlight
function beats_client(challenger, current, leadSuit, trump) {
  const isNoTrump=!trump||trump===NO_TRUMP;
  if (!isNoTrump) {
    const cT=challenger.suit===trump, wT=current.suit===trump;
    if (cT&&!wT) return true;
    if (!cT&&wT) return false;
    if (cT&&wT) return rankIndex_c(challenger.rank)>rankIndex_c(current.rank);
  }
  const cL=challenger.suit===leadSuit, wL=current.suit===leadSuit;
  if (wL&&!cL) return false;
  if (!wL&&cL) return true;
  if (!wL&&!cL) return false;
  return rankIndex_c(challenger.rank)>rankIndex_c(current.rank);
}
function rankIndex_c(rank) { return RANKS_ALL.indexOf(rank); }

function renderLastTrick(state) {
  const cards=document.getElementById('last-trick-cards');
  const label=document.getElementById('last-trick-winner-label');
  if (!state.lastTrick||state.lastTrick.length===0) {
    if(cards) cards.innerHTML='<span style="font-size:10px;color:var(--text-dim)">–</span>';
    if(label) label.textContent='';
    return;
  }
  if(label) label.textContent=`Won: ${state.players[state.lastTrickWinner]?.name||'?'}`;
  if(cards) cards.innerHTML=state.lastTrick.map(play=>{
    const pName=state.players[play.playerIndex]?.name||'?';
    return `<div class="last-trick-entry"><div class="lt-player-label">${escHtml(pName)}</div>${cardHTML(play.card,false,false,'mini')}</div>`;
  }).join('');
}

function renderTeammatePanel(state) {
  const list=document.getElementById('teammate-list');
  if (state.phase!=='playing'&&state.phase!=='scoring'){list.innerHTML='';return;}
  const revealed=state.players.map((p,i)=>({...p,index:i})).filter(p=>p.reveal>0);
  if (revealed.length===0) { list.innerHTML='<span style="font-size:10px;color:var(--text-dim)">Not yet revealed</span>'; return; }
  list.innerHTML=revealed.map(p=>`<div class="teammate-entry"><div class="te-icon">${p.reveal===2?'🤝🤝':'🤝'}</div><div class="te-name">${escHtml(p.name)}</div><div class="te-label">${p.reveal===2?'Both cards':'Teammate'}</div></div>`).join('');
}

function renderActionPanel(state) {
  const panel=document.getElementById('action-panel');
  switch(state.phase) {
    case 'bidding': renderBidding(panel,state); break;
    case 'trump':   renderTrump(panel,state);   break;
    case 'ask':     renderAsk(panel,state);      break;
    case 'playing': renderPlaying(panel,state);  break;
    default: panel.innerHTML='';
  }
}

function renderBidding(panel,state) {
  const isMyTurn=state.currentBidder===myIndex, iPassed=state.passed?.includes(myIndex);
  if (isMyTurn&&!iPassed) {
    const minBid=state.highestBid<160?160:state.highestBid+5;
    panel.innerHTML=`<div class="bid-row"><div style="text-align:center;font-size:13px;color:var(--text-dim)">Highest: <strong style="color:var(--gold-light)">${state.highestBid>155?state.highestBid:'none'}</strong> — Your turn</div><div class="bid-slider-wrap"><span style="font-size:12px;color:var(--text-dim)">Bid:</span><input type="range" id="bid-slider" min="${minBid}" max="290" step="5" value="${minBid}" oninput="document.getElementById('bid-val-show').textContent=this.value;document.getElementById('bid-submit-val').textContent=this.value"><span class="bid-val" id="bid-val-show">${minBid}</span></div><div class="bid-actions"><button class="btn-primary" onclick="doBid()" style="flex:2">Bid <span id="bid-submit-val">${minBid}</span></button><button class="btn-pass" onclick="doPass()">✋ Pass</button></div></div>`;
  } else {
    const bidder=state.players[state.currentBidder]?.name||'?';
    panel.innerHTML=`<p class="wait-msg">${iPassed?'✋ You passed. ':''}Waiting for <strong>${escHtml(bidder)}</strong>${state.players[state.currentBidder]?.isBot?' 🤖':''} to bid…</p>`;
  }
  if (state.bidLog?.length) {
    const last5=state.bidLog.slice(-5).map(b=>`${escHtml(state.players[b.p]?.name)}:${b.a==='pass'?'✋':b.a}`).join(' | ');
    panel.insertAdjacentHTML('beforeend',`<p style="font-size:11px;color:var(--text-dim);margin-top:5px;text-align:center">${last5}</p>`);
  }
}

function renderTrump(panel,state) {
  if (state.highestBidder===myIndex) {
    panel.innerHTML=`<div style="text-align:center;margin-bottom:8px;font-size:13px;color:var(--text-dim)">You won bid <strong style="color:var(--gold-light)">${state.highestBid}</strong>. Choose trump or No Trump:</div>
    <div class="suit-grid">
      <div class="suit-opt"     onclick="doTrump('spades')"  ><span class="suit-sym">♠</span>Spades</div>
      <div class="suit-opt red" onclick="doTrump('hearts')"  ><span class="suit-sym">♥</span>Hearts</div>
      <div class="suit-opt red" onclick="doTrump('diamonds')"><span class="suit-sym">♦</span>Diamonds</div>
      <div class="suit-opt"     onclick="doTrump('clubs')"   ><span class="suit-sym">♣</span>Clubs</div>
      <div class="suit-opt notrump" onclick="doTrump('notrump')"><span class="suit-sym">🚫</span>No Trump</div>
    </div>`;
  } else {
    const bidder=state.players[state.highestBidder]?.name||'?';
    panel.innerHTML=`<p class="wait-msg">Waiting for <strong>${escHtml(bidder)}</strong>${state.players[state.highestBidder]?.isBot?' 🤖':''} to choose trump…</p>`;
  }
}

function renderAsk(panel,state) {
  const trumpLabel=state.trump===NO_TRUMP?'🚫 No Trump':`${SUIT_SYM[state.trump]} ${SUIT_NAME[state.trump]}`;
  if (state.highestBidder===myIndex) {
    panel.innerHTML=`<div style="text-align:center"><p style="font-size:14px;margin-bottom:8px">${trumpLabel} | You have <strong>10 cards</strong>.<br><span style="color:var(--text-dim);font-size:12px">Ask for 2 cards not in your hand.</span></p><button class="btn-primary" style="max-width:280px" onclick="openAskModal()">🃏 Select 2 Cards</button></div>`;
  } else {
    const bidder=state.players[state.highestBidder]?.name||'?';
    panel.innerHTML=`<p class="wait-msg">Waiting for <strong>${escHtml(bidder)}</strong>${state.players[state.highestBidder]?.isBot?' 🤖':''} to ask…</p>`;
  }
}

function renderPlaying(panel,state) {
  if (state.autoLastTrickInProgress) { panel.innerHTML=`<p class="turn-msg">🃏 Auto-playing last trick…</p>`; return; }
  if (state.turnPlayer===myIndex) {
    panel.innerHTML=`<p class="turn-msg">▶ Your turn! Tap a card.</p>${state.leadSuit?`<p class="lead-info">Lead: ${SUIT_SYM[state.leadSuit]} ${state.leadSuit} – ${state.myCards?.some(c=>c.suit===state.leadSuit)?'follow suit':'play anything'}</p>`:''}`;
  } else {
    const whose=state.players[state.turnPlayer]?.name||'?';
    const dc=state.players[state.turnPlayer]?.disconnected, bot=state.players[state.turnPlayer]?.isBot;
    panel.innerHTML=`<p class="wait-msg">Waiting for <strong>${escHtml(whose)}</strong>${bot?' 🤖':''}${dc?' ⚡(away)':''} to play…</p>`;
  }
}

function renderMyHand(state) {
  const myCards=state.myCards||[];
  document.getElementById('hand-count').textContent=`(${myCards.length})`;
  const row=document.getElementById('my-cards-row');
  const canPlay=state.phase==='playing'&&state.turnPlayer===myIndex&&!state.autoLastTrickInProgress;
  row.innerHTML=myCards.map(card=>{
    const html=cardHTML(card,!canPlay,false);
    if (canPlay) return `<div onclick="doPlay('${card.id}')" style="display:contents">${html}</div>`;
    return html;
  }).join('');
  if (canPlay) row.querySelectorAll('.card').forEach(el=>el.classList.add('playable'));
  if (myCards.length!==parseInt(row.dataset.prevCount||'0')) { playSound('deal'); row.dataset.prevCount=String(myCards.length); }
}

/* ══════════════════════════════════════════════
   CARD HTML  – Real card design (Feature 8)
   ══════════════════════════════════════════════ */
function cardHTML(card, disabled=false, isTrick=false, extra='') {
  const isRed=(card.suit==='hearts'||card.suit==='diamonds');
  const isSpecial=(card.rank==='3'&&card.suit==='spades');
  let cls='card';
  if (isRed)    cls+=' red';
  if (disabled) cls+=' disabled';
  if (isTrick)  cls+=' trick';
  if (extra)    cls+=` ${extra}`;
  const sym=SUIT_SYM[card.suit];
  return `<div class="${cls}">
    ${isSpecial?'<span class="c-special">★30</span>':''}
    <div class="c-tl">
      <div class="c-rank">${card.rank}</div>
      <div class="c-suit">${sym}</div>
    </div>
    <div class="c-center">${sym}</div>
    <div class="c-br">
      <div class="c-rank">${card.rank}</div>
      <div class="c-suit">${sym}</div>
    </div>
  </div>`;
}

/* ══════════════════════════════════════════════
   ACTIONS
   ══════════════════════════════════════════════ */
function doBid() { const s=document.getElementById('bid-slider'); if(!s)return; socket.emit('bid',{amount:parseInt(s.value,10)}); }
function doPass()       { socket.emit('bid',{amount:'pass'}); }
function doTrump(suit)  { socket.emit('trump',{suit}); }
function doPlay(cardId) { socket.emit('play',{cardId}); }
function skipToScore()  { if(!confirm('Skip remaining tricks and go to scorecard?'))return; socket.emit('skip_to_score'); }

/* ══════════════════════════════════════════════
   ASK MODAL
   ══════════════════════════════════════════════ */
function openAskModal() {
  const askSelected_=[];
  const myCardIds=new Set((gameState?.myCards||[]).map(c=>c.id));
  const deck=fullDeck50(); const bySuit={spades:[],hearts:[],diamonds:[],clubs:[]};
  deck.forEach(c=>bySuit[c.suit].push(c));
  let html='';
  for (const suit of SUITS_ALL) {
    const isRed=suit==='hearts'||suit==='diamonds';
    html+=`<div class="ask-suit-block"><div class="ask-suit-label">${SUIT_SYM[suit]} ${SUIT_NAME[suit]}</div><div class="ask-cards-row">${bySuit[suit].map(card=>{const inHand=myCardIds.has(card.id);return`<div id="amc-${card.id}" class="ask-modal-card ${isRed?'red':''} ${inHand?'in-hand':''}" onclick="${inHand?'':` toggleAskCard('${card.id}')`}"><div class="amc-rank">${card.rank}</div><div class="amc-suit">${SUIT_SYM[suit]}</div></div>`;}).join('')}</div></div>`;
  }
  document.getElementById('ask-suits').innerHTML=html;
  document.getElementById('ask-count-label').textContent='0 / 2 selected';
  document.getElementById('ask-confirm-btn').disabled=true;
  document.getElementById('ask-modal').classList.remove('hidden');
  window._askSelected=[];
}

function toggleAskCard(cardId) {
  if (!window._askSelected) window._askSelected=[];
  const sel=window._askSelected; const el=document.getElementById(`amc-${cardId}`); if(!el) return;
  if (sel.includes(cardId)) { window._askSelected=sel.filter(c=>c!==cardId); el.classList.remove('selected'); }
  else if (sel.length<2) { sel.push(cardId); el.classList.add('selected'); }
  else { const old=sel.shift(); document.getElementById(`amc-${old}`)?.classList.remove('selected'); sel.push(cardId); el.classList.add('selected'); }
  document.getElementById('ask-count-label').textContent=`${sel.length} / 2 selected`;
  document.getElementById('ask-confirm-btn').disabled=sel.length!==2;
}

function confirmAsk() {
  const sel=window._askSelected||[];
  if (sel.length!==2) return;
  socket.emit('ask',{cardIds:[...sel]}); closeAskModal();
}
function closeAskModal() { document.getElementById('ask-modal').classList.add('hidden'); }

/* ══════════════════════════════════════════════
   TRUMP TOAST
   ══════════════════════════════════════════════ */
let trumpToastTimer=null;
function showTrumpToast(data) {
  const toast=document.getElementById('trump-toast'); if (!toast) return;
  const sym=data.card?.suit&&data.card.suit!==NO_TRUMP?SUIT_SYM[data.card.suit]:'';
  toast.textContent=data.type==='trump_played'
    ?`🃏 ${data.playerName} plays trump! ${data.card?.rank||''}${sym}`
    :`⬆️ ${data.playerName} plays higher trump! ${data.card?.rank||''}${sym}`;
  toast.classList.remove('hidden'); playSound('trump');
  if (trumpToastTimer) clearTimeout(trumpToastTimer);
  trumpToastTimer=setTimeout(()=>toast.classList.add('hidden'),3000);
}

/* ══════════════════════════════════════════════
   EARLY LOSS MODAL (Feature 3: skip button)
   ══════════════════════════════════════════════ */
function showEarlyLossModal(data) {
  const modal=document.getElementById('early-loss-modal'); if (!modal) return;
  document.getElementById('early-loss-title').textContent=`${escHtml(data.bidderName)} has lost the bid!`;
  document.getElementById('early-loss-body').textContent=
    `Bid: ${data.bid} pts. Team has earned ${data.teamPtsNow} pts so far and can win at most ${data.maxPossible} pts from remaining tricks – not enough to reach the bid.`;
  const skipBtn=document.getElementById('skip-score-modal-btn');
  if (skipBtn) skipBtn.style.display=myIndex===0?'':'none'; // only host sees skip
  modal.classList.remove('hidden'); playSound('error');
}
function closeEarlyLoss() { document.getElementById('early-loss-modal').classList.add('hidden'); }

/* ══════════════════════════════════════════════
   SCORING  (Feature 5: sorted by total descending)
   ══════════════════════════════════════════════ */
function showScoringScreen(data) {
  showScreen('scoring-screen');
  document.getElementById('score-title').textContent=data.won?'🏆 Bidder\'s Team Won!':'❌ Bidder\'s Team Lost!';
  const bidderName=escHtml(data.bidderName);
  const teamNames=(data.teammates||[]).map(i=>escHtml(gameState?.players[i]?.name||`P${i+1}`)).join(' & ')||'nobody';
  const trumpLabel=data.trump===NO_TRUMP?'🚫 No Trump':data.trump?`${SUIT_SYM[data.trump]} ${SUIT_NAME[data.trump]}`:'–';

  document.getElementById('score-summary').innerHTML=`
    <strong>Round ${data.matchRound||'?'}</strong> | <strong>${bidderName}</strong> bid <strong>${data.bid}</strong>
    | Trump: ${trumpLabel} | Team: <strong>${teamNames}</strong>
    | Got <strong>${data.teamPts}</strong>/${data.bid}
    &nbsp;<span class="${data.won?'won':'lost'}">${data.won?'✅ Bid made!':'❌ Bid failed!'}</span>`;

  const history=data.roundHistory||[]; const players=gameState?.players||[]; const nR=history.length;
  const thead=document.getElementById('score-thead-row');
  if (thead) {
    let h=`<th style="text-align:left">#</th><th style="text-align:left">Player</th>`;
    for (let r=0;r<nR;r++) h+=`<th>R${r+1}</th>`;
    h+=`<th style="border-left:1px solid rgba(255,255,255,.12)">Total</th>`;
    thead.innerHTML=h;
  }

  // Feature 5: sort players by total score descending
  const sorted=players.map((p,i)=>({p,i,total:data.totalScores?.[i]??0})).sort((a,b)=>b.total-a.total);

  document.getElementById('score-body').innerHTML=sorted.map(({p,i},rank)=>{
    const isMe=i===myIndex;
    let row=`<tr class="${isMe?'me-row':''}${rank===0?' rank-1':''}">`;
    const medal=rank===0?'🥇':rank===1?'🥈':rank===2?'🥉':String(rank+1);
    row+=`<td style="text-align:center">${medal}</td>`;
    row+=`<td style="text-align:left;font-weight:600">${escHtml(p.name)}${p.isBot?' 🤖':''}${isMe?' <em>(you)</em>':''}</td>`;
    for (const rnd of history) {
      const sc=rnd.scores?.[i]??0; const cls=sc>0?'positive':sc<0?'negative':'zero';
      const latest=rnd.roundNum===nR;
      row+=`<td class="${cls}" style="${latest?'background:rgba(255,255,255,.06)':''}">${sc>=0?'+':''}${sc}</td>`;
    }
    const total=data.totalScores?.[i]??0; const tCls=total>0?'positive':total<0?'negative':'zero';
    row+=`<td class="${tCls}" style="font-weight:700;border-left:1px solid rgba(255,255,255,.12)">${total>=0?'+':''}${total}</td>`;
    return row+'</tr>';
  }).join('');

  const nextBtn=document.getElementById('next-round-btn');
  const cancelBtn=document.getElementById('cancel-score-btn');
  const waitMsg=document.getElementById('waiting-next');
  if (myIndex===0&&!isViewer) {
    nextBtn.classList.remove('hidden'); cancelBtn.classList.remove('hidden'); waitMsg.classList.add('hidden');
  } else {
    nextBtn.classList.add('hidden'); cancelBtn.classList.add('hidden'); waitMsg.classList.remove('hidden');
  }
}

function nextRound()  { socket.emit('next'); playSound('shuffle'); }
function cancelGame() {
  const rounds=gameState?(gameState.matchRound||0):0;
  if (!confirm(rounds>0?`End after ${rounds} round(s) and show final standings?`:'Cancel and return everyone to start?')) return;
  socket.emit('cancel_game');
}

/* ══════════════════════════════════════════════
   PODIUM + FIREWORKS
   ══════════════════════════════════════════════ */
socket.on('podium',data=>showPodium(data));
function showPodium(data) {
  document.querySelectorAll('.screen').forEach(s=>s.classList.add('hidden'));
  document.getElementById('podium-screen').classList.remove('hidden');
  const standings=data.standings||[], matchRounds=data.matchRounds||0;
  document.getElementById('podium-rounds').textContent=matchRounds>0?`After ${matchRounds} round${matchRounds!==1?'s':''}`:' ';
  [1,2,3].forEach(pos=>{
    const p=standings[pos-1]; const block=document.getElementById(`pod-${pos}`); if(!block) return;
    if (p) { block.querySelector('.pod-name').textContent=p.name; block.querySelector('.pod-score').textContent=(p.totalScore>=0?'+':'')+p.totalScore+' pts'; block.style.display='flex'; }
    else block.style.display='none';
  });
  const rest=document.getElementById('podium-rest'); rest.innerHTML='';
  for (let i=3;i<standings.length;i++) {
    const p=standings[i]; const div=document.createElement('div'); div.className='pod-other';
    div.innerHTML=`<strong>${escHtml(p.name)}${p.isBot?' 🤖':''}</strong>${(p.totalScore>=0?'+':'')+p.totalScore} pts`;
    rest.appendChild(div);
  }
  startFireworks();
  let secs=5; const cdEl=document.getElementById('podium-countdown');
  cdEl.textContent=`Returning to start in ${secs}s…`;
  const iv=setInterval(()=>{ secs--; if(secs<=0){clearInterval(iv);stopFireworks();_resetToStart('Thanks for playing!');}else cdEl.textContent=`Returning in ${secs}s…`; },1000);
}

let fwId=null, fwParts=[];
function startFireworks() {
  const canvas=document.getElementById('firework-canvas'); if (!canvas) return;
  const ctx=canvas.getContext('2d');
  canvas.width=window.innerWidth; canvas.height=window.innerHeight;
  const COLORS=['#f0d080','#ff6b6b','#6bffb8','#6bb8ff','#ff6bf0','#ffb86b','#fff','#88ff88'];
  function burst() {
    const x=Math.random()*canvas.width, y=Math.random()*canvas.height*.7;
    const col=COLORS[Math.floor(Math.random()*COLORS.length)];
    for (let i=0;i<60;i++) {
      const a=(Math.PI*2/60)*i, sp=2+Math.random()*5;
      fwParts.push({x,y,vx:Math.cos(a)*sp,vy:Math.sin(a)*sp,alpha:1,color:col,size:2+Math.random()*2.5,decay:.01+Math.random()*.008});
    }
  }
  let fr=0;
  function animate() {
    fwId=requestAnimationFrame(animate);
    ctx.fillStyle='rgba(0,0,0,.16)'; ctx.fillRect(0,0,canvas.width,canvas.height);
    fr++; if(fr%38===0)burst(); if(fr===1){burst();burst();burst();}
    fwParts=fwParts.filter(p=>p.alpha>.02);
    for (const p of fwParts) { p.x+=p.vx;p.y+=p.vy;p.vy+=.06;p.alpha-=p.decay;p.vx*=.98; ctx.globalAlpha=Math.max(0,p.alpha);ctx.fillStyle=p.color;ctx.beginPath();ctx.arc(p.x,p.y,p.size,0,Math.PI*2);ctx.fill(); }
    ctx.globalAlpha=1;
  }
  burst(); animate();
}
function stopFireworks() { if(fwId){cancelAnimationFrame(fwId);fwId=null;}fwParts=[]; const c=document.getElementById('firework-canvas'); if(c)c.getContext('2d').clearRect(0,0,c.width,c.height); }

function _resetToStart(msg) {
  stopFireworks(); clearSession(); myIndex=-1; myRoomId=''; myName=''; gameState=null; isViewer=false;
  document.querySelectorAll('.modal-overlay').forEach(m=>m.classList.add('hidden'));
  document.getElementById('trump-toast')?.classList.add('hidden');
  document.getElementById('podium-screen')?.classList.add('hidden');
  showScreen('login-screen');
  document.getElementById('login-error').textContent=msg||'Game over.';
}

/* ══════════════════════════════════════════════
   UTILITIES
   ══════════════════════════════════════════════ */
function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
