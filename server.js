/**
 * Bridge Card Game – Server
 * Bugs fixed: auto-pass timer, scheduleBotTrump illegal deal, room-not-found
 * New: host kick mid-game, total pts taken, room name, chat/banter, session CSV log
 */

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const fs      = require('fs');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors:{origin:'*',methods:['GET','POST']},
  transports:['polling','websocket'],
  allowUpgrades:true, pingTimeout:60000, pingInterval:25000, connectTimeout:45000,
});

app.use(express.static(path.join(__dirname,'public')));
app.get('/health',(_,res)=>res.send('OK'));
// BUG FIX 3: explicit ping endpoint for UptimeRobot / cron keep-alive
// Point a free monitor at https://your-app.onrender.com/ping every 5 minutes
// to prevent Render free tier from sleeping and losing in-memory game state
app.get('/ping',(_,res)=>res.json({status:'alive',rooms:Object.keys(games).length,ts:Date.now()}));

// Session log file (CSV)
const LOG_FILE = path.join(__dirname,'sessions.csv');
if (!fs.existsSync(LOG_FILE)) {
  fs.writeFileSync(LOG_FILE,
    'Date,RoomCode,RoomName,StartTime,EndTime,DurationMin,Players,IPs,FinalScores,TotalPtsTaken\n'
  );
}
function appendSessionLog(game, endTime) {
  try {
    const start   = new Date(game._startTime||Date.now());
    const end     = new Date(endTime);
    const dur     = Math.round((end-start)/60000);
    const players = game.players.map(p=>p.name).join('|');
    const ips     = game.players.map(p=>p.ip||'unknown').join('|');
    const scores  = game.players.map((_,i)=>game.totalScores[i]||0).join('|');
    const ptstaken= game.players.map((_,i)=>game.sessionTrickPts[i]||0).join('|');
    const row = [
      start.toISOString().split('T')[0],
      game.roomId,
      (game.roomName||'').replace(/,/g,';'),
      start.toISOString(),
      end.toISOString(),
      dur, players, ips, scores, ptstaken,
    ].join(',');
    fs.appendFileSync(LOG_FILE, row+'\n');
  } catch(e) { console.error('Log error:',e.message); }
}

// Download log endpoint (host only – just a password-less download; protect with Render env var if needed)
app.get('/download-log', (req,res)=>{
  if (!fs.existsSync(LOG_FILE)) { res.send('No sessions yet'); return; }
  res.download(LOG_FILE,'bridge-sessions.csv');
});

// ══════════════════════════════════════════════════════
//  CARD SYSTEM
// ══════════════════════════════════════════════════════

const SUITS     = ['spades','hearts','diamonds','clubs'];
const RANKS     = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const SUIT_SYMS = { spades:'♠', hearts:'♥', diamonds:'♦', clubs:'♣' };
const NO_TRUMP  = 'notrump';

function createDeck() {
  const deck=[];
  for (const suit of SUITS)
    for (const rank of RANKS) {
      if (rank==='2'&&(suit==='clubs'||suit==='diamonds')) continue;
      deck.push({rank,suit,id:`${rank}-${suit}`});
    }
  return deck;
}

function shuffle(arr) {
  const a=[...arr];
  for (let i=a.length-1;i>0;i--) {
    const j=Math.floor(Math.random()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}

function rankIndex(rank) { return RANKS.indexOf(rank); }
function suitIndex(suit) { return SUITS.indexOf(suit); }

function cardPoints(card) {
  if (card.rank==='A') return 20;
  if (['K','Q','J','10'].includes(card.rank)) return 10;
  if (card.rank==='5') return 5;
  if (card.rank==='3'&&card.suit==='spades') return 30;
  return 0;
}

function beats(challenger, current, leadSuit, trump) {
  const isNoTrump=!trump||trump===NO_TRUMP;
  if (!isNoTrump) {
    const cT=challenger.suit===trump, wT=current.suit===trump;
    if (cT&&!wT) return true;
    if (!cT&&wT) return false;
    if (cT&&wT) return rankIndex(challenger.rank)>rankIndex(current.rank);
  }
  const cL=challenger.suit===leadSuit, wL=current.suit===leadSuit;
  if (wL&&!cL) return false;
  if (!wL&&cL) return true;
  if (!wL&&!cL) return false;
  return rankIndex(challenger.rank)>rankIndex(current.rank);
}

function sortCards(cards) {
  return [...cards].sort((a,b)=>{
    const sd=suitIndex(a.suit)-suitIndex(b.suit);
    return sd!==0?sd:rankIndex(b.rank)-rankIndex(a.rank);
  });
}

function totalRemainingPts(players) {
  let pts=0;
  for (const p of players) for (const c of p.cards) pts+=cardPoints(c);
  return pts;
}

// ══════════════════════════════════════════════════════
//  BOT AI
// ══════════════════════════════════════════════════════

function botChooseBid(hand, currentHighest) {
  const handPts    = hand.reduce((s,c)=>s+cardPoints(c),0);
  const aces       = hand.filter(c=>c.rank==='A').length;
  const highCount  = hand.filter(c=>['A','K','Q'].includes(c.rank)).length;
  const has3Spades = hand.some(c=>c.rank==='3'&&c.suit==='spades');
  const fullEst    = handPts*(10/6);
  const teamEst    = fullEst+(290-fullEst)*0.40;
  const bonus      = aces*18+(highCount-aces)*6+(has3Spades?20:0);
  const raw        = Math.round((teamEst*0.90+bonus)/5)*5;
  const bid        = Math.max(160,Math.min(290,raw));
  if (bid<=currentHighest) return 'pass';
  return bid;
}

function botChooseTrump(hand) {
  const suitScore={spades:0,hearts:0,diamonds:0,clubs:0};
  const suitCount={spades:0,hearts:0,diamonds:0,clubs:0};
  for (const c of hand) { suitScore[c.suit]+=cardPoints(c); suitCount[c.suit]++; }
  for (const s of SUITS) {
    if (suitCount[s]>=3) suitScore[s]+=12;
    if (hand.some(c=>c.suit===s&&c.rank==='A')) suitScore[s]+=15;
  }
  return SUITS.reduce((best,s)=>suitScore[s]>suitScore[best]?s:best,'spades');
}

function botChooseAsk(hand) {
  const myIds=new Set(hand.map(c=>c.id));
  const notMine=createDeck().filter(c=>!myIds.has(c.id)).sort((a,b)=>{
    const a3s=(a.rank==='3'&&a.suit==='spades')?1:0;
    const b3s=(b.rank==='3'&&b.suit==='spades')?1:0;
    if (a3s!==b3s) return b3s-a3s;
    return cardPoints(b)-cardPoints(a)||rankIndex(b.rank)-rankIndex(a.rank);
  });
  return [notMine[0].id, notMine[1].id];
}

function botChooseCard(hand,trick,leadSuit,trump,isOnBiddingTeam,teamPtsNow,bid,teammates,myIdx,players,playedCards,askedCards) {
  const isNoTrump=!trump||trump===NO_TRUMP;
  const followable=leadSuit?hand.filter(c=>c.suit===leadSuit):[];
  const pool=followable.length>0?followable:hand;
  let currentWinner=trick.length>0?trick[0]:null;
  for (const t of trick) if (beats(t.card,currentWinner.card,leadSuit,trump)) currentWinner=t;
  const teammateWinning=currentWinner&&(currentWinner.playerIndex===myIdx||teammates.includes(currentWinner.playerIndex));

  function beaters(p) {
    if (!currentWinner) return p;
    return p.filter(c=>beats(c,currentWinner.card,leadSuit,trump)).sort((a,b)=>rankIndex(a.rank)-rankIndex(b.rank));
  }
  function lowest(p) { return [...p].sort((a,b)=>cardPoints(a)-cardPoints(b)||rankIndex(a.rank)-rankIndex(b.rank))[0]; }
  function highest(p){ return [...p].sort((a,b)=>cardPoints(b)-cardPoints(a)||rankIndex(b.rank)-rankIndex(a.rank))[0]; }

  // Protect asked high-value cards
  if (isOnBiddingTeam&&askedCards.length>0) {
    for (const asked of askedCards.filter(a=>cardPoints(a)>=20)) {
      if (trick.some(t=>t.card.id===asked.id)&&!teammateWinning) {
        const safe=beaters(pool); if (safe.length>0) return safe[0];
      }
    }
  }

  if (isOnBiddingTeam) {
    if (teamPtsNow>=bid) return lowest(pool);
    const askedInTrick=trick.some(t=>askedCards.some(a=>a.id===t.card.id));
    if (askedInTrick&&teammateWinning) return highest(pool);
    if (teammateWinning&&trick.length<4) return lowest(pool);
    const min=beaters(pool); if (min.length>0) return min[0];
    if (!isNoTrump&&followable.length===0) {
      const tr=hand.filter(c=>c.suit===trump).sort((a,b)=>rankIndex(a.rank)-rankIndex(b.rank));
      if (tr.length>0) return tr[0];
    }
    return highest(pool);
  } else {
    const askedInTrick=trick.some(t=>askedCards.some(a=>a.id===t.card.id));
    if (askedInTrick&&!teammateWinning) { const g=beaters(pool); if (g.length>0) return g[0]; }
    if (teammateWinning) { return trick.reduce((s,t)=>s+cardPoints(t.card),0)>0?highest(pool):lowest(pool); }
    return lowest(pool);
  }
}

// ══════════════════════════════════════════════════════
//  GAME CLASS
// ══════════════════════════════════════════════════════

class Game {
  constructor(roomId, roomName='') {
    this.roomId   = roomId;
    this.roomName = roomName;
    this.players  = [];
    this.viewers  = [];
    this.phase    = 'waiting';
    this.dealer   = 0;
    this.deck     = [];
    this._startTime= null;

    this.currentBidder=0; this.highestBid=155; this.highestBidder=-1;
    this.passed=new Set(); this.bidLog=[];
    this.trump=null; this.askedCards=[]; this.teammates=[]; this.reveal={};
    this.round=0; this.turnPlayer=0; this.trick=[]; this.leadSuit=null;
    this.lastTrick=[]; this.lastTrickWinner=-1; this.trickPts={};
    this.earlyLossShown=false; this.autoLastTrickInProgress=false;
    this.playedCards=new Set();

    this.roundScores={}; this.totalScores={}; this.sessionTrickPts={};
    this.lastGameover=null; this.roundHistory=[]; this.matchRound=0;
    this._autoBidTimers={};
    this.chatLog=[];
  }

  // ── Player management ──

  addPlayer(socketId, name, isBot=false, ip='unknown') {
    if (this.players.length>=5) return -1;
    const idx=this.players.length;
    this.players.push({socketId,name,cards:[],disconnected:false,lastSeen:Date.now(),isBot,ip});
    this.trickPts[idx]=0; this.roundScores[idx]=0;
    this.totalScores[idx]=this.totalScores[idx]||0;
    this.sessionTrickPts[idx]=this.sessionTrickPts[idx]||0;
    this.reveal[idx]=0;
    return idx;
  }

  addBot(name) { return this.addPlayer(null,name||`Bot${this.players.length+1}`,true,'bot'); }

  addViewer(socketId, name) {
    if (this.viewers.length>=5) return false;
    this.viewers.push({socketId,name}); return true;
  }
  removeViewer(sid) { this.viewers=this.viewers.filter(v=>v.socketId!==sid); }

  reconnectPlayer(socketId, name, playerIndex) {
    let idx=-1;
    if (playerIndex>=0&&playerIndex<this.players.length&&this.players[playerIndex].name===name) idx=playerIndex;
    if (idx===-1) idx=this.players.findIndex(p=>p.name===name&&!p.vacated);
    if (idx===-1) return -1;
    const p=this.players[idx];
    p.socketId=socketId; p.disconnected=false; p.lastSeen=Date.now();
    // BUG FIX 1: cancel any pending auto-pass timer for this player
    if (this._autoBidTimers[idx]) {
      clearTimeout(this._autoBidTimers[idx]);
      delete this._autoBidTimers[idx];
    }
    // Clear bot-bid chain lock so it can resume if needed
    this._botBidActive=false;
    return idx;
  }

  markDisconnected(playerIndex) {
    const p=this.players[playerIndex];
    if (p) { p.disconnected=true; p.lastSeen=Date.now(); p.socketId=null; }
  }

  removePlayer(targetIdx) {
    if (this.phase!=='waiting') return null;
    if (targetIdx===0||targetIdx<0||targetIdx>=this.players.length) return null;
    const removed=this.players[targetIdx];
    this.players.splice(targetIdx,1);
    for (let i=targetIdx;i<this.players.length;i++) {
      this.trickPts[i]=this.trickPts[i+1]||0;
      this.roundScores[i]=this.roundScores[i+1]||0;
      this.totalScores[i]=this.totalScores[i+1]||0;
      this.sessionTrickPts[i]=this.sessionTrickPts[i+1]||0;
      this.reveal[i]=this.reveal[i+1]||0;
    }
    const last=this.players.length;
    delete this.trickPts[last]; delete this.roundScores[last];
    delete this.totalScores[last]; delete this.sessionTrickPts[last]; delete this.reveal[last];
    return removed.socketId;
  }

  vacatePlayer(playerIndex) {
    const p=this.players[playerIndex]; if (!p) return;
    p.socketId=null; p.disconnected=false; p.vacated=true; p.lastSeen=Date.now();
  }

  takeoverSlot(socketId, newName, ip='unknown') {
    const idx=this.players.findIndex(p=>p.vacated);
    if (idx===-1) return -1;
    const p=this.players[idx];
    p.socketId=socketId; p.name=newName; p.vacated=false;
    p.disconnected=false; p.lastSeen=Date.now(); p.isBot=false; p.ip=ip;
    return idx;
  }

  hasVacantSlot() { return this.players.some(p=>p.vacated); }

  // NEW: host kicks a player mid-game and replaces with a bot
  kickAndReplaceWithBot(targetIdx) {
    if (targetIdx<0||targetIdx>=this.players.length) return null;
    const removed=this.players[targetIdx];
    const botName=`Bot ${targetIdx+1}`;
    this.players[targetIdx]={
      socketId:null, name:botName, cards:removed.cards,
      disconnected:false, lastSeen:Date.now(), isBot:true, ip:'bot', vacated:false,
    };
    return {removedSocketId:removed.socketId, botName};
  }

  addChat(playerName, message) {
    const entry={t:Date.now(),name:playerName,msg:message};
    this.chatLog.push(entry);
    if (this.chatLog.length>40) this.chatLog.shift();
    return entry;
  }

  // ── Round start ──

  startRound() {
    if (!this._startTime) this._startTime=Date.now();
    this._botBidActive=false; // BUG FIX 2: always reset chain lock on new round
    this.deck=shuffle(createDeck());
    this.phase='bidding';
    this.passed=new Set(); this.bidLog=[];
    this.highestBid=155; this.highestBidder=-1;
    this.trump=null; this.askedCards=[]; this.teammates=[];
    this.round=0; this.trick=[]; this.leadSuit=null;
    this.lastTrick=[]; this.lastTrickWinner=-1;
    this.lastGameover=null; this.earlyLossShown=false;
    this.autoLastTrickInProgress=false; this.playedCards=new Set();
    for (let i=0;i<5;i++) {
      this.players[i].cards=[]; this.trickPts[i]=0;
      this.roundScores[i]=0; this.reveal[i]=0;
    }
    for (let c=0;c<6;c++)
      for (let p=0;p<5;p++)
        this.players[(this.dealer+1+p)%5].cards.push(this.deck.pop());
    for (let i=0;i<5;i++) this.players[i].cards=sortCards(this.players[i].cards);
    this.currentBidder=(this.dealer+4)%5;
    return null; // illegal deal check is after Deal 2
  }

  placeBid(playerIdx, amount) {
    if (this.phase!=='bidding')         return 'Not the bidding phase';
    if (playerIdx!==this.currentBidder) return 'Not your turn to bid';
    if (this.passed.has(playerIdx))     return 'You have already passed';
    // BUG FIX 1: cancel auto-pass timer on successful bid
    if (this._autoBidTimers[playerIdx]) {
      clearTimeout(this._autoBidTimers[playerIdx]);
      delete this._autoBidTimers[playerIdx];
    }
    if (amount==='pass') {
      this.passed.add(playerIdx); this.bidLog.push({p:playerIdx,a:'pass'});
    } else {
      const n=Number(amount);
      if (!Number.isInteger(n)||n<160||n>290||n%5!==0) return 'Bid must be a multiple of 5 between 160 and 290';
      if (n<=this.highestBid) return `Must bid more than ${this.highestBid}`;
      this.highestBid=n; this.highestBidder=playerIdx;
      this.bidLog.push({p:playerIdx,a:n});
    }
    if (this.passed.size===4) {
      if (this.highestBidder===-1)
        for (let i=0;i<5;i++) if (!this.passed.has(i)) { this.highestBidder=i; this.highestBid=160; break; }
      this.phase='trump'; return null;
    }
    let next=(this.currentBidder+4)%5, guard=0;
    while (this.passed.has(next)&&guard++<5) next=(next+4)%5;
    this.currentBidder=next;
    return null;
  }

  setTrump(playerIdx, suit) {
    if (this.phase!=='trump')           return 'Not the trump selection phase';
    if (playerIdx!==this.highestBidder) return 'Only the highest bidder chooses trump';
    if (!SUITS.includes(suit)&&suit!==NO_TRUMP) return 'Invalid trump choice';
    this.trump=suit===NO_TRUMP?NO_TRUMP:suit;
    for (let c=0;c<4;c++)
      for (let p=0;p<5;p++)
        this.players[(this.dealer+1+p)%5].cards.push(this.deck.pop());
    for (let i=0;i<5;i++) this.players[i].cards=sortCards(this.players[i].cards);
    // Illegal deal check AFTER Deal 2
    for (let i=0;i<5;i++) {
      if (this.players[i].cards.filter(c=>c.rank==='A').length===4)
        return {illegalDeal:true, playerName:this.players[i].name};
    }
    this.phase='ask'; return null;
  }

  askForCards(playerIdx, cardIds) {
    if (this.phase!=='ask')                          return 'Not the ask phase';
    if (playerIdx!==this.highestBidder)              return 'Only the highest bidder asks';
    if (!Array.isArray(cardIds)||cardIds.length!==2) return 'Ask for exactly 2 cards';
    if (cardIds[0]===cardIds[1])                     return 'The 2 cards must be different';
    const myIds=this.players[playerIdx].cards.map(c=>c.id);
    for (const cid of cardIds) if (myIds.includes(cid)) return 'You already hold that card';
    const dm={}; createDeck().forEach(c=>{dm[c.id]=c;});
    const resolved=cardIds.map(id=>dm[id]).filter(Boolean);
    if (resolved.length!==2) return 'Invalid card IDs';
    this.askedCards=resolved; this.teammates=[];
    for (let i=0;i<5;i++) {
      if (i===playerIdx) continue;
      if (this.players[i].cards.some(c=>cardIds.includes(c.id))&&!this.teammates.includes(i))
        this.teammates.push(i);
    }
    this.phase='playing'; this.turnPlayer=(this.dealer+4)%5;
    return null;
  }

  playCard(playerIdx, cardId) {
    if (this.phase!=='playing')       return 'Game is not in the playing phase';
    if (playerIdx!==this.turnPlayer)  return 'It is not your turn';
    if (this.autoLastTrickInProgress) return 'Last trick is auto-playing';
    const player=this.players[playerIdx];
    const ci=player.cards.findIndex(c=>c.id===cardId);
    if (ci===-1) return 'You do not have that card';
    const card=player.cards[ci];
    if (this.trick.length>0&&this.leadSuit) {
      if (player.cards.some(c=>c.suit===this.leadSuit)&&card.suit!==this.leadSuit)
        return `You must play a ${this.leadSuit} card`;
    }
    player.cards.splice(ci,1);
    this.trick.push({playerIndex:playerIdx,card});
    if (this.trick.length===1) this.leadSuit=card.suit;

    if (this.askedCards.some(ac=>ac.id===cardId)) {
      if (this.reveal[playerIdx]===0) this.reveal[playerIdx]=1;
      else if (this.reveal[playerIdx]===1) this.reveal[playerIdx]=2;
    }

    const isNoTrump=!this.trump||this.trump===NO_TRUMP;
    const trumpEvent=(!isNoTrump&&this.leadSuit&&card.suit!==this.leadSuit&&card.suit===this.trump)
      ?{type:'trump_played',playerName:player.name,card}:null;
    let higherTrumpEvent=null;
    if (!isNoTrump&&card.suit===this.trump&&this.trick.length>1) {
      const prev=this.trick.slice(0,-1).filter(t=>t.card.suit===this.trump);
      if (prev.length>0) {
        const high=prev.reduce((h,t)=>rankIndex(t.card.rank)>rankIndex(h.card.rank)?t:h);
        if (rankIndex(card.rank)>rankIndex(high.card.rank))
          higherTrumpEvent={type:'higher_trump',playerName:player.name,card,beaten:high.card};
      }
    }
    if (this.trick.length<5) {
      this.turnPlayer=(this.turnPlayer+4)%5;
      return {cardPlayed:true,trumpEvent,higherTrumpEvent};
    }
    return this.resolveTrick(trumpEvent,higherTrumpEvent);
  }

  resolveTrick(trumpEvent=null,higherTrumpEvent=null) {
    let winner=this.trick[0];
    for (let i=1;i<this.trick.length;i++)
      if (beats(this.trick[i].card,winner.card,this.leadSuit,this.trump)) winner=this.trick[i];
    let pts=0;
    for (const play of this.trick) pts+=cardPoints(play.card);
    this.trickPts[winner.playerIndex]+=pts;
    this.lastTrickWinner=winner.playerIndex; this.round++;
    const result={trickDone:true,winnerIndex:winner.playerIndex,
      winnerName:this.players[winner.playerIndex].name,ptsWon:pts,
      trickPts:{...this.trickPts},trick:[...this.trick],trumpEvent,higherTrumpEvent};
    this.lastTrick=[...this.trick];
    for (const play of this.trick) this.playedCards.add(play.card.id);
    this.trick=[]; this.leadSuit=null;
    if (this.round===10) return {...result,...this.calculateFinalScores()};
    const teamPtsNow=this.trickPts[this.highestBidder]+
      this.teammates.reduce((s,t)=>s+(this.trickPts[t]||0),0);
    const remPts=totalRemainingPts(this.players);
    const maxPossible=teamPtsNow+remPts;
    const earlyLoss=(!this.earlyLossShown&&maxPossible<this.highestBid)
      ?{bidder:this.highestBidder,bidderName:this.players[this.highestBidder].name,
        bid:this.highestBid,teamPtsNow,maxPossible}:null;
    if (earlyLoss) this.earlyLossShown=true;
    this.turnPlayer=winner.playerIndex;
    const isLastTrick=(this.round===9);
    return {...result,earlyLoss,isLastTrick,lastTrickLeader:winner.playerIndex};
  }

  skipToScore() {
    if (this.phase!=='playing') return null;
    this.trick=[]; this.leadSuit=null;
    return this.calculateFinalScores();
  }

  calculateFinalScores() {
    const bidder=this.highestBidder, bid=this.highestBid;
    let teamPts=this.trickPts[bidder]||0;
    for (const tm of this.teammates) teamPts+=this.trickPts[tm]||0;
    const won=teamPts>=bid;
    const scores={};
    for (let i=0;i<5;i++) scores[i]=0;
    scores[bidder]=won?bid:-bid;
    if (this.teammates.length===2) {
      const share=Math.ceil(bid/3/5)*5;
      for (const tm of this.teammates) scores[tm]=won?share:-share;
    } else if (this.teammates.length===1) {
      const share=Math.ceil(2*bid/3/5)*5;
      scores[this.teammates[0]]=won?share:-share;
    }
    for (let i=0;i<5;i++) {
      this.roundScores[i]=scores[i];
      this.totalScores[i]=(this.totalScores[i]||0)+scores[i];
      // NEW: accumulate total points TAKEN (trick points, not net score)
      this.sessionTrickPts[i]=(this.sessionTrickPts[i]||0)+(this.trickPts[i]||0);
    }
    this.phase='scoring'; this.matchRound=(this.matchRound||0)+1;
    this.roundHistory.push({
      roundNum:this.matchRound, bid, bidderIdx:bidder,
      bidderName:this.players[bidder].name, won, teamPts, trump:this.trump,
      teammates:[...this.teammates], scores:{...scores}, totals:{...this.totalScores},
      trickPts:{...this.trickPts},
    });
    const go={gameOver:true, bid, bidder, bidderName:this.players[bidder].name,
      teamPts, won, teammates:this.teammates, trump:this.trump,
      roundScores:{...this.roundScores}, totalScores:{...this.totalScores},
      sessionTrickPts:{...this.sessionTrickPts},
      trickPts:{...this.trickPts}, roundHistory:this.roundHistory, matchRound:this.matchRound};
    this.lastGameover=go; return go;
  }

  stateFor(playerIdx) {
    return {
      phase:this.phase, myIndex:playerIdx, myCards:this.players[playerIdx]?.cards||[],
      players:this.players.map((p,i)=>({
        name:p.name, cardCount:p.cards.length, isDealer:i===this.dealer,
        trickPts:this.trickPts[i]||0, roundScore:this.roundScores[i]||0,
        totalScore:this.totalScores[i]||0, sessionTrickPts:this.sessionTrickPts[i]||0,
        reveal:this.reveal[i]||0, disconnected:p.disconnected||false,
        isBot:p.isBot||false, vacated:p.vacated||false,
      })),
      viewerCount:this.viewers.length,
      roomId:this.roomId, roomName:this.roomName,
      dealer:this.dealer, currentBidder:this.currentBidder,
      highestBid:this.highestBid, highestBidder:this.highestBidder,
      passed:[...this.passed], bidLog:this.bidLog,
      trump:this.trump, askedCardIds:this.askedCards.map(c=>c.id),
      teammates:this.teammates,
      turnPlayer:this.turnPlayer, trick:this.trick,
      lastTrick:this.lastTrick, lastTrickWinner:this.lastTrickWinner,
      round:this.round, leadSuit:this.leadSuit,
      roundHistory:this.roundHistory, matchRound:this.matchRound||0,
      autoLastTrickInProgress:this.autoLastTrickInProgress,
      chatLog:this.chatLog.slice(-20),
    };
  }

  viewerStateFor() {
    const s=this.stateFor(-1); s.myCards=[]; s.isViewer=true; return s;
  }
}

// ══════════════════════════════════════════════════════
//  SOCKET.IO HELPERS
// ══════════════════════════════════════════════════════

const games={};

function broadcastState(roomId) {
  const game=games[roomId]; if (!game) return;
  const sockets=io.sockets.adapter.rooms.get(roomId); if (!sockets) return;
  for (const sid of sockets) {
    const s=io.sockets.sockets.get(sid);
    if (!s) continue;
    if (s.playerIndex!==undefined) s.emit('state',game.stateFor(s.playerIndex));
    else if (s.isViewer) s.emit('state',game.viewerStateFor());
  }
}

function broadcast(roomId,event,data) { io.to(roomId).emit(event,data); }

// ── Bot helpers ──

function scheduleBotTurn(roomId) {
  const game=games[roomId]; if (!game||game.phase!=='playing'||game.autoLastTrickInProgress) return;
  const cur=game.players[game.turnPlayer];
  if (!cur||!cur.isBot) return;
  setTimeout(()=>{
    const g=games[roomId]; if (!g||g.phase!=='playing'||g.autoLastTrickInProgress) return;
    if (!g.players[g.turnPlayer]?.isBot) return;
    const bi=g.highestBidder, isTeam=g.turnPlayer===bi||g.teammates.includes(g.turnPlayer);
    const tp=(g.trickPts[bi]||0)+g.teammates.reduce((s,t)=>s+(g.trickPts[t]||0),0);
    const card=botChooseCard(g.players[g.turnPlayer].cards,g.trick,g.leadSuit,g.trump,
      isTeam,tp,g.highestBid,g.teammates,g.turnPlayer,g.players,g.playedCards,g.askedCards);
    const result=g.playCard(g.turnPlayer,card.id);
    if (typeof result==='string') return;
    broadcastState(roomId);
    handlePlayResult(roomId,result);
  },900);
}

// ── Bot helpers ──

// BUG FIX 1 & 2: single-chain bot bid scheduler using a per-room active flag
// Prevents multiple setTimeout chains from racing each other
function scheduleBotBid(roomId) {
  const game=games[roomId]; if (!game||game.phase!=='bidding') return;
  const cur=game.players[game.currentBidder];
  if (!cur||!cur.isBot) return;
  if (game._botBidActive) return; // already a chain running – don't spawn another
  game._botBidActive=true;
  setTimeout(()=>{
    const g=games[roomId];
    if (!g) { return; }
    g._botBidActive=false;
    if (g.phase!=='bidding') return;
    if (!g.players[g.currentBidder]?.isBot) return;
    const bi=g.currentBidder, bn=g.players[bi]?.name||'Bot';
    const amount=botChooseBid(g.players[bi].cards,g.highestBid);
    const err=g.placeBid(bi,amount); if (err) return;
    broadcast(roomId,'msg',{text:`🤖 ${bn} ${amount==='pass'?'✋ passed':`bid ${amount}`}`});
    broadcastState(roomId);
    if (g.phase==='trump'&&g.players[g.highestBidder]?.isBot) scheduleBotTrump(roomId);
    else scheduleBotBid(roomId);
  },800);
}

function scheduleBotTrump(roomId) {
  const game=games[roomId]; if (!game||game.phase!=='trump') return;
  setTimeout(()=>{
    const g=games[roomId]; if (!g||g.phase!=='trump') return;
    if (!g.players[g.highestBidder]?.isBot) return;
    const suit=botChooseTrump(g.players[g.highestBidder].cards);
    // BUG FIX 2: handle illegalDeal return from setTrump
    const result=g.setTrump(g.highestBidder,suit);
    if (result?.illegalDeal) {
      broadcast(roomId,'illegal_deal',{playerName:result.playerName});
      setTimeout(()=>{
        const g2=games[roomId]; if (!g2) return;
        g2.dealer=(g2.dealer+1)%5;
        g2.startRound();
        broadcastState(roomId);
        broadcast(roomId,'msg',{text:'Cards redealt due to illegal deal!'});
        scheduleBotBid(roomId);
      },3000); return;
    }
    if (typeof result==='string') { broadcast(roomId,'msg',{text:`Bot trump error: ${result}`}); return; }
    const label=suit===NO_TRUMP?'No Trump':`${SUIT_SYMS[suit]} ${suit}`;
    broadcast(roomId,'msg',{text:`🤖 ${g.players[g.highestBidder].name} chose: ${label}`});
    broadcastState(roomId);
    if (g.phase==='ask'&&g.players[g.highestBidder]?.isBot) scheduleBotAsk(roomId);
  },800);
}

function scheduleBotAsk(roomId) {
  const game=games[roomId]; if (!game||game.phase!=='ask') return;
  setTimeout(()=>{
    const g=games[roomId]; if (!g||g.phase!=='ask') return;
    if (!g.players[g.highestBidder]?.isBot) return;
    const ids=botChooseAsk(g.players[g.highestBidder].cards);
    const err=g.askForCards(g.highestBidder,ids); if (err) return;
    const asked=g.askedCards.map(c=>c.rank+SUIT_SYMS[c.suit]).join(' & ');
    broadcast(roomId,'msg',{text:`🤖 ${g.players[g.highestBidder].name} asked: ${asked}`});
    broadcastState(roomId);
    scheduleBotTurn(roomId);
  },800);
}

function autoPlayLastTrick(roomId, leaderIdx) {
  const game=games[roomId]; if (!game||game.phase!=='playing') return;
  game.autoLastTrickInProgress=true; broadcastState(roomId);
  broadcast(roomId,'msg',{text:'🃏 Last trick – auto-playing!'});
  const order=[]; for (let i=0;i<5;i++) order.push((leaderIdx+i*4)%5);
  let delay=400, finalResult=null;
  for (let step=0;step<5;step++) {
    const pi=order[step];
    setTimeout(()=>{
      const g=games[roomId]; if (!g||g.phase!=='playing') return;
      if (g.players[pi].cards.length===0) return;
      const cid=g.players[pi].cards[0].id;
      g.autoLastTrickInProgress=false;
      const result=g.playCard(pi,cid);
      g.autoLastTrickInProgress=(result?.cardPlayed===true);
      broadcastState(roomId);
      if (result?.trickDone||result?.gameOver) {
        g.autoLastTrickInProgress=false; finalResult=result;
        broadcast(roomId,'trick',result);
        if (result.earlyLoss) broadcast(roomId,'early_loss',result.earlyLoss);
        if (result.gameOver) {
          appendSessionLog(g, Date.now());
          setTimeout(()=>broadcast(roomId,'gameover',result),5000);
        }
      }
    },delay); delay+=1000;
  }
}

function handlePlayResult(roomId, result) {
  if (!result) return;
  if (result.trumpEvent)       broadcast(roomId,'trump_event',result.trumpEvent);
  if (result.higherTrumpEvent) broadcast(roomId,'trump_event',result.higherTrumpEvent);
  if (result.trickDone) {
    broadcast(roomId,'trick',result);
    if (result.earlyLoss) broadcast(roomId,'early_loss',result.earlyLoss);
    if (result.isLastTrick&&!result.gameOver) { autoPlayLastTrick(roomId,result.lastTrickLeader); return; }
  }
  if (result.gameOver) {
    appendSessionLog(games[roomId], Date.now());
    broadcast(roomId,'gameover',result);
  } else scheduleBotTurn(roomId);
}

// BUG FIX 1: auto-pass only for genuinely disconnected players
// Increased to 60s to avoid firing on slow-network temporary drops
// Guards: still disconnected, still their turn, phase still bidding
function scheduleAutoPass(roomId, playerIdx) {
  const game=games[roomId]; if (!game) return;
  // Cancel any pre-existing timer for this player
  if (game._autoBidTimers[playerIdx]) {
    clearTimeout(game._autoBidTimers[playerIdx]);
    delete game._autoBidTimers[playerIdx];
  }
  const timer=setTimeout(()=>{
    const g=games[roomId]; if (!g) return;
    if (g.phase!=='bidding') return;                    // game moved on
    if (g.currentBidder!==playerIdx) return;            // turn rotated away
    const p=g.players[playerIdx];
    if (!p) return;
    if (!p.disconnected) return;                        // player reconnected — cancel
    const err=g.placeBid(playerIdx,'pass'); if (err) return;
    broadcast(roomId,'msg',{text:`⚠️ ${p.name} auto-passed (disconnected 60s)`});
    broadcastState(roomId);
    if (g.phase==='trump'&&g.players[g.highestBidder]?.isBot) scheduleBotTrump(roomId);
    else scheduleBotBid(roomId);
  }, 60000); // 60 seconds, not 30
  game._autoBidTimers[playerIdx]=timer;
}

// ══════════════════════════════════════════════════════
//  SOCKET EVENTS
// ══════════════════════════════════════════════════════

io.on('connection', socket=>{
  const ip=socket.handshake.headers['x-forwarded-for']?.split(',')[0]?.trim()||socket.handshake.address;
  console.log(`Connected: ${socket.id} | IP: ${ip}`);
  socket._clientIp=ip;

  // ── Create ──
  socket.on('create',({name, roomName=''})=>{
    let roomId;
    do { roomId=String(Math.floor(1000+Math.random()*9000)); } while(games[roomId]);
    console.log(`CREATE room ${roomId} "${roomName}" | player:"${name}" | IP:${ip}`);
    const game=new Game(roomId, roomName.trim().slice(0,30));
    const idx=game.addPlayer(socket.id,name,false,ip);
    games[roomId]=game;
    socket.join(roomId); socket.roomId=roomId; socket.playerIndex=idx;
    socket.emit('joined',{roomId,playerIndex:idx,name,roomName:game.roomName});
    broadcastState(roomId);
  });

  // ── Join (BUG FIX 3: clearer error messages, handle stale sessions) ──
  socket.on('join',({roomId,name})=>{
    // Normalise: trim and ensure string
    const rid=String(roomId||'').trim();
    const game=games[rid];
    if (!game) {
      console.log(`JOIN failed: room "${rid}" not found | IP:${ip}`);
      socket.emit('err',`Room ${rid} not found. Check the 4-digit code and try again.`);
      return;
    }

    // Reconnect by name
    const existingIdx=game.players.findIndex(p=>p.name===name&&!p.vacated);
    if (existingIdx!==-1) {
      const idx=game.reconnectPlayer(socket.id,name,existingIdx);
      if (idx!==-1) {
        socket.join(rid); socket.roomId=rid; socket.playerIndex=idx;
        socket.emit('joined',{roomId:rid,playerIndex:idx,name,roomName:game.roomName});
        broadcastState(rid); if (game.lastGameover) socket.emit('gameover',game.lastGameover);
        broadcast(rid,'msg',{text:`${name} reconnected`});
        if (game.phase==='playing') scheduleBotTurn(rid);
        return;
      }
    }

    // Takeover vacated slot
    if (game.phase!=='waiting'&&game.hasVacantSlot()) {
      const idx=game.takeoverSlot(socket.id,name,ip);
      if (idx!==-1) {
        socket.join(rid); socket.roomId=rid; socket.playerIndex=idx;
        socket.emit('joined',{roomId:rid,playerIndex:idx,name,roomName:game.roomName});
        broadcastState(rid);
        broadcast(rid,'msg',{text:`${name} took over an empty slot`});
        if (game.phase==='playing') scheduleBotTurn(rid);
        return;
      }
    }

    // Join as viewer if game started
    if (game.phase!=='waiting') {
      const existing=game.viewers.find(v=>v.name===name);
      if (existing) {
        existing.socketId=socket.id;
        socket.join(rid); socket.roomId=rid; socket.isViewer=true;
        socket.emit('joined_as_viewer',{roomId:rid,name,viewerCount:game.viewers.length,roomName:game.roomName});
        socket.emit('state',game.viewerStateFor());
        broadcast(rid,'msg',{text:`👁 ${name} is watching`}); return;
      }
      if (game.viewers.length<5) {
        if (game.addViewer(socket.id,name)) {
          socket.join(rid); socket.roomId=rid; socket.isViewer=true;
          socket.emit('joined_as_viewer',{roomId:rid,name,viewerCount:game.viewers.length,roomName:game.roomName});
          socket.emit('state',game.viewerStateFor());
          broadcastState(rid);
          broadcast(rid,'msg',{text:`👁 ${name} is watching`}); return;
        }
      }
      socket.emit('err','Game in progress – use your original name to rejoin, or viewer slots are full'); return;
    }

    if (game.players.length>=5) { socket.emit('err','Room is full (5/5)'); return; }
    console.log(`JOIN room ${rid} | player:"${name}" | IP:${ip}`);
    const idx=game.addPlayer(socket.id,name,false,ip);
    socket.join(rid); socket.roomId=rid; socket.playerIndex=idx;
    socket.emit('joined',{roomId:rid,playerIndex:idx,name,roomName:game.roomName});
    broadcastState(rid);
    broadcast(rid,'msg',{text:`${name} joined!`});
  });

  // ── Add bot ──
  socket.on('add_bot',({name})=>{
    const game=games[socket.roomId];
    if (!game||game.phase!=='waiting'||socket.playerIndex!==0) { socket.emit('err','Only host can add bots in lobby'); return; }
    if (game.players.length>=5) { socket.emit('err','Room is full'); return; }
    const bn=name||`Bot ${game.players.length+1}`;
    game.addBot(bn); broadcastState(socket.roomId);
    broadcast(socket.roomId,'msg',{text:`🤖 Bot "${bn}" added`});
  });

  // ── Remove bot (lobby) ──
  socket.on('remove_bot',({botIndex})=>{
    const game=games[socket.roomId];
    if (!game||game.phase!=='waiting'||socket.playerIndex!==0) return;
    if (!game.players[botIndex]?.isBot) { socket.emit('err','Not a bot'); return; }
    game.removePlayer(botIndex);
    const socks=io.sockets.adapter.rooms.get(socket.roomId);
    if (socks) for (const sid of socks) { const s=io.sockets.sockets.get(sid); if (s&&s.playerIndex>botIndex) s.playerIndex--; }
    broadcastState(socket.roomId); broadcast(socket.roomId,'msg',{text:'🤖 Bot removed'});
  });

  // ── NEW: Host kick mid-game ──
  socket.on('host_kick',({targetIndex, replaceBotName})=>{
    const game=games[socket.roomId];
    if (!game||socket.playerIndex!==0) { socket.emit('err','Only host can kick'); return; }
    if (game.phase==='waiting') { socket.emit('err','Use Remove in lobby'); return; }
    if (targetIndex===0) { socket.emit('err','Cannot kick yourself'); return; }
    const target=game.players[targetIndex]; if (!target) return;
    const targetName=target.name;
    const targetSid=target.socketId;
    const botName=replaceBotName||`Bot ${targetIndex+1}`;

    // Kick the player socket
    if (targetSid) {
      const ts=io.sockets.sockets.get(targetSid);
      if (ts) { ts.leave(socket.roomId); ts.emit('kicked',{reason:'Removed by host mid-game'}); ts.roomId=undefined; ts.playerIndex=undefined; }
    }

    // Replace with a bot in-place (keeping cards)
    game.kickAndReplaceWithBot(targetIndex);
    broadcastState(socket.roomId);
    broadcast(socket.roomId,'msg',{text:`🔄 ${targetName} was removed and replaced by 🤖 ${botName}`});

    // Trigger bot action if it's now the bot's turn
    if (game.phase==='bidding'&&game.currentBidder===targetIndex) scheduleBotBid(socket.roomId);
    if (game.phase==='playing'&&game.turnPlayer===targetIndex) scheduleBotTurn(socket.roomId);
  });

  // ── Reconnect ──
  socket.on('reconnect_player',({roomId,name,playerIndex})=>{
    const rid=String(roomId||'').trim();
    const game=games[rid];
    // BUG FIX 3: clear stale session gracefully
    if (!game) { socket.emit('err','Session expired – room no longer exists. Please join again.'); return; }
    const idx=game.reconnectPlayer(socket.id,name,playerIndex);
    if (idx===-1) { socket.emit('err','Could not restore session – please join again.'); return; }
    socket.join(rid); socket.roomId=rid; socket.playerIndex=idx;
    socket.emit('joined',{roomId:rid,playerIndex:idx,name,roomName:game.roomName});
    broadcastState(rid); if (game.lastGameover) socket.emit('gameover',game.lastGameover);
    broadcast(rid,'msg',{text:`${name} reconnected`});
    if (game.phase==='playing') scheduleBotTurn(rid);
  });

  // ── Start ──
  socket.on('start',()=>{
    const game=games[socket.roomId];
    if (!game||socket.playerIndex!==0) return;
    if (game.players.length!==5) { socket.emit('err','Need exactly 5 players/bots'); return; }
    game.startRound();
    broadcastState(socket.roomId);
    broadcast(socket.roomId,'msg',{text:`Game started! ${game.roomName?`Room: "${game.roomName}" · `:''}Bidding begins.`});
    scheduleBotBid(socket.roomId);
  });

  // ── Bid ──
  socket.on('bid',({amount})=>{
    const game=games[socket.roomId]; if (!game) return;
    const err=game.placeBid(socket.playerIndex,amount);
    if (err) { socket.emit('err',err); return; }
    broadcast(socket.roomId,'msg',{text:`${game.players[socket.playerIndex].name} ${amount==='pass'?'✋ passed':`bid ${amount}`}`});
    broadcastState(socket.roomId);
    if (game.phase==='trump'&&game.players[game.highestBidder]?.isBot) scheduleBotTrump(socket.roomId);
    else scheduleBotBid(socket.roomId);
  });

  // ── Trump ──
  socket.on('trump',({suit})=>{
    const game=games[socket.roomId]; if (!game) return;
    const result=game.setTrump(socket.playerIndex,suit);
    if (typeof result==='string') { socket.emit('err',result); return; }
    if (result?.illegalDeal) {
      broadcast(socket.roomId,'illegal_deal',{playerName:result.playerName});
      setTimeout(()=>{
        const g=games[socket.roomId]; if (!g) return;
        g.dealer=(g.dealer+1)%5; g.startRound();
        broadcastState(socket.roomId);
        broadcast(socket.roomId,'msg',{text:'Cards redealt due to illegal deal! Bidding begins.'});
        scheduleBotBid(socket.roomId);
      },3000); return;
    }
    const label=suit===NO_TRUMP?'No Trump':`${SUIT_SYMS[suit]} ${suit}`;
    broadcast(socket.roomId,'msg',{text:`Trump: ${label} – Deal 2 done! Ask phase.`});
    broadcastState(socket.roomId);
    if (game.phase==='ask'&&game.players[game.highestBidder]?.isBot) scheduleBotAsk(socket.roomId);
  });

  // ── Ask ──
  socket.on('ask',({cardIds})=>{
    const game=games[socket.roomId]; if (!game) return;
    const err=game.askForCards(socket.playerIndex,cardIds);
    if (err) { socket.emit('err',err); return; }
    const asked=game.askedCards.map(c=>c.rank+SUIT_SYMS[c.suit]).join(' & ');
    broadcast(socket.roomId,'msg',{text:`${game.players[socket.playerIndex].name} asked: ${asked} – play begins!`});
    broadcastState(socket.roomId);
    scheduleBotTurn(socket.roomId);
  });

  // ── Play ──
  socket.on('play',({cardId})=>{
    const game=games[socket.roomId]; if (!game) return;
    const result=game.playCard(socket.playerIndex,cardId);
    if (typeof result==='string') { socket.emit('err',result); return; }
    broadcastState(socket.roomId);
    handlePlayResult(socket.roomId,result);
  });

  // ── Skip to score (only after early loss) ──
  socket.on('skip_to_score',()=>{
    const game=games[socket.roomId];
    if (!game||socket.playerIndex!==0||game.phase!=='playing') return;
    if (!game.earlyLossShown) { socket.emit('err','Skip only available after early loss is confirmed'); return; }
    const result=game.skipToScore(); if (!result) return;
    appendSessionLog(game, Date.now());
    broadcastState(socket.roomId);
    broadcast(socket.roomId,'gameover',result);
    broadcast(socket.roomId,'msg',{text:'Host skipped to scorecard after early loss'});
  });

  // ── Chat / Banter ──
  socket.on('chat',({message})=>{
    const game=games[socket.roomId]; if (!game) return;
    const name=socket.isViewer
      ? (game.viewers.find(v=>v.socketId===socket.id)?.name||'Viewer')
      : (game.players[socket.playerIndex]?.name||'?');
    const trimmed=(message||'').trim().slice(0,120);
    if (!trimmed) return;
    const entry=game.addChat(name,trimmed);
    broadcast(socket.roomId,'chat',entry);
  });

  // ── Next round ──
  socket.on('next',()=>{
    const game=games[socket.roomId];
    if (!game||socket.playerIndex!==0) return;
    game.dealer=(game.dealer+1)%5;
    game.startRound();
    broadcastState(socket.roomId);
    broadcast(socket.roomId,'msg',{text:'New round! Bidding begins.'});
    scheduleBotBid(socket.roomId);
  });

  // ── Cancel game ──
  socket.on('cancel_game',()=>{
    const game=games[socket.roomId];
    if (!game||socket.playerIndex!==0) return;
    const roomId=socket.roomId;
    appendSessionLog(game,Date.now());
    const standings=game.players.map((p,i)=>({
      name:p.name, totalScore:game.totalScores[i]||0,
      sessionTrickPts:game.sessionTrickPts[i]||0,
      index:i, isBot:p.isBot,
    })).sort((a,b)=>b.totalScore-a.totalScore);
    broadcast(roomId,'podium',{standings,roundHistory:game.roundHistory,
      totalScores:{...game.totalScores},matchRounds:game.matchRound||0,
      roomName:game.roomName,playerNames:game.players.map(p=>p.name)});
    setTimeout(()=>{
      const socks=io.sockets.adapter.rooms.get(roomId);
      if (socks) for (const sid of socks) {
        const s=io.sockets.sockets.get(sid);
        if (s) { s.leave(roomId); s.roomId=undefined; s.playerIndex=undefined; s.isViewer=undefined; }
      }
      delete games[roomId];
    },9000);
  });

  // ── Leave / Exit ──
  socket.on('leave',()=>{
    const game=games[socket.roomId]; if (!game) return;
    if (socket.isViewer) {
      game.removeViewer(socket.id);
      broadcast(socket.roomId,'msg',{text:'👁 Viewer left'});
      broadcastState(socket.roomId);
      socket.leave(socket.roomId); socket.isViewer=undefined; socket.roomId=undefined; return;
    }
    if (game.phase!=='waiting'||socket.playerIndex===0) return;
    const name=game.players[socket.playerIndex]?.name||'A player';
    game.removePlayer(socket.playerIndex);
    const socks=io.sockets.adapter.rooms.get(socket.roomId);
    if (socks) for (const sid of socks) { const s=io.sockets.sockets.get(sid); if (s&&s.playerIndex>socket.playerIndex) s.playerIndex--; }
    socket.leave(socket.roomId); socket.emit('kicked',{reason:'You left the room'});
    broadcast(game.roomId,'msg',{text:`${name} left`});
    broadcastState(game.roomId);
    socket.roomId=undefined; socket.playerIndex=undefined;
  });

  socket.on('exit_game',()=>{
    const game=games[socket.roomId]; if (!game||socket.playerIndex===undefined) return;
    if (game.phase==='waiting') {
      if (socket.playerIndex===0) { socket.emit('err','Host cannot leave – use Cancel Room'); return; }
      const name=game.players[socket.playerIndex]?.name||'A player';
      game.removePlayer(socket.playerIndex);
      const socks=io.sockets.adapter.rooms.get(socket.roomId);
      if (socks) for (const sid of socks) { const s=io.sockets.sockets.get(sid); if (s&&s.playerIndex>socket.playerIndex) s.playerIndex--; }
      socket.leave(socket.roomId); socket.emit('kicked',{reason:'You left the room'});
      broadcast(game.roomId,'msg',{text:`${name} left`});
      broadcastState(game.roomId);
    } else {
      const name=game.players[socket.playerIndex]?.name||'A player';
      game.vacatePlayer(socket.playerIndex);
      socket.leave(socket.roomId);
      socket.emit('kicked',{reason:'You exited the game. Another player can take your slot.'});
      broadcast(game.roomId,'msg',{text:`⚠️ ${name} exited – slot open for new player`});
      broadcastState(game.roomId);
    }
    socket.roomId=undefined; socket.playerIndex=undefined;
  });

  // ── Remove player (lobby only) ──
  socket.on('remove_player',({targetIndex})=>{
    const game=games[socket.roomId];
    if (!game||game.phase!=='waiting'||socket.playerIndex!==0) return;
    if (targetIndex===0) { socket.emit('err','Cannot remove host'); return; }
    const targetName=game.players[targetIndex]?.name||'Player';
    const targetSid=game.removePlayer(targetIndex);
    const socks=io.sockets.adapter.rooms.get(socket.roomId);
    if (socks) for (const sid of socks) { const s=io.sockets.sockets.get(sid); if (s&&s.playerIndex>targetIndex) s.playerIndex--; }
    if (targetSid) {
      const ts=io.sockets.sockets.get(targetSid);
      if (ts) { ts.leave(socket.roomId); ts.emit('kicked',{reason:'Removed by host'}); ts.roomId=undefined; ts.playerIndex=undefined; }
    }
    broadcast(socket.roomId,'msg',{text:`${targetName} was removed`});
    broadcastState(socket.roomId);
  });

  // ── Disconnect ──
  socket.on('disconnect',()=>{
    const game=games[socket.roomId]; if (!game) return;
    if (socket.isViewer) { game.removeViewer(socket.id); broadcastState(socket.roomId); return; }
    if (socket.playerIndex===undefined) return;
    const name=game.players[socket.playerIndex]?.name||'A player';
    if (game.phase==='waiting') {
      game.removePlayer(socket.playerIndex);
      const socks=io.sockets.adapter.rooms.get(socket.roomId);
      if (socks) for (const sid of socks) { const s=io.sockets.sockets.get(sid); if (s&&s.playerIndex>socket.playerIndex) s.playerIndex--; }
      broadcast(socket.roomId,'msg',{text:`${name} left`});
    } else {
      game.markDisconnected(socket.playerIndex);
      broadcast(socket.roomId,'msg',{text:`⚠️ ${name} disconnected – rejoin with same name`});
      if (game.phase==='bidding'&&game.currentBidder===socket.playerIndex)
        scheduleAutoPass(socket.roomId,socket.playerIndex);
    }
    broadcastState(socket.roomId);
  });
});

setInterval(()=>{
  const now=Date.now();
  for (const [id,game] of Object.entries(games)) {
    if (game.players.every(p=>p.disconnected&&(now-p.lastSeen)>30*60*1000)) {
      delete games[id]; console.log('Cleaned room',id);
    }
  }
},10*60*1000);

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`\n🃏 Bridge running at http://localhost:${PORT}\n`));
