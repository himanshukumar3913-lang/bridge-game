/**
 * Bridge Card Game – Server (Full Feature Update)
 * New: Bots, early-loss detection, auto-pass disconnected players,
 *      last-trick storage, trump-play events, round history, podium
 *
 * RULE ORDER: Deal 1 (6) → Bidding → Trump → Deal 2 (4) → Ask → Play
 */

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] },
  transports: ['polling','websocket'],
  allowUpgrades: true,
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 45000,
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.send('OK'));

// ══════════════════════════════════════════════════════
//  CARD SYSTEM
// ══════════════════════════════════════════════════════

const SUITS     = ['spades','hearts','diamonds','clubs'];
const RANKS     = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const SUIT_SYMS = { spades:'♠', hearts:'♥', diamonds:'♦', clubs:'♣' };

function createDeck() {
  const deck = [];
  for (const suit of SUITS)
    for (const rank of RANKS) {
      if (rank === '2' && (suit === 'clubs' || suit === 'diamonds')) continue;
      deck.push({ rank, suit, id:`${rank}-${suit}` });
    }
  return deck; // 50 cards
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length-1; i>0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]] = [a[j],a[i]];
  }
  return a;
}

function rankIndex(rank)  { return RANKS.indexOf(rank); }
function suitIndex(suit)  { return SUITS.indexOf(suit); }

function cardPoints(card) {
  if (card.rank==='A') return 20;
  if (['K','Q','J','10'].includes(card.rank)) return 10;
  if (card.rank==='5') return 5;
  if (card.rank==='3' && card.suit==='spades') return 30;
  return 0;
}

function beats(challenger, current, leadSuit, trump) {
  const cT = challenger.suit===trump, wT = current.suit===trump;
  if ( cT && !wT) return true;
  if (!cT &&  wT) return false;
  if ( cT &&  wT) return rankIndex(challenger.rank)>rankIndex(current.rank);
  const cL = challenger.suit===leadSuit, wL = current.suit===leadSuit;
  if ( wL && !cL) return false;
  if (!wL &&  cL) return true;
  if (!wL && !cL) return false;
  return rankIndex(challenger.rank)>rankIndex(current.rank);
}

function sortCards(cards) {
  return [...cards].sort((a,b) => {
    const sd = suitIndex(a.suit)-suitIndex(b.suit);
    return sd!==0 ? sd : rankIndex(b.rank)-rankIndex(a.rank);
  });
}

/** Sum of all points remaining in unplayed cards */
function totalRemainingPts(players) {
  let pts = 0;
  for (const p of players)
    for (const c of p.cards) pts += cardPoints(c);
  return pts;
}

// ══════════════════════════════════════════════════════
//  BOT AI
// ══════════════════════════════════════════════════════

function botChooseBid(hand, currentHighest) {
  // Score hand: sum of card points the bot holds
  const pts = hand.reduce((s,c) => s+cardPoints(c), 0);
  // Bid ~80% of hand strength, rounded to multiple of 5, min 160, max 290
  const raw = Math.round(pts * 0.8 / 5) * 5;
  const bid = Math.max(160, Math.min(290, raw));
  if (bid <= currentHighest) return 'pass';
  return bid;
}

function botChooseTrump(hand) {
  // Pick suit with highest total point value in hand
  const suitPts = { spades:0, hearts:0, diamonds:0, clubs:0 };
  for (const c of hand) suitPts[c.suit] += cardPoints(c);
  return SUITS.reduce((best, s) => suitPts[s]>suitPts[best] ? s : best, 'spades');
}

function botChooseAsk(hand, bidderIdx) {
  // Ask for the 2 highest-value cards not in bot's hand
  const myIds = new Set(hand.map(c=>c.id));
  const notMine = createDeck()
    .filter(c => !myIds.has(c.id))
    .sort((a,b) => cardPoints(b)-cardPoints(a) || rankIndex(b.rank)-rankIndex(a.rank));
  return [notMine[0].id, notMine[1].id];
}

function botChooseCard(hand, trick, leadSuit, trump, isOnBiddingTeam) {
  // Must-follow-suit
  const followable = leadSuit ? hand.filter(c=>c.suit===leadSuit) : [];
  const pool = followable.length>0 ? followable : hand;

  if (isOnBiddingTeam) {
    // Try to win: play highest in pool, prefer trump if can't follow
    const trumpCards = pool.filter(c=>c.suit===trump).sort((a,b)=>rankIndex(b.rank)-rankIndex(a.rank));
    const others     = pool.filter(c=>c.suit!==trump).sort((a,b)=>rankIndex(b.rank)-rankIndex(a.rank));
    // If trick has a winner, try to beat it
    if (trick.length>0) {
      let winner = trick[0];
      for (const t of trick) if (beats(t.card,winner.card,leadSuit,trump)) winner=t;
      // Try to beat current winner
      const canBeat = pool.filter(c=>beats(c,winner.card,leadSuit,trump))
                         .sort((a,b)=>rankIndex(a.rank)-rankIndex(b.rank)); // lowest winning card
      if (canBeat.length>0) return canBeat[0];
    }
    // Can't beat – play lowest to minimise loss
    return pool.sort((a,b)=>rankIndex(a.rank)-rankIndex(b.rank))[0];
  } else {
    // Opposing team: try NOT to win – play lowest non-point card first
    const sorted = [...pool].sort((a,b)=>cardPoints(a)-cardPoints(b)||rankIndex(a.rank)-rankIndex(b.rank));
    return sorted[0];
  }
}

// ══════════════════════════════════════════════════════
//  GAME CLASS
// ══════════════════════════════════════════════════════

class Game {
  constructor(roomId) {
    this.roomId  = roomId;
    this.players = []; // {socketId,name,cards,disconnected,lastSeen,isBot}
    this.phase   = 'waiting';
    this.dealer  = 0;
    this.deck    = [];

    this.currentBidder = 0;
    this.highestBid    = 155;
    this.highestBidder = -1;
    this.passed        = new Set();
    this.bidLog        = [];

    this.trump      = null;
    this.askedCards = [];
    this.teammates  = [];
    this.reveal     = {};

    this.round           = 0;
    this.turnPlayer      = 0;
    this.trick           = [];
    this.leadSuit        = null;
    this.lastTrick       = [];      // ★ stores previous completed trick
    this.lastTrickWinner = -1;
    this.trickPts        = {};
    this.earlyLossShown  = false;   // ★ track if early-loss was already shown

    this.roundScores  = {};
    this.totalScores  = {};
    this.lastGameover = null;
    this.roundHistory = [];
    this.matchRound   = 0;

    // Auto-pass timers for disconnected players
    this._autoBidTimers = {};
  }

  // ── Player management ──

  addPlayer(socketId, name, isBot=false) {
    if (this.players.length>=5) return -1;
    const idx = this.players.length;
    this.players.push({ socketId, name, cards:[], disconnected:false, lastSeen:Date.now(), isBot });
    this.trickPts[idx]=0; this.roundScores[idx]=0;
    this.totalScores[idx]=this.totalScores[idx]||0;
    this.reveal[idx]=0;
    return idx;
  }

  addBot(name) {
    return this.addPlayer(null, name||`Bot${this.players.length+1}`, true);
  }

  reconnectPlayer(socketId, name, playerIndex) {
    let idx = -1;
    if (playerIndex>=0 && playerIndex<this.players.length && this.players[playerIndex].name===name)
      idx = playerIndex;
    if (idx===-1) idx = this.players.findIndex(p=>p.name===name);
    if (idx===-1) return -1;
    const p = this.players[idx];
    p.socketId=socketId; p.disconnected=false; p.lastSeen=Date.now();
    return idx;
  }

  markDisconnected(playerIndex) {
    const p = this.players[playerIndex];
    if (p) { p.disconnected=true; p.lastSeen=Date.now(); p.socketId=null; }
  }

  removePlayer(targetIdx) {
    if (this.phase!=='waiting') return null;
    if (targetIdx===0 || targetIdx<0 || targetIdx>=this.players.length) return null;
    const removed = this.players[targetIdx];
    this.players.splice(targetIdx,1);
    for (let i=targetIdx; i<this.players.length; i++) {
      this.trickPts[i]=this.trickPts[i+1]||0;
      this.roundScores[i]=this.roundScores[i+1]||0;
      this.totalScores[i]=this.totalScores[i+1]||0;
      this.reveal[i]=this.reveal[i+1]||0;
    }
    const last=this.players.length;
    delete this.trickPts[last]; delete this.roundScores[last];
    delete this.totalScores[last]; delete this.reveal[last];
    return removed.socketId;
  }

  // ── Round start ──

  startRound() {
    this.deck=shuffle(createDeck());
    this.phase='bidding';
    this.passed=new Set(); this.bidLog=[];
    this.highestBid=155; this.highestBidder=-1;
    this.trump=null; this.askedCards=[]; this.teammates=[];
    this.round=0; this.trick=[]; this.leadSuit=null;
    this.lastTrick=[]; this.lastTrickWinner=-1;
    this.lastGameover=null; this.earlyLossShown=false;
    for (let i=0;i<5;i++) {
      this.players[i].cards=[]; this.trickPts[i]=0;
      this.roundScores[i]=0; this.reveal[i]=0;
    }
    // Deal 1: 6 cards each clockwise from left of dealer
    for (let c=0;c<6;c++)
      for (let p=0;p<5;p++)
        this.players[(this.dealer+1+p)%5].cards.push(this.deck.pop());
    for (let i=0;i<5;i++) this.players[i].cards=sortCards(this.players[i].cards);
    this.currentBidder=(this.dealer+4)%5;
  }

  // ── Bidding ──

  placeBid(playerIdx, amount) {
    if (this.phase!=='bidding')         return 'Not the bidding phase';
    if (playerIdx!==this.currentBidder) return 'Not your turn to bid';
    if (this.passed.has(playerIdx))     return 'You have already passed';
    if (amount==='pass') {
      this.passed.add(playerIdx);
      this.bidLog.push({p:playerIdx,a:'pass'});
    } else {
      const n=Number(amount);
      if (!Number.isInteger(n)||n<160||n>290||n%5!==0) return 'Bid must be a multiple of 5 between 160 and 290';
      if (n<=this.highestBid) return `Must bid more than ${this.highestBid}`;
      this.highestBid=n; this.highestBidder=playerIdx;
      this.bidLog.push({p:playerIdx,a:n});
    }
    if (this.passed.size===4) {
      if (this.highestBidder===-1) {
        for (let i=0;i<5;i++) if (!this.passed.has(i)) { this.highestBidder=i; this.highestBid=160; break; }
      }
      this.phase='trump'; return null;
    }
    let next=(this.currentBidder+4)%5, guard=0;
    while (this.passed.has(next)&&guard++<5) next=(next+4)%5;
    this.currentBidder=next;
    return null;
  }

  // ── Trump → Deal 2 ──

  setTrump(playerIdx, suit) {
    if (this.phase!=='trump')           return 'Not the trump selection phase';
    if (playerIdx!==this.highestBidder) return 'Only the highest bidder chooses trump';
    if (!SUITS.includes(suit))          return 'Invalid suit';
    this.trump=suit;
    for (let c=0;c<4;c++)
      for (let p=0;p<5;p++)
        this.players[(this.dealer+1+p)%5].cards.push(this.deck.pop());
    for (let i=0;i<5;i++) this.players[i].cards=sortCards(this.players[i].cards);
    this.phase='ask'; return null;
  }

  // ── Ask ──

  askForCards(playerIdx, cardIds) {
    if (this.phase!=='ask')                            return 'Not the ask phase';
    if (playerIdx!==this.highestBidder)                return 'Only the highest bidder asks';
    if (!Array.isArray(cardIds)||cardIds.length!==2)   return 'Ask for exactly 2 cards';
    if (cardIds[0]===cardIds[1])                       return 'The 2 cards must be different';
    const myIds=this.players[playerIdx].cards.map(c=>c.id);
    for (const cid of cardIds) if (myIds.includes(cid)) return 'You already hold that card';
    const dm={}; createDeck().forEach(c=>{dm[c.id]=c;});
    const resolved=cardIds.map(id=>dm[id]).filter(Boolean);
    if (resolved.length!==2) return 'Invalid card IDs';
    this.askedCards=resolved;
    this.teammates=[];
    for (let i=0;i<5;i++) {
      if (i===playerIdx) continue;
      if (this.players[i].cards.some(c=>cardIds.includes(c.id))&&!this.teammates.includes(i))
        this.teammates.push(i);
    }
    this.phase='playing'; this.turnPlayer=(this.dealer+4)%5;
    return null;
  }

  // ── Play a card ──

  playCard(playerIdx, cardId) {
    if (this.phase!=='playing')      return 'Game is not in the playing phase';
    if (playerIdx!==this.turnPlayer) return 'It is not your turn';
    const player=this.players[playerIdx];
    const cardIdx=player.cards.findIndex(c=>c.id===cardId);
    if (cardIdx===-1)                return 'You do not have that card';
    const card=player.cards[cardIdx];
    if (this.trick.length>0&&this.leadSuit) {
      const hasLead=player.cards.some(c=>c.suit===this.leadSuit);
      if (hasLead&&card.suit!==this.leadSuit) return `You must play a ${this.leadSuit} card`;
    }
    player.cards.splice(cardIdx,1);
    this.trick.push({playerIndex:playerIdx,card});
    if (this.trick.length===1) this.leadSuit=card.suit;

    // Reveal teammate
    if (this.askedCards.some(ac=>ac.id===cardId)) {
      if (this.reveal[playerIdx]===0)      this.reveal[playerIdx]=1;
      else if (this.reveal[playerIdx]===1) this.reveal[playerIdx]=2;
    }

    // Was trump played on a non-trump lead?
    const trumpEvent = (this.leadSuit && card.suit!==this.leadSuit && card.suit===this.trump)
      ? { type:'trump_played', playerName:player.name, card }
      : null;

    // Was a higher trump played over an existing trump?
    let higherTrumpEvent = null;
    if (card.suit===this.trump && this.trick.length>1) {
      const prevTrumps = this.trick.slice(0,-1).filter(t=>t.card.suit===this.trump);
      if (prevTrumps.length>0) {
        const highest = prevTrumps.reduce((h,t)=>rankIndex(t.card.rank)>rankIndex(h.card.rank)?t:h);
        if (rankIndex(card.rank)>rankIndex(highest.card.rank)) {
          higherTrumpEvent = { type:'higher_trump', playerName:player.name, card, beaten:highest.card };
        }
      }
    }

    if (this.trick.length<5) {
      this.turnPlayer=(this.turnPlayer+4)%5;
      return { cardPlayed:true, trumpEvent, higherTrumpEvent };
    }
    return this.resolveTrick(trumpEvent, higherTrumpEvent);
  }

  // ── Resolve trick ──

  resolveTrick(trumpEvent=null, higherTrumpEvent=null) {
    let winner=this.trick[0];
    for (let i=1;i<this.trick.length;i++)
      if (beats(this.trick[i].card,winner.card,this.leadSuit,this.trump)) winner=this.trick[i];
    let pts=0;
    for (const play of this.trick) pts+=cardPoints(play.card);
    this.trickPts[winner.playerIndex]+=pts;
    this.lastTrickWinner=winner.playerIndex;
    this.round++;

    const result = {
      trickDone:true,
      winnerIndex:winner.playerIndex,
      winnerName:this.players[winner.playerIndex].name,
      ptsWon:pts,
      trickPts:{...this.trickPts},
      trick:[...this.trick],
      trumpEvent, higherTrumpEvent,
    };

    this.lastTrick=[...this.trick]; // ★ store for display
    this.trick=[]; this.leadSuit=null;

    if (this.round===10) return {...result,...this.calculateFinalScores()};

    // ★ Early loss detection
    const teamPtsNow = this.trickPts[this.highestBidder]+
      this.teammates.reduce((s,t)=>s+(this.trickPts[t]||0),0);
    const remPts = totalRemainingPts(this.players);
    const maxPossible = teamPtsNow + remPts;
    const earlyLoss = (!this.earlyLossShown && maxPossible < this.highestBid)
      ? { bidder:this.highestBidder, bidderName:this.players[this.highestBidder].name,
          bid:this.highestBid, teamPtsNow, maxPossible }
      : null;
    if (earlyLoss) this.earlyLossShown=true;

    this.turnPlayer=winner.playerIndex;
    return { ...result, earlyLoss };
  }

  // ── Final scoring ──

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
    }
    this.phase='scoring'; this.matchRound=(this.matchRound||0)+1;
    this.roundHistory.push({
      roundNum:this.matchRound, bid, bidderIdx:bidder,
      bidderName:this.players[bidder].name, won, teamPts,
      teammates:[...this.teammates], scores:{...scores}, totals:{...this.totalScores},
    });
    const go={
      gameOver:true, bid, bidder, bidderName:this.players[bidder].name,
      teamPts, won, teammates:this.teammates,
      roundScores:{...this.roundScores}, totalScores:{...this.totalScores},
      trickPts:{...this.trickPts}, roundHistory:this.roundHistory, matchRound:this.matchRound,
    };
    this.lastGameover=go; return go;
  }

  // ── State snapshot for one player ──

  stateFor(playerIdx) {
    return {
      phase:this.phase, myIndex:playerIdx, myCards:this.players[playerIdx]?.cards||[],
      players:this.players.map((p,i)=>({
        name:p.name, cardCount:p.cards.length, isDealer:i===this.dealer,
        trickPts:this.trickPts[i]||0, roundScore:this.roundScores[i]||0,
        totalScore:this.totalScores[i]||0, reveal:this.reveal[i]||0,
        disconnected:p.disconnected||false, isBot:p.isBot||false,
      })),
      dealer:this.dealer, currentBidder:this.currentBidder,
      highestBid:this.highestBid, highestBidder:this.highestBidder,
      passed:[...this.passed], bidLog:this.bidLog,
      trump:this.trump, askedCardIds:this.askedCards.map(c=>c.id),
      teammates:this.teammates,
      turnPlayer:this.turnPlayer, trick:this.trick,
      lastTrick:this.lastTrick, lastTrickWinner:this.lastTrickWinner,
      round:this.round, leadSuit:this.leadSuit,
      roundHistory:this.roundHistory, matchRound:this.matchRound||0,
    };
  }
}

// ══════════════════════════════════════════════════════
//  SOCKET.IO HELPERS
// ══════════════════════════════════════════════════════

const games = {};

function broadcastState(roomId) {
  const game=games[roomId]; if (!game) return;
  const sockets=io.sockets.adapter.rooms.get(roomId); if (!sockets) return;
  for (const sid of sockets) {
    const s=io.sockets.sockets.get(sid);
    if (s&&s.playerIndex!==undefined) s.emit('state',game.stateFor(s.playerIndex));
  }
}

function broadcast(roomId, event, data) { io.to(roomId).emit(event,data); }

// ── Bot turn dispatcher ──
function scheduleBotTurn(roomId) {
  const game=games[roomId]; if (!game||game.phase!=='playing') return;
  const current=game.players[game.turnPlayer];
  if (!current||!current.isBot) return;
  setTimeout(()=>{
    if (!games[roomId]) return;
    const g=games[roomId];
    if (g.phase!=='playing'||!g.players[g.turnPlayer]?.isBot) return;
    const bidderIdx=g.highestBidder;
    const isTeam=g.turnPlayer===bidderIdx||g.teammates.includes(g.turnPlayer);
    const card=botChooseCard(
      g.players[g.turnPlayer].cards, g.trick, g.leadSuit, g.trump, isTeam
    );
    const result=g.playCard(g.turnPlayer, card.id);
    if (typeof result==='string') return; // error
    broadcastState(roomId);
    if (result?.trickDone) {
      broadcast(roomId,'trick',result);
      if (result.trumpEvent)      broadcast(roomId,'trump_event',result.trumpEvent);
      if (result.higherTrumpEvent) broadcast(roomId,'trump_event',result.higherTrumpEvent);
      if (result.earlyLoss)       broadcast(roomId,'early_loss',result.earlyLoss);
    }
    if (result?.gameOver) broadcast(roomId,'gameover',result);
    else scheduleBotTurn(roomId);
  }, 900); // 0.9 second delay so humans can follow
}

// ── Bot bidding ──
function scheduleBotBid(roomId) {
  const game=games[roomId]; if (!game||game.phase!=='bidding') return;
  const current=game.players[game.currentBidder];
  if (!current||!current.isBot) return;
  setTimeout(()=>{
    if (!games[roomId]) return;
    const g=games[roomId];
    if (g.phase!=='bidding'||!g.players[g.currentBidder]?.isBot) return;
    const botIdx=g.currentBidder;
    const botName=g.players[botIdx]?.name||'Bot'; // capture BEFORE placeBid shifts currentBidder
    const amount=botChooseBid(g.players[botIdx].cards, g.highestBid);
    const err=g.placeBid(botIdx, amount);
    if (err) return;
    const action=amount==='pass'?'✋ passed':`bid ${amount}`;
    broadcast(roomId,'msg',{text:`🤖 ${botName} ${action}`});
    broadcastState(roomId);
    if (g.phase==='trump'&&g.players[g.highestBidder]?.isBot) scheduleBotTrump(roomId);
    else scheduleBotBid(roomId);
  }, 800);
}

function scheduleBotTrump(roomId) {
  const game=games[roomId]; if (!game||game.phase!=='trump') return;
  setTimeout(()=>{
    const g=games[roomId]; if (!g||g.phase!=='trump') return;
    if (!g.players[g.highestBidder]?.isBot) return;
    const suit=botChooseTrump(g.players[g.highestBidder].cards);
    g.setTrump(g.highestBidder, suit);
    broadcast(roomId,'msg',{text:`🤖 ${g.players[g.highestBidder].name} chose trump: ${SUIT_SYMS[suit]} ${suit}`});
    broadcastState(roomId);
    if (g.phase==='ask'&&g.players[g.highestBidder]?.isBot) scheduleBotAsk(roomId);
  }, 800);
}

function scheduleBotAsk(roomId) {
  const game=games[roomId]; if (!game||game.phase!=='ask') return;
  setTimeout(()=>{
    const g=games[roomId]; if (!g||g.phase!=='ask') return;
    if (!g.players[g.highestBidder]?.isBot) return;
    const cardIds=botChooseAsk(g.players[g.highestBidder].cards, g.highestBidder);
    const err=g.askForCards(g.highestBidder, cardIds);
    if (err) return;
    const asked=g.askedCards.map(c=>c.rank+SUIT_SYMS[c.suit]).join(' & ');
    broadcast(roomId,'msg',{text:`🤖 ${g.players[g.highestBidder].name} asked for: ${asked}`});
    broadcastState(roomId);
    scheduleBotTurn(roomId);
  }, 800);
}

// ── Auto-pass disconnected player after 30s during bidding ──
function scheduleAutoPass(roomId, playerIdx) {
  const game=games[roomId]; if (!game) return;
  const timer=setTimeout(()=>{
    const g=games[roomId]; if (!g||g.phase!=='bidding') return;
    if (g.currentBidder!==playerIdx) return;
    const p=g.players[playerIdx]; if (!p||!p.disconnected) return;
    const err=g.placeBid(playerIdx,'pass');
    if (!err) {
      broadcast(roomId,'msg',{text:`⚠️ ${p.name} was auto-passed (disconnected)`});
      broadcastState(roomId);
      if (g.phase==='trump'&&g.players[g.highestBidder]?.isBot) scheduleBotTrump(roomId);
      else scheduleBotBid(roomId);
    }
  }, 30000);
  game._autoBidTimers[playerIdx]=timer;
}

// ══════════════════════════════════════════════════════
//  SOCKET EVENTS
// ══════════════════════════════════════════════════════

io.on('connection', socket => {
  console.log('Connected:', socket.id);
  socket.conn.on('upgrade', t=>console.log('Upgraded:',t.name,socket.id));

  // ── Create room ──
  socket.on('create', ({name})=>{
    let roomId;
    do { roomId=Math.random().toString(36).slice(2,8).toUpperCase(); } while(games[roomId]);
    const game=new Game(roomId);
    const idx=game.addPlayer(socket.id,name);
    games[roomId]=game;
    socket.join(roomId); socket.roomId=roomId; socket.playerIndex=idx;
    socket.emit('joined',{roomId,playerIndex:idx,name});
    broadcastState(roomId);
  });

  // ── Join room ──
  socket.on('join',({roomId,name})=>{
    const game=games[roomId];
    if (!game) { socket.emit('err','Room not found'); return; }
    const existingIdx=game.players.findIndex(p=>p.name===name);
    if (existingIdx!==-1) {
      const idx=game.reconnectPlayer(socket.id,name,existingIdx);
      if (idx!==-1) {
        socket.join(roomId); socket.roomId=roomId; socket.playerIndex=idx;
        socket.emit('joined',{roomId,playerIndex:idx,name});
        broadcastState(roomId);
        if (game.lastGameover) socket.emit('gameover',game.lastGameover);
        broadcast(roomId,'msg',{text:`${name} reconnected`});
        // Resume bot turns if it's now a human's turn and we were in playing
        if (game.phase==='playing') scheduleBotTurn(roomId);
        return;
      }
    }
    if (game.phase!=='waiting') { socket.emit('err','Game started – use your original name to rejoin'); return; }
    if (game.players.length>=5) { socket.emit('err','Room is full (5/5)'); return; }
    const idx=game.addPlayer(socket.id,name);
    socket.join(roomId); socket.roomId=roomId; socket.playerIndex=idx;
    socket.emit('joined',{roomId,playerIndex:idx,name});
    broadcastState(roomId);
    broadcast(roomId,'msg',{text:`${name} joined!`});
  });

  // ── Add bot ──
  socket.on('add_bot',({name})=>{
    console.log(`add_bot received | roomId=${socket.roomId} | playerIndex=${socket.playerIndex} | name=${name}`);
    const game=games[socket.roomId];
    if (!game)                      { socket.emit('err','add_bot: no game found for this room');      return; }
    if (game.phase!=='waiting')     { socket.emit('err','add_bot: game already started');             return; }
    if (socket.playerIndex!==0)     { socket.emit('err',`add_bot: only host can add bots (your index=${socket.playerIndex})`); return; }
    if (game.players.length>=5)     { socket.emit('err','add_bot: room is full (5/5)');               return; }
    const botName=name||`Bot ${game.players.length+1}`;
    const idx=game.addBot(botName);
    console.log(`Bot "${botName}" added at index ${idx} | room ${socket.roomId} now has ${game.players.length} players`);
    broadcastState(socket.roomId);
    broadcast(socket.roomId,'msg',{text:`🤖 Bot "${botName}" added`});
  });

  // ── Remove bot ──
  socket.on('remove_bot',({botIndex})=>{
    const game=games[socket.roomId];
    if (!game||game.phase!=='waiting'||socket.playerIndex!==0) return;
    if (!game.players[botIndex]?.isBot) { socket.emit('err','Not a bot'); return; }
    game.removePlayer(botIndex);
    // Re-index connected sockets
    const sockets=io.sockets.adapter.rooms.get(socket.roomId);
    if (sockets) for (const sid of sockets) {
      const s=io.sockets.sockets.get(sid);
      if (s&&s.playerIndex>botIndex) s.playerIndex--;
    }
    broadcastState(socket.roomId);
    broadcast(socket.roomId,'msg',{text:'🤖 Bot removed'});
  });

  // ── Reconnect ──
  socket.on('reconnect_player',({roomId,name,playerIndex})=>{
    const game=games[roomId];
    if (!game) { socket.emit('err','Session expired – please join again'); return; }
    const idx=game.reconnectPlayer(socket.id,name,playerIndex);
    if (idx===-1) { socket.emit('err','Could not restore session – please join again'); return; }
    socket.join(roomId); socket.roomId=roomId; socket.playerIndex=idx;
    socket.emit('joined',{roomId,playerIndex:idx,name});
    broadcastState(roomId);
    if (game.lastGameover) socket.emit('gameover',game.lastGameover);
    broadcast(roomId,'msg',{text:`${name} reconnected`});
    if (game.phase==='playing') scheduleBotTurn(roomId);
  });

  // ── Start ──
  socket.on('start',()=>{
    const game=games[socket.roomId];
    if (!game||socket.playerIndex!==0) return;
    if (game.players.length!==5) { socket.emit('err','Need exactly 5 players/bots to start'); return; }
    game.startRound();
    broadcastState(socket.roomId);
    broadcast(socket.roomId,'msg',{text:'Game started! Deal 1 done – bidding begins.'});
    scheduleBotBid(socket.roomId);
  });

  // ── Bid ──
  socket.on('bid',({amount})=>{
    const game=games[socket.roomId]; if (!game) return;
    const err=game.placeBid(socket.playerIndex,amount);
    if (err) { socket.emit('err',err); return; }
    const action=amount==='pass'?'✋ passed':`bid ${amount}`;
    broadcast(socket.roomId,'msg',{text:`${game.players[socket.playerIndex].name} ${action}`});
    broadcastState(socket.roomId);
    if (game.phase==='trump'&&game.players[game.highestBidder]?.isBot) scheduleBotTrump(socket.roomId);
    else scheduleBotBid(socket.roomId);
  });

  // ── Trump ──
  socket.on('trump',({suit})=>{
    const game=games[socket.roomId]; if (!game) return;
    const err=game.setTrump(socket.playerIndex,suit);
    if (err) { socket.emit('err',err); return; }
    broadcast(socket.roomId,'msg',{text:`Trump: ${SUIT_SYMS[suit]} ${suit} – Deal 2 done! Ask phase.`});
    broadcastState(socket.roomId);
    if (game.phase==='ask'&&game.players[game.highestBidder]?.isBot) scheduleBotAsk(socket.roomId);
  });

  // ── Ask ──
  socket.on('ask',({cardIds})=>{
    const game=games[socket.roomId]; if (!game) return;
    const err=game.askForCards(socket.playerIndex,cardIds);
    if (err) { socket.emit('err',err); return; }
    const asked=game.askedCards.map(c=>c.rank+SUIT_SYMS[c.suit]).join(' & ');
    broadcast(socket.roomId,'msg',{text:`${game.players[socket.playerIndex].name} asked for: ${asked} – play begins!`});
    broadcastState(socket.roomId);
    scheduleBotTurn(socket.roomId);
  });

  // ── Play ──
  socket.on('play',({cardId})=>{
    const game=games[socket.roomId]; if (!game) return;
    const result=game.playCard(socket.playerIndex,cardId);
    if (typeof result==='string') { socket.emit('err',result); return; }
    broadcastState(socket.roomId);
    // Broadcast trump events (can happen mid-trick or on trick completion)
    if (result?.trumpEvent)       broadcast(socket.roomId,'trump_event',result.trumpEvent);
    if (result?.higherTrumpEvent) broadcast(socket.roomId,'trump_event',result.higherTrumpEvent);
    if (result?.trickDone) {
      broadcast(socket.roomId,'trick',result);
      if (result.earlyLoss) broadcast(socket.roomId,'early_loss',result.earlyLoss);
    }
    if (result?.gameOver) broadcast(socket.roomId,'gameover',result);
    else scheduleBotTurn(socket.roomId); // single call – no double-fire
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
    const standings=game.players.map((p,i)=>({
      name:p.name, totalScore:game.totalScores[i]||0, index:i, isBot:p.isBot,
    })).sort((a,b)=>b.totalScore-a.totalScore);
    broadcast(roomId,'podium',{
      standings, roundHistory:game.roundHistory,
      totalScores:{...game.totalScores},
      matchRounds:game.matchRound||0,
      playerNames:game.players.map(p=>p.name),
    });
    setTimeout(()=>{
      const socks=io.sockets.adapter.rooms.get(roomId);
      if (socks) for (const sid of socks) {
        const s=io.sockets.sockets.get(sid);
        if (s) { s.leave(roomId); s.roomId=undefined; s.playerIndex=undefined; }
      }
      delete games[roomId];
    },7000);
  });

  // ── Leave ──
  socket.on('leave',()=>{
    const game=games[socket.roomId];
    if (!game||game.phase!=='waiting'||socket.playerIndex===0) return;
    const name=game.players[socket.playerIndex]?.name||'A player';
    game.removePlayer(socket.playerIndex);
    const sockets=io.sockets.adapter.rooms.get(socket.roomId);
    if (sockets) for (const sid of sockets) {
      const s=io.sockets.sockets.get(sid);
      if (s&&s.playerIndex>socket.playerIndex) s.playerIndex--;
    }
    socket.leave(socket.roomId);
    socket.emit('kicked',{reason:'You left the room'});
    broadcast(game.roomId,'msg',{text:`${name} left`});
    broadcastState(game.roomId);
    socket.roomId=undefined; socket.playerIndex=undefined;
  });

  // ── Remove player ──
  socket.on('remove_player',({targetIndex})=>{
    const game=games[socket.roomId];
    if (!game||game.phase!=='waiting'||socket.playerIndex!==0) return;
    if (targetIndex===0) { socket.emit('err','Cannot remove host'); return; }
    const targetName=game.players[targetIndex]?.name||'Player';
    const targetSid=game.removePlayer(targetIndex);
    const sockets=io.sockets.adapter.rooms.get(socket.roomId);
    if (sockets) for (const sid of sockets) {
      const s=io.sockets.sockets.get(sid);
      if (s&&s.playerIndex>targetIndex) s.playerIndex--;
    }
    if (targetSid) {
      const ts=io.sockets.sockets.get(targetSid);
      if (ts) { ts.leave(socket.roomId); ts.emit('kicked',{reason:'Removed by host'}); ts.roomId=undefined; ts.playerIndex=undefined; }
    }
    broadcast(socket.roomId,'msg',{text:`${targetName} was removed`});
    broadcastState(socket.roomId);
  });

  // ── Disconnect ──
  socket.on('disconnect',()=>{
    const game=games[socket.roomId];
    if (game&&socket.playerIndex!==undefined) {
      const name=game.players[socket.playerIndex]?.name||'A player';
      if (game.phase==='waiting') {
        game.removePlayer(socket.playerIndex);
        const sockets=io.sockets.adapter.rooms.get(socket.roomId);
        if (sockets) for (const sid of sockets) {
          const s=io.sockets.sockets.get(sid);
          if (s&&s.playerIndex>socket.playerIndex) s.playerIndex--;
        }
        broadcast(socket.roomId,'msg',{text:`${name} left`});
      } else {
        game.markDisconnected(socket.playerIndex);
        broadcast(socket.roomId,'msg',{text:`⚠️ ${name} disconnected – rejoin with same name`});
        // Schedule auto-pass if they were the current bidder
        if (game.phase==='bidding'&&game.currentBidder===socket.playerIndex)
          scheduleAutoPass(socket.roomId,socket.playerIndex);
      }
      broadcastState(socket.roomId);
    }
  });
});

// Clean dead rooms every 30 min
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
