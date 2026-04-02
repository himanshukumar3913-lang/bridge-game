'use strict';
const SUIT_SYM={spades:'♠',hearts:'♥',diamonds:'♦',clubs:'♣'};
const SUIT_NAME={spades:'Spades',hearts:'Hearts',diamonds:'Diamonds',clubs:'Clubs'};
const RANKS_ALL=['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const SUITS_ALL=['spades','hearts','diamonds','clubs'];
const NO_TRUMP='notrump';
const BANTER=['Kaisa Laga 😏','Laanr se 💪','Duble! 🎯','Hagg diya 💩','Kaat diya ✂️','Bacha liya 😮‍💨','Sorry Babu 🙏','3ggi! ⭐','Tatti Patta 🍃','Bhak Sala 😤'];

function fullDeck50(){const d=[];for(const s of SUITS_ALL)for(const r of RANKS_ALL){if(r==='2'&&(s==='clubs'||s==='diamonds'))continue;d.push({rank:r,suit:s,id:`${r}-${s}`});}return d;}

(function initBg(){const c=document.getElementById('bg-canvas');if(!c)return;const suits=['♠','♥','♦','♣'],colors={'♠':'rgba(255,255,255,.055)','♣':'rgba(255,255,255,.045)','♥':'rgba(220,40,40,.07)','♦':'rgba(220,40,40,.06)'};for(let i=0;i<24;i++){const el=document.createElement('span');el.className='bg-suit';const s=suits[Math.floor(Math.random()*4)];el.textContent=s;el.style.cssText=`left:${Math.random()*100}%;font-size:${28+Math.random()*52}px;color:${colors[s]};animation-duration:${14+Math.random()*22}s;animation-delay:${-Math.random()*30}s`;c.appendChild(el);}})();

let _ac=null;
function getAC(){if(!_ac)_ac=new(window.AudioContext||window.webkitAudioContext)();return _ac;}
function playSound(type){try{const ctx=getAC(),g=ctx.createGain();g.connect(ctx.destination);const c={deal:{f:[320,220],d:.09,v:.1,w:'triangle'},shuffle:{f:[380,280,180],d:.06,v:.07,w:'sawtooth'},play:{f:[480,380],d:.1,v:.14,w:'sine'},trump:{f:[280,420,560],d:.15,v:.18,w:'square'},win:{f:[480,580,680,780],d:.12,v:.16,w:'sine'},error:{f:[200,150],d:.1,v:.1,w:'sawtooth'},chat:{f:[440,520],d:.08,v:.08,w:'sine'}};const cfg=c[type]||c.play;cfg.f.forEach((f,i)=>{const o=ctx.createOscillator(),e=ctx.createGain();o.connect(e);e.connect(g);o.type=cfg.w;o.frequency.setValueAtTime(f,ctx.currentTime+i*cfg.d*.8);e.gain.setValueAtTime(cfg.v,ctx.currentTime+i*cfg.d*.8);e.gain.exponentialRampToValueAtTime(.001,ctx.currentTime+(i+1)*cfg.d);o.start(ctx.currentTime+i*cfg.d*.8);o.stop(ctx.currentTime+(i+1)*cfg.d);});}catch(e){}}

const socket=io({transports:['polling','websocket'],upgrade:true,reconnection:true,reconnectionAttempts:Infinity,reconnectionDelay:1500,reconnectionDelayMax:8000,timeout:20000});
let myIndex=-1,myRoomId='',myName='',myRoomName='',gameState=null,isConnected=false,isViewer=false,earlyLossActive=false,chatOpen=false,chatUnread=0,_chatDone=false,_banterDone=false,_kickTarget=-1;

function save(){if(myRoomId&&myName&&myIndex!==-1)localStorage.setItem('bs',JSON.stringify({roomId:myRoomId,name:myName,playerIndex:myIndex}));}
function clr(){localStorage.removeItem('bs');}
function load(){try{return JSON.parse(localStorage.getItem('bs'));}catch{return null;}}
function esc(s){if(!s)return'';return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function el(id){return document.getElementById(id);}

function setConn(s){const b=el('conn-status');if(!b)return;const m={connecting:{t:'⏳ Connecting…',c:'#cc8800'},connected:{t:'🟢 Connected',c:'#44bb66'},disconnected:{t:'🔴 Connection lost…',c:'#cc3333'}};const v=m[s]||m.connecting;b.textContent=v.t;b.style.color=v.c;b.style.display='block';if(s==='connected')setTimeout(()=>{b.style.display='none';},2000);isConnected=(s==='connected');document.querySelectorAll('.btn-primary,.btn-secondary').forEach(x=>x.disabled=!isConnected);}

socket.on('connect',()=>{setConn('connected');const le=el('login-error');if(le)le.textContent='';const s=load();if(s?.roomId&&s?.name&&s?.playerIndex!==undefined){if(le)le.textContent=`Reconnecting as "${s.name}"…`;socket.emit('reconnect_player',s);}});
socket.on('connect_error',()=>setConn('disconnected'));
socket.on('disconnect',()=>setConn('disconnected'));
socket.on('reconnect_attempt',()=>setConn('connecting'));
socket.on('reconnect',()=>{setConn('connected');const s=load();if(s)socket.emit('reconnect_player',s);});

socket.on('joined',({roomId,playerIndex,name,roomName})=>{myIndex=playerIndex;myRoomId=roomId;myName=name||myName;myRoomName=roomName||'';isViewer=false;save();const rc=el('room-code-text');if(rc)rc.textContent=roomId;const le=el('login-error');if(le)le.textContent='';showScreen('lobby-screen');});
socket.on('joined_as_viewer',({roomId,name,roomName})=>{myRoomId=roomId;myName=name;myRoomName=roomName||'';isViewer=true;const rc=el('viewer-room-code');if(rc)rc.textContent=roomId;const le=el('login-error');if(le)le.textContent='';showScreen('viewer-screen');});

socket.on('err',msg=>{setMsg(msg);const le=el('login-error');if(le)le.textContent=msg;if(msg.includes('Session expired')||msg.includes('Could not restore')){const s=load();clr();myIndex=-1;myRoomId='';myName='';if(s?.name){const ni=el('name-input');if(ni)ni.value=s.name;const ri=el('room-input');if(ri&&/^\d{4}$/.test(s.roomId||''))ri.value=s.roomId;switchTab('join');const le2=el('login-error');if(le2)le2.textContent='Session expired – click Join / Watch.';}}});

socket.on('state',state=>{
  gameState=state;
  if(isViewer)renderViewer(state);else renderState(state);
  if(!_chatDone&&state.chatLog?.length>0){state.chatLog.forEach(e=>appendChat(e.name,e.msg,e.t));_chatDone=true;}
  if(!el('scorecard-modal')?.classList.contains('hidden'))buildScModal(state);
});
socket.on('msg',({text})=>setMsg(text));
socket.on('trick',r=>{setMsg(`🏆 ${r.winnerName} won trick (+${r.ptsWon} pts)`);playSound('win');});
socket.on('gameover',result=>{const delay=gameState?.autoLastTrickInProgress?7000:0;setTimeout(()=>showScoring(result),delay);});
socket.on('trump_event',d=>showTrumpToast(d));
socket.on('early_loss',d=>showEarlyLoss(d));
socket.on('podium',d=>showBarChart(d));
socket.on('illegal_deal',({playerName})=>{const eb=el('illegal-deal-body');if(eb)eb.textContent=`${playerName} holds all 4 Aces – illegal deal! Redealing in 3 seconds.`;el('illegal-deal-modal')?.classList.remove('hidden');playSound('error');setTimeout(()=>el('illegal-deal-modal')?.classList.add('hidden'),4500);});
socket.on('kicked',({reason})=>{clr();myIndex=-1;myRoomId='';myName='';gameState=null;isViewer=false;_chatDone=false;showScreen('login-screen');const le=el('login-error');if(le)le.textContent=reason||'Removed from room';});
socket.on('chat',entry=>{appendChat(entry.name,entry.msg,entry.t);if(!chatOpen){chatUnread++;el('chat-unread')?.classList.remove('hidden');}playSound('chat');});
setConn('connecting');

function showScreen(id){document.querySelectorAll('.screen').forEach(s=>s.classList.toggle('hidden',s.id!==id));}
function setMsg(t){const b=el('msg-bar');if(b)b.textContent=t;}
function switchTab(tab){['create','join'].forEach(t=>{el(`tab-${t}`)?.classList.toggle('active',t===tab);el(`pane-${t}`)?.classList.toggle('hidden',t!==tab);});}
function createRoom(){if(!isConnected){el('login-error').textContent='Still connecting…';return;}const name=(el('name-input')?.value||'').trim();const roomName=(el('room-name-input')?.value||'').trim();if(!name){el('login-error').textContent='Please enter your name.';return;}myName=name;socket.emit('create',{name,roomName});}
function joinRoom(){if(!isConnected){el('login-error').textContent='Still connecting…';return;}const name=(el('name-input')?.value||'').trim();const code=(el('room-input')?.value||'').trim().replace(/\D/g,'');if(!name){el('login-error').textContent='Please enter your name.';return;}if(!/^\d{4}$/.test(code)){el('login-error').textContent='Enter the 4-digit room code.';return;}myName=name;socket.emit('join',{roomId:code,name});}
el('name-input')?.addEventListener('keydown',e=>{if(e.key==='Enter'){if(!el('pane-join')?.classList.contains('hidden'))joinRoom();else createRoom();}});
el('room-input')?.addEventListener('keydown',e=>{if(e.key==='Enter')joinRoom();});

function copyRoomCode(){navigator.clipboard?.writeText(myRoomId).then(()=>setMsg('Copied: '+myRoomId));}
function startGame(){socket.emit('start');playSound('shuffle');}
function leaveViewer(){socket.emit('leave');clr();isViewer=false;myRoomId='';myName='';showScreen('login-screen');}
function exitGame(){const msg=gameState?.phase==='waiting'?'Leave the room?':'Exit game? Your slot opens for a new player.';if(!confirm(msg))return;socket.emit('exit_game');clr();myIndex=-1;myRoomId='';myName='';gameState=null;_chatDone=false;showScreen('login-screen');el('login-error').textContent='You exited.';}
function addNBots(n){if(!isConnected){setMsg('Not connected');return;}const cur=gameState?.players?.length||0,add=Math.min(n,5-cur);for(let i=0;i<add;i++)setTimeout(()=>socket.emit('add_bot',{name:`Bot ${cur+i+1}`}),i*180);}
function removePlayer(idx){if(!confirm(`Remove ${gameState?.players[idx]?.name||'player'}?`))return;socket.emit('remove_player',{targetIndex:idx});}
function removeBot(idx){if(!confirm('Remove this bot?'))return;socket.emit('remove_bot',{botIndex:idx});}
function cancelGame(){const r=gameState?.matchRound||0;if(!confirm(r>0?`End match after ${r} round(s)?`:'Cancel room?'))return;socket.emit('cancel_game');}

function renderLobby(state){
  showScreen('lobby-screen');
  const {players}=state,isHost=myIndex===0,allReady=players.length===5&&players.every(p=>!p.disconnected&&!p.vacated);
  const pcEl=el('player-count'),stEl=el('lobby-status');
  if(pcEl)pcEl.textContent=players.length;
  if(stEl)stEl.textContent=allReady?'All 5 ready!':`${players.length}/5 connected`;
  const nb=el('room-name-display');
  if(nb){if(myRoomName){nb.textContent='🏷 '+myRoomName;nb.classList.remove('hidden');}else nb.classList.add('hidden');}
  const icons=['🎩','🎭','🃏','🌟','🎲'],grid=el('seat-grid');if(!grid)return;grid.innerHTML='';
  for(let i=0;i<5;i++){
    const p=players[i],seat=document.createElement('div');seat.className='seat'+(p?' filled':'')+(p?.disconnected?' dc':'');
    const isBot=p?.isBot,hr=(p&&isHost&&i!==0&&!isBot)?`<button class="btn-remove" onclick="removePlayer(${i})">✕</button>`:'',br=(p&&isHost&&isBot)?`<button class="btn-remove" onclick="removeBot(${i})">✕Bot</button>`:'';
    seat.innerHTML=p?`<span class="seat-icon">${p.disconnected?'⚡':isBot?'🤖':icons[i]}</span><span class="seat-name">${esc(p.name)}</span>${i===0?'<span class="seat-tag">HOST</span>':''}${i===myIndex?'<span class="seat-tag">YOU</span>':''}${isBot?'<span class="seat-tag" style="color:#88ccff">BOT</span>':''}${p.disconnected?'<span class="seat-tag" style="color:#ff9900">Away</span>':''}${hr}${br}`:`<span class="seat-icon" style="opacity:.3">···</span><span class="seat-name" style="opacity:.3">Empty</span>`;
    grid.appendChild(seat);
  }
  const bot=el('bot-section'),slotsLeft=5-players.length;
  if(bot){if(isHost&&slotsLeft>0){bot.style.display='block';bot.innerHTML=`<div class="bot-control-box"><div class="bot-control-title">🤖 Add bots (${slotsLeft} slot${slotsLeft!==1?'s':''} free)</div><div class="bot-control-btns">${Array.from({length:slotsLeft},(_,k)=>`<button class="btn-bot" onclick="addNBots(${k+1})">+${k+1}</button>`).join('')}</div></div>`;}else{bot.style.display='none';bot.innerHTML='';}}
  const sb=el('start-btn'),lb=el('leave-btn'),cb=el('cancel-lobby-btn'),ht=el('lobby-hint');
  if(lb)lb.classList.toggle('hidden',isHost);if(cb)cb.classList.toggle('hidden',!isHost);
  if(sb){if(isHost&&allReady){sb.classList.remove('hidden');if(ht)ht.textContent='';}else{sb.classList.add('hidden');if(ht)ht.textContent=isHost?`${slotsLeft} seat${slotsLeft!==1?'s':''} empty.`:'Waiting for host…';}}
}

function renderViewer(state){
  showScreen('game-screen');renderRing(state);renderInfoStrip(state);renderTrickZone(state);renderLastTrick(state);renderTeammates(state);
  const panel=el('action-panel');if(panel)panel.innerHTML=`<p class="wait-msg">👁 Watching – ${esc(state.players[state.turnPlayer]?.name||'?')}'s turn</p>`;
  const hl=el('my-hand-label');if(hl)hl.textContent='👁 Viewer mode';
  const hr=el('my-cards-row');if(hr)hr.innerHTML='<span style="color:var(--text-dim);font-size:12px">Viewers cannot see hands</span>';
}

function renderState(state){
  if(state.phase==='waiting'){renderLobby(state);return;}
  if(state.phase==='scoring'&&!el('scoring-screen')?.classList.contains('hidden'))return;
  showScreen('game-screen');renderRing(state);renderInfoStrip(state);renderTrickZone(state);renderLastTrick(state);renderTeammates(state);renderActionPanel(state);renderHand(state);initBanterRow();
}

function renderRing(state){
  const ring=el('players-ring');if(!ring)return;ring.innerHTML='';
  state.players.forEach((p,i)=>{
    let cls='player-chip';
    if(i===myIndex)cls+=' me';if(p.isDealer)cls+=' is-dealer';
    if(i===state.currentBidder&&state.phase==='bidding')cls+=' active-turn';
    if(i===state.turnPlayer&&state.phase==='playing')cls+=' active-turn';
    if(i===state.highestBidder&&!['waiting','bidding'].includes(state.phase))cls+=' highest-bidder';
    if(p.reveal===1)cls+=' teammate-1';if(p.reveal===2)cls+=' teammate-2';
    if(state.passed?.includes(i))cls+=' passed';if(p.disconnected)cls+=' disconnected';if(p.isBot)cls+=' bot-chip';if(p.vacated)cls+=' vacated';
    const tags=[];if(p.isDealer)tags.push('🃏');if(p.isBot)tags.push('🤖');if(p.reveal===1)tags.push('🤝');if(p.reveal===2)tags.push('🤝🤝');if(state.passed?.includes(i))tags.push('pass');if(p.disconnected)tags.push('⚡');if(p.vacated)tags.push('🚪open');if(i===myIndex)tags.push('you');
    const chip=document.createElement('div');chip.className=cls;
    if(myIndex===0&&!isViewer&&i!==0&&state.phase!=='waiting'){chip.title='Long-press to kick';chip.style.cursor='pointer';let pt;chip.addEventListener('mousedown',()=>{pt=setTimeout(()=>openKickModal(i),700);});chip.addEventListener('mouseup',()=>clearTimeout(pt));chip.addEventListener('touchstart',e=>{e.preventDefault();pt=setTimeout(()=>openKickModal(i),700);},{passive:false});chip.addEventListener('touchend',()=>clearTimeout(pt));}
    chip.innerHTML=`<div class="pchip-name">${esc(p.name)}</div><div class="pchip-sub">${p.cardCount} cards</div>${(state.phase==='playing'||state.phase==='scoring')?`<div class="pchip-pts">⭐${p.trickPts}</div>`:''}${tags.length?`<div class="pchip-sub">${tags.join('·')}</div>`:''}`;
    ring.appendChild(chip);
  });
}

function renderInfoStrip(state){
  const rc=el('info-room-code');if(rc)rc.textContent=myRoomId?`🔑 ${myRoomId}`:'';
  const rn=el('info-room-name');if(rn){if(myRoomName){rn.textContent=myRoomName;rn.classList.remove('hidden');}else rn.classList.add('hidden');}
  const LABELS={bidding:'Bidding',trump:'Trump',ask:'Ask',playing:`Trick ${state.round+1}/10`,scoring:'Over'};
  const pi=el('info-phase');if(pi)pi.textContent=LABELS[state.phase]||state.phase;
  const ti=el('info-trump');if(ti)ti.textContent=state.trump?(state.trump===NO_TRUMP?'🚫 NT':`${SUIT_SYM[state.trump]}`):'';
  const bii=el('info-bid');if(bii)bii.textContent=state.highestBid>155?`${state.highestBid}`:'';
  const ri=el('info-round');
  if(state.phase==='playing'&&state.askedCardIds?.length===2){const asked=state.askedCardIds.map(id=>{const[r,s]=id.split('-');return r+SUIT_SYM[s];}).join('&');if(ri)ri.textContent=asked;}else if(ri)ri.textContent='';
  const vi=el('info-viewer'),vc=el('viewer-count');if(vi&&vc){vc.textContent=state.viewerCount||0;vi.classList.toggle('hidden',!(state.viewerCount>0));}
  const cg=el('cancel-game-btn');if(cg)cg.classList.toggle('hidden',myIndex!==0||isViewer);
}

function renderTrickZone(state){
  const row=el('trick-cards-row');if(!row)return;
  if(!state.trick||state.trick.length===0){row.innerHTML=`<span style="color:var(--text-dim);font-size:12px">Waiting…</span>`;return;}
  const key=state.trick.map(t=>t.card.id).join(',');if(row.dataset.key===key)return;row.dataset.key=key;
  let wi=state.trick[0].playerIndex;for(const t of state.trick){const w=state.trick.find(x=>x.playerIndex===wi);if(w&&cbeats(t.card,w.card,state.leadSuit,state.trump))wi=t.playerIndex;}
  row.innerHTML=state.trick.map(play=>{const name=state.players[play.playerIndex]?.name||'?';const isW=play.playerIndex===wi&&state.trick.length===5;return`<div class="trick-entry"><div class="trick-player-label">${esc(name)}</div>${cardHTML(play.card,false,true,isW?'winner':'')}</div>`;}).join('');playSound('play');
}

function cbeats(ch,cu,ls,tr){const nt=!tr||tr===NO_TRUMP;if(!nt){const cT=ch.suit===tr,wT=cu.suit===tr;if(cT&&!wT)return true;if(!cT&&wT)return false;if(cT&&wT)return RANKS_ALL.indexOf(ch.rank)>RANKS_ALL.indexOf(cu.rank);}const cL=ch.suit===ls,wL=cu.suit===ls;if(wL&&!cL)return false;if(!wL&&cL)return true;if(!wL&&!cL)return false;return RANKS_ALL.indexOf(ch.rank)>RANKS_ALL.indexOf(cu.rank);}

function renderLastTrick(state){
  const cards=el('last-trick-cards'),label=el('last-trick-winner-label');
  if(!state.lastTrick||state.lastTrick.length===0){if(cards)cards.innerHTML='<span style="font-size:10px;color:var(--text-dim)">–</span>';if(label)label.textContent='';return;}
  if(label)label.textContent=`Won: ${state.players[state.lastTrickWinner]?.name||'?'}`;
  if(cards)cards.innerHTML=state.lastTrick.map(play=>`<div class="last-trick-entry"><div class="lt-player-label">${esc(state.players[play.playerIndex]?.name||'?')}</div>${cardHTML(play.card,false,false,'mini')}</div>`).join('');
}

function renderTeammates(state){
  const list=el('teammate-list');if(!list)return;
  if(state.phase!=='playing'&&state.phase!=='scoring'){list.innerHTML='';return;}
  const rev=state.players.map((p,i)=>({...p,index:i})).filter(p=>p.reveal>0);
  if(rev.length===0){list.innerHTML='<span style="font-size:10px;color:var(--text-dim)">Not yet revealed</span>';return;}
  list.innerHTML=rev.map(p=>`<div class="teammate-entry"><div class="te-icon">${p.reveal===2?'🤝🤝':'🤝'}</div><div class="te-name">${esc(p.name)}</div><div class="te-label">${p.reveal===2?'Both cards':'Teammate'}</div></div>`).join('');
}

function renderActionPanel(state){
  const panel=el('action-panel');if(!panel)return;
  switch(state.phase){case 'bidding':renderBidding(panel,state);break;case 'trump':renderTrump(panel,state);break;case 'ask':renderAsk(panel,state);break;case 'playing':renderPlaying(panel,state);break;default:panel.innerHTML='';}
}

function renderBidding(panel,state){
  const isMyTurn=state.currentBidder===myIndex,iPassed=state.passed?.includes(myIndex);
  if(isMyTurn&&!iPassed){const min=state.highestBid<160?160:state.highestBid+5;panel.innerHTML=`<div class="bid-row"><div style="text-align:center;font-size:13px;color:var(--text-dim)">Highest: <strong style="color:var(--gold-light)">${state.highestBid>155?state.highestBid:'none'}</strong></div><div class="bid-slider-wrap"><span style="font-size:12px;color:var(--text-dim)">Bid:</span><input type="range" id="bid-slider" min="${min}" max="290" step="5" value="${min}" oninput="el('bvs').textContent=this.value;el('bvb').textContent=this.value"><span class="bid-val" id="bvs">${min}</span></div><div class="bid-actions"><button class="btn-primary" onclick="doBid()" style="flex:2">Bid <span id="bvb">${min}</span></button><button class="btn-pass" onclick="doPass()">✋ Pass</button></div></div>`;}
  else{const bidder=state.players[state.currentBidder]?.name||'?';panel.innerHTML=`<p class="wait-msg">${iPassed?'✋ You passed. ':''}Waiting for <strong>${esc(bidder)}</strong>${state.players[state.currentBidder]?.isBot?' 🤖':''} to bid…</p>`;}
  if(state.bidLog?.length){const last5=state.bidLog.slice(-5).map(b=>`${esc(state.players[b.p]?.name||'?')}:${b.a==='pass'?'✋':b.a}`).join(' | ');panel.insertAdjacentHTML('beforeend',`<p style="font-size:11px;color:var(--text-dim);margin-top:5px;text-align:center">${last5}</p>`);}
}

function renderTrump(panel,state){
  if(state.highestBidder===myIndex){panel.innerHTML=`<div style="text-align:center;margin-bottom:8px;font-size:13px;color:var(--text-dim)">You won bid <strong style="color:var(--gold-light)">${state.highestBid}</strong>. Choose trump:</div><div class="trump-options-row"><div class="suit-opt" onclick="doTrump('spades')"><span class="suit-sym">♠</span>Spades</div><div class="suit-opt red" onclick="doTrump('hearts')"><span class="suit-sym">♥</span>Hearts</div><div class="suit-opt red" onclick="doTrump('diamonds')"><span class="suit-sym">♦</span>Diamonds</div><div class="suit-opt" onclick="doTrump('clubs')"><span class="suit-sym">♣</span>Clubs</div><div class="suit-opt notrump" onclick="doTrump('notrump')"><span class="suit-sym">🚫</span>No Trump</div></div>`;}
  else{const b=state.players[state.highestBidder]?.name||'?';panel.innerHTML=`<p class="wait-msg">Waiting for <strong>${esc(b)}</strong>${state.players[state.highestBidder]?.isBot?' 🤖':''} to choose trump…</p>`;}
}

function renderAsk(panel,state){
  const tl=state.trump===NO_TRUMP?'🚫 No Trump':`${SUIT_SYM[state.trump]||''} ${SUIT_NAME[state.trump]||''}`;
  if(state.highestBidder===myIndex){panel.innerHTML=`<div style="text-align:center"><p style="font-size:14px;margin-bottom:8px">${tl} | 10 cards.<br><span style="color:var(--text-dim);font-size:12px">Ask 2 cards not in your hand.</span></p><button class="btn-primary" style="max-width:280px" onclick="openAskModal()">🃏 Select 2 Cards</button></div>`;}
  else{const b=state.players[state.highestBidder]?.name||'?';panel.innerHTML=`<p class="wait-msg">Waiting for <strong>${esc(b)}</strong>${state.players[state.highestBidder]?.isBot?' 🤖':''} to ask…</p>`;}
}

function renderPlaying(panel,state){
  if(state.autoLastTrickInProgress){panel.innerHTML='<p class="turn-msg">🃏 Auto-playing last trick…</p>';return;}
  if(state.turnPlayer===myIndex){panel.innerHTML=`<p class="turn-msg">▶ Your turn! Tap a card.</p>${state.leadSuit?`<p class="lead-info">Lead: ${SUIT_SYM[state.leadSuit]} ${state.leadSuit} – ${state.myCards?.some(c=>c.suit===state.leadSuit)?'follow suit':'play anything'}</p>`:''}`;}
  else{const whose=state.players[state.turnPlayer]?.name||'?',dc=state.players[state.turnPlayer]?.disconnected,bot=state.players[state.turnPlayer]?.isBot;panel.innerHTML=`<p class="wait-msg">Waiting for <strong>${esc(whose)}</strong>${bot?' 🤖':''}${dc?' ⚡':''} to play…</p>`;}
}

function renderHand(state){
  const myCards=state.myCards||[],hc=el('hand-count');if(hc)hc.textContent=`(${myCards.length})`;
  const row=el('my-cards-row');if(!row)return;
  const canPlay=state.phase==='playing'&&state.turnPlayer===myIndex&&!state.autoLastTrickInProgress;
  row.innerHTML=myCards.map(card=>{const html=cardHTML(card,!canPlay,false);return canPlay?`<div onclick="doPlay('${card.id}')" style="display:contents">${html}</div>`:html;}).join('');
  if(canPlay)row.querySelectorAll('.card').forEach(e=>e.classList.add('playable'));
  if(myCards.length!==parseInt(row.dataset.pc||'0')){playSound('deal');row.dataset.pc=String(myCards.length);}
}

function cardHTML(card,disabled=false,isTrick=false,extra=''){
  const isRed=card.suit==='hearts'||card.suit==='diamonds',is3s=card.rank==='3'&&card.suit==='spades';
  let cls='card';if(isRed)cls+=' red';if(disabled)cls+=' disabled';if(isTrick)cls+=' trick';if(extra)cls+=` ${extra}`;
  const sym=SUIT_SYM[card.suit];
  return `<div class="${cls}">${is3s?'<span class="c-special">★30</span>':''}<div class="c-tl"><div class="c-rank">${card.rank}</div><div class="c-suit">${sym}</div></div><div class="c-center-big">${sym}</div></div>`;
}

function doBid(){const s=el('bid-slider');if(!s)return;socket.emit('bid',{amount:parseInt(s.value,10)});}
function doPass(){socket.emit('bid',{amount:'pass'});}
function doTrump(suit){socket.emit('trump',{suit});}
function doPlay(cardId){socket.emit('play',{cardId});}
function skipToScore(){socket.emit('skip_to_score');closeEarlyLoss();}
function nextRound(){socket.emit('next');playSound('shuffle');}

function openAskModal(){
  window._askSel=[];const myIds=new Set((gameState?.myCards||[]).map(c=>c.id));
  const deck=fullDeck50(),bySuit={spades:[],hearts:[],diamonds:[],clubs:[]};deck.forEach(c=>bySuit[c.suit].push(c));
  let html='';for(const suit of SUITS_ALL){const isRed=suit==='hearts'||suit==='diamonds';html+=`<div class="ask-suit-block"><div class="ask-suit-label">${SUIT_SYM[suit]} ${SUIT_NAME[suit]}</div><div class="ask-cards-row">${bySuit[suit].map(card=>{const ih=myIds.has(card.id);return`<div id="amc-${card.id}" class="ask-modal-card ${isRed?'red':''} ${ih?'in-hand':''}" onclick="${ih?'':` toggleAsk('${card.id}')`}"><div class="amc-rank">${card.rank}</div><div class="amc-suit">${SUIT_SYM[suit]}</div></div>`;}).join('')}</div></div>`;}
  el('ask-suits').innerHTML=html;el('ask-count-label').textContent='0 / 2 selected';el('ask-confirm-btn').disabled=true;el('ask-modal').classList.remove('hidden');
}
function toggleAsk(id){if(!window._askSel)window._askSel=[];const sel=window._askSel,e2=el(`amc-${id}`);if(!e2)return;if(sel.includes(id)){window._askSel=sel.filter(c=>c!==id);e2.classList.remove('selected');}else if(sel.length<2){sel.push(id);e2.classList.add('selected');}else{const old=sel.shift();el(`amc-${old}`)?.classList.remove('selected');sel.push(id);e2.classList.add('selected');}el('ask-count-label').textContent=`${sel.length} / 2 selected`;el('ask-confirm-btn').disabled=sel.length!==2;}
function confirmAsk(){const s=window._askSel||[];if(s.length!==2)return;socket.emit('ask',{cardIds:[...s]});closeAskModal();}
function closeAskModal(){el('ask-modal')?.classList.add('hidden');}

function openScorecardModal(){buildScModal(gameState);el('scorecard-modal')?.classList.remove('hidden');}
function closeScorecardModal(){el('scorecard-modal')?.classList.add('hidden');}
function buildScModal(state){
  if(!state)return;const players=state.players||[],history=state.roundHistory||[],nR=history.length;
  const thead=el('sc-modal-thead'),tbody=el('sc-modal-body');if(!thead||!tbody)return;
  let h=`<th style="text-align:left">#</th><th style="text-align:left">Player</th>`;h+=`<th style="background:rgba(240,208,80,.1);border-right:1px solid rgba(255,255,255,.12)">Total</th>`;h+=`<th style="background:rgba(100,200,100,.08)">Pts Won</th>`;for(let r=0;r<nR;r++)h+=`<th>R${r+1}</th>`;thead.innerHTML=h;
  const totals=nR>0?(history[nR-1].totals||{}):state.totalScores||{};
  const sorted=players.map((p,i)=>({p,i,total:totals[i]??0})).sort((a,b)=>b.total-a.total);
  tbody.innerHTML=sorted.map(({p,i},rank)=>{const total=totals[i]??0,tCls=total>0?'positive':total<0?'negative':'zero',ptsTaken=state.sessionTrickPts?.[i]??0,isMe=i===myIndex;let row=`<tr class="${isMe?'me-row':''}${rank===0?' rank-1':''}">`;const medal=['🥇','🥈','🥉','4','5'][rank]||`${rank+1}`;row+=`<td style="text-align:center">${medal}</td>`;row+=`<td style="text-align:left;font-weight:600">${esc(p.name)}${p.isBot?' 🤖':''}${isMe?' <em>(you)</em>':''}</td>`;row+=`<td class="${tCls}" style="font-weight:800;background:rgba(240,208,80,.05);border-right:1px solid rgba(255,255,255,.12)">${total>=0?'+':''}${total}</td>`;row+=`<td style="color:#88ccff;font-weight:600">${ptsTaken}</td>`;for(const rnd of history){const sc=rnd.scores?.[i]??0,cls2=sc>0?'positive':sc<0?'negative':'zero';row+=`<td class="${cls2}">${sc>=0?'+':''}${sc}</td>`;}return row+'</tr>';}).join('');
}

function openKickModal(targetIdx){
  _kickTarget=targetIdx;const name=gameState?.players[targetIdx]?.name||'player';
  const body=el('kick-modal-body');if(body)body.textContent=`Remove "${name}" from the game? They will be replaced by a bot (cards preserved).`;
  const btn=el('kick-confirm-btn');if(btn)btn.onclick=()=>{socket.emit('host_kick',{targetIndex:_kickTarget});closeKickModal();};
  el('kick-modal')?.classList.remove('hidden');
}
function closeKickModal(){el('kick-modal')?.classList.add('hidden');}

let _toastTimer=null;
function showTrumpToast(data){const t=el('trump-toast');if(!t)return;const sym=data.card?.suit&&data.card.suit!==NO_TRUMP?SUIT_SYM[data.card.suit]:'';t.textContent=data.type==='trump_played'?`🃏 ${data.playerName} plays trump! ${data.card?.rank||''}${sym}`:`⬆️ ${data.playerName} plays higher trump! ${data.card?.rank||''}${sym}`;t.classList.remove('hidden');playSound('trump');if(_toastTimer)clearTimeout(_toastTimer);_toastTimer=setTimeout(()=>t.classList.add('hidden'),3000);}

function showEarlyLoss(data){earlyLossActive=true;const m=el('early-loss-modal');if(!m)return;el('early-loss-title').textContent=`${esc(data.bidderName)} has lost the bid!`;el('early-loss-body').textContent=`Bid: ${data.bid} pts. Team has ${data.teamPtsNow} pts, max possible is ${data.maxPossible} pts.`;const sb=el('skip-score-modal-btn');if(sb)sb.style.display=myIndex===0?'block':'none';m.classList.remove('hidden');playSound('error');}
function closeEarlyLoss(){el('early-loss-modal')?.classList.add('hidden');}

function showScoring(data){
  earlyLossActive=false;showScreen('scoring-screen');
  el('score-title').textContent=data.won?'🏆 Bidder\'s Team Won!':'❌ Bidder\'s Team Lost!';
  const bidderName=esc(data.bidderName),teamNames=(data.teammates||[]).map(i=>esc(gameState?.players[i]?.name||`P${i+1}`)).join(' & ')||'nobody',trumpLabel=data.trump===NO_TRUMP?'🚫 No Trump':data.trump?`${SUIT_SYM[data.trump]} ${SUIT_NAME[data.trump]}`:'–';
  el('score-summary').innerHTML=`<strong>Round ${data.matchRound||'?'}</strong> | <strong>${bidderName}</strong> bid <strong>${data.bid}</strong> | Trump: ${trumpLabel} | Team: <strong>${teamNames}</strong> | Got <strong>${data.teamPts}</strong>/${data.bid} &nbsp;<span class="${data.won?'won':'lost'}">${data.won?'✅ Bid made!':'❌ Bid failed!'}</span>`;
  const history=data.roundHistory||[],players=gameState?.players||[],nR=history.length,thead=el('score-thead-row');
  if(thead){let h=`<th style="text-align:left">#</th><th style="text-align:left">Player</th>`;h+=`<th style="background:rgba(240,208,80,.08);border-right:1px solid rgba(255,255,255,.15)">Total</th>`;h+=`<th style="background:rgba(100,200,100,.06)">Pts Won</th>`;for(let r=0;r<nR;r++)h+=`<th>R${r+1}</th>`;thead.innerHTML=h;}
  const sorted=players.map((p,i)=>({p,i,total:data.totalScores?.[i]??0})).sort((a,b)=>b.total-a.total);
  el('score-body').innerHTML=sorted.map(({p,i},rank)=>{const total=data.totalScores?.[i]??0,tCls=total>0?'positive':total<0?'negative':'zero',ptsTaken=data.sessionTrickPts?.[i]??0,isMe=i===myIndex;let row=`<tr class="${isMe?'me-row':''}${rank===0?' rank-1':''}">`;const medal=['🥇','🥈','🥉','4','5'][rank]||`${rank+1}`;row+=`<td style="text-align:center">${medal}</td>`;row+=`<td style="text-align:left;font-weight:600">${esc(p.name)}${p.isBot?' 🤖':''}${isMe?' <em>(you)</em>':''}</td>`;row+=`<td class="${tCls}" style="font-weight:800;background:rgba(240,208,80,.05);border-right:1px solid rgba(255,255,255,.15)">${total>=0?'+':''}${total}</td>`;row+=`<td style="color:#88ccff;font-weight:600">${ptsTaken}</td>`;for(const rnd of history){const sc=rnd.scores?.[i]??0,cls2=sc>0?'positive':sc<0?'negative':'zero',latest=rnd.roundNum===nR;row+=`<td class="${cls2}" style="${latest?'background:rgba(255,255,255,.05)':''}">${sc>=0?'+':''}${sc}</td>`;}return row+'</tr>';}).join('');
  const nb=el('next-round-btn'),cb=el('cancel-score-btn'),wm=el('waiting-next');
  if(myIndex===0&&!isViewer){nb?.classList.remove('hidden');cb?.classList.remove('hidden');wm?.classList.add('hidden');}else{nb?.classList.add('hidden');cb?.classList.add('hidden');wm?.classList.remove('hidden');}
}

function showBarChart(data){
  document.querySelectorAll('.screen').forEach(s=>s.classList.add('hidden'));el('podium-screen').classList.remove('hidden');
  const standings=data.standings||[],matchRounds=data.matchRounds||0;
  el('podium-title').textContent='🏆 Final Standings'+(data.roomName?` – ${data.roomName}`:'');
  el('podium-rounds').textContent=matchRounds>0?`After ${matchRounds} round${matchRounds!==1?'s':''}`:' ';
  const stage=el('podium-stage');stage.innerHTML='';stage.style.cssText='display:flex;align-items:flex-end;gap:10px;z-index:2;margin-bottom:16px;padding:0 12px;';
  el('podium-rest').innerHTML='';if(!standings.length){_resetToStart('No scores yet.');return;}
  const maxAbs=Math.max(1,...standings.map(s=>Math.abs(s.totalScore))),MAX_BAR=140,MIN_BAR=20;
  const COLORS=['#f0d080','#c0c0c0','#cd7f32','#88ccff','#88ff99'],MEDALS=['🥇','🥈','🥉','',''];
  if(!el('bar-kf')){const s=document.createElement('style');s.id='bar-kf';s.textContent='@keyframes bar-rise{from{transform:scaleY(0) translateY(20px);opacity:0}to{transform:scaleY(1) translateY(0);opacity:1}}@keyframes bar-glow{from{filter:brightness(1)}to{filter:brightness(1.35)}}';document.head.appendChild(s);}
  standings.forEach((player,rank)=>{const col=COLORS[rank]||'#aaa',barH=Math.max(MIN_BAR,Math.round(MAX_BAR*Math.abs(player.totalScore)/maxAbs)),scoreLabel=(player.totalScore>=0?'+':'')+player.totalScore+' pts',isNeg=player.totalScore<0,block=document.createElement('div');block.style.cssText=`display:flex;flex-direction:column;align-items:center;flex:1;max-width:90px;animation:bar-rise .7s cubic-bezier(0.34,1.2,0.64,1) ${rank*.15}s both`;block.innerHTML=`<div style="font-family:'DM Sans',sans-serif;font-size:12px;color:${col};font-weight:700;margin-bottom:4px">${scoreLabel}</div><div style="font-family:'Playfair Display',serif;font-size:13px;color:${col};text-align:center;margin-bottom:6px;text-shadow:0 0 10px ${col};max-width:80px;word-break:break-word">${esc(player.name)}${player.isBot?' 🤖':''}</div><div style="font-size:22px;margin-bottom:6px">${MEDALS[rank]||''}</div><div style="width:100%;height:${barH}px;background:linear-gradient(180deg,${col} 0%,${isNeg?'rgba(255,80,80,.3)':'rgba(0,0,0,.3)'} 100%);border-radius:6px 6px 0 0;border:1px solid rgba(255,255,255,.15);box-shadow:0 0 16px ${col}44;animation:bar-glow 2s ease-in-out ${rank*.15+.7}s infinite alternate"></div><div style="font-size:10px;color:rgba(255,255,255,.4);margin-top:4px">${rank+1}</div>`;stage.appendChild(block);});
  startFireworks();let secs=8;const cdEl=el('podium-countdown');cdEl.textContent=`Returning in ${secs}s…`;const iv=setInterval(()=>{secs--;if(secs<=0){clearInterval(iv);stopFireworks();_resetToStart('Thanks for playing!');}else cdEl.textContent=`Returning in ${secs}s…`;},1000);
}

let fwId=null,fwParts=[];
function startFireworks(){const canvas=el('firework-canvas');if(!canvas)return;const ctx=canvas.getContext('2d');canvas.width=window.innerWidth;canvas.height=window.innerHeight;const COLS=['#f0d080','#ff6b6b','#6bffb8','#6bb8ff','#ff6bf0','#fff','#88ff99'];function burst(){const x=Math.random()*canvas.width,y=Math.random()*canvas.height*.7,col=COLS[Math.floor(Math.random()*COLS.length)];for(let i=0;i<60;i++){const a=(Math.PI*2/60)*i,sp=2+Math.random()*5;fwParts.push({x,y,vx:Math.cos(a)*sp,vy:Math.sin(a)*sp,alpha:1,color:col,size:2+Math.random()*2.5,decay:.01+Math.random()*.008});}}let fr=0;function animate(){fwId=requestAnimationFrame(animate);ctx.fillStyle='rgba(0,0,0,.16)';ctx.fillRect(0,0,canvas.width,canvas.height);fr++;if(fr%38===0)burst();if(fr===1){burst();burst();burst();}fwParts=fwParts.filter(p=>p.alpha>.02);for(const p of fwParts){p.x+=p.vx;p.y+=p.vy;p.vy+=.06;p.alpha-=p.decay;p.vx*=.98;ctx.globalAlpha=Math.max(0,p.alpha);ctx.fillStyle=p.color;ctx.beginPath();ctx.arc(p.x,p.y,p.size,0,Math.PI*2);ctx.fill();}ctx.globalAlpha=1;}burst();animate();}
function stopFireworks(){if(fwId){cancelAnimationFrame(fwId);fwId=null;}fwParts=[];const c=el('firework-canvas');if(c)c.getContext('2d').clearRect(0,0,c.width,c.height);}
function _resetToStart(msg){stopFireworks();clr();myIndex=-1;myRoomId='';myName='';gameState=null;isViewer=false;earlyLossActive=false;_chatDone=false;document.querySelectorAll('.modal-overlay').forEach(m=>m.classList.add('hidden'));el('trump-toast')?.classList.add('hidden');el('podium-screen')?.classList.add('hidden');showScreen('login-screen');const le=el('login-error');if(le)le.textContent=msg||'Game over.';}

function initBanterRow(){if(_banterDone)return;const btns=el('banter-btns');if(!btns)return;btns.innerHTML=BANTER.map(b=>`<button class="banter-btn" onclick="sendBanter(${JSON.stringify(b)})">${b}</button>`).join('');_banterDone=true;}
function toggleChat(){chatOpen=!chatOpen;el('chat-body')?.classList.toggle('hidden',!chatOpen);const tl=el('chat-toggle-label');if(tl)tl.textContent=chatOpen?'▼ close':'▲ open';if(chatOpen){chatUnread=0;el('chat-unread')?.classList.add('hidden');}}
function appendChat(name,msg,t){const box=el('chat-messages');if(!box)return;const time=t?new Date(t).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):'';const div=document.createElement('div');div.className='chat-msg'+(name===myName?' chat-mine':'');div.innerHTML=`<span class="chat-name">${esc(name)}</span> <span class="chat-text">${esc(msg)}</span> <span class="chat-time">${time}</span>`;box.appendChild(div);box.scrollTop=box.scrollHeight;if(box.children.length>60)box.removeChild(box.firstChild);}
function sendChat(){const inp=el('chat-input');if(!inp)return;const msg=inp.value.trim();if(!msg)return;socket.emit('chat',{message:msg});inp.value='';}
function sendBanter(msg){socket.emit('chat',{message:msg});}
el('chat-input')?.addEventListener('keydown',e=>{if(e.key==='Enter')sendChat();});
