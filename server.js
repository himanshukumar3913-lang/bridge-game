/**
 * Bridge Card Game – Server
 * Features: No Trump, 4-Ace illegal deal, skip-to-score, auto last trick,
 *           sorted scorecard, improved bots, viewers (up to 5)
 */

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors:{ origin:'*', methods:['GET','POST'] },
  transports:['polling','websocket'],
  allowUpgrades:true, pingTimeout:60000, pingInterval:25000, connectTimeout:45000,
});

app.use(express.static(path.join(__dirname,'public')));
app.get('/health',(_,res)=>res.send('OK'));

// ══════════════════════════════════════════════════════
//  CARD SYSTEM
// ══════════════════════════════════════════════════════

const SUITS     = ['spades','hearts','diamonds','clubs'];
const RANKS     = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const SUIT_SYMS = { spades:'♠', hearts:'♥', diamonds:'♦', clubs:'♣' };
const NO_TRUMP  = 'notrump'; // feature 1

function createDeck() {
  const deck=[];
  for (const suit of SUITS)
    for (const rank of RANKS) {
      if (rank==='2'&&(suit==='clubs'||suit==='diamonds')) continue;
      deck.push({rank,suit,id:`${rank}-${suit}`});
    }
  return deck; // 50 cards
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

// Feature 1: trump can be 'notrump' — in that case only lead suit matters
function beats(challenger, current, leadSuit, trump) {
  const isNoTrump = !trump || trump===NO_TRUMP;
  if (!isNoTrump) {
    const cT=challenger.suit===trump, wT=current.suit===trump;
    if ( cT&&!wT) return true;
    if (!cT&& wT) return false;
    if ( cT&& wT) return rankIndex(challenger.rank)>rankIndex(current.rank);
  }
  // No trump / lead-suit only
  const cL=challenger.suit===leadSuit, wL=current.suit===leadSuit;
  if ( wL&&!cL) return false;
  if (!wL&& cL) return true;
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
//  BOT AI  (Feature 9 – improved)
// ══════════════════════════════════════════════════════

function botChooseBid(hand, currentHighest) {
  const pts = hand.reduce((s,c)=>s+cardPoints(c),0);
  // Count high cards (A, K, Q) for confidence
  const highCards = hand.filter(c=>['A','K','Q'].includes(c.rank)).length;
  // Bid 75-85% of hand value depending on high card count
  const confidence = 0.72 + highCards * 0.02;
  const raw = Math.round(pts * confidence / 5) * 5;
  const bid = Math.max(160, Math.min(290, raw));
  if (bid <= currentHighest) return 'pass';
  return bid;
}

function botChooseTrump(hand) {
  // Prefer suit with most aces + kings, tie-break by count
  const suitScore = { spades:0, hearts:0, diamonds:0, clubs:0 };
  const suitCount = { spades:0, hearts:0, diamonds:0, clubs:0 };
  for (const c of hand) {
    suitScore[c.suit] += cardPoints(c);
    suitCount[c.suit]++;
  }
  // Add bonus for length (having 3+ cards in a suit)
  for (const s of SUITS) if (suitCount[s]>=3) suitScore[s]+=10;
  return SUITS.reduce((best,s)=>suitScore[s]>suitScore[best]?s:best,'spades');
}

function botChooseAsk(hand) {
  const myIds=new Set(hand.map(c=>c.id));
  const notMine=createDeck()
    .filter(c=>!myIds.has(c.id))
    .sort((a,b)=>cardPoints(b)-cardPoints(a)||rankIndex(b.rank)-rankIndex(a.rank));
  return [notMine[0].id, notMine[1].id];
}

/**
 * Improved bot card selection:
 * - Tracks what high cards remain (via trick history)
 * - If teammate is already winning, duck (play low)
 * - If opposing team member is winning, counter with minimum needed
 * - Consider bid target: if team already won enough, play safe
 */
function botChooseCard(hand, trick, leadSuit, trump, isOnBiddingTeam, teamPtsNow, bid, teammates, myIdx, players) {
  const isNoTrump = !trump || trump===NO_TRUMP;

  // Must-follow-suit rule
  const followable = leadSuit ? hand.filter(c=>c.suit===leadSuit) : [];
  const pool = followable.length>0 ? followable : hand;

  // Find current trick winner
  let currentWinner = trick.length>0 ? trick[0] : null;
  for (const t of trick) if (beats(t.card, currentWinner.card, leadSuit, trump)) currentWinner=t;

  const teammateWinning = currentWinner && (currentWinner.playerIndex===myIdx || teammates.includes(currentWinner.playerIndex));

  if (isOnBiddingTeam) {
    // If bid already secured (team has enough pts even with remaining), play relaxed
    const remaining = totalRemainingPtsList(pool.concat([]));
    if (teamPtsNow >= bid) {
      // Play lowest to save high cards? Actually just play lowest
      return [...pool].sort((a,b)=>cardPoints(a)-cardPoints(b)||rankIndex(a.rank)-rankIndex(b.rank))[0];
    }

    // If teammate already winning, duck — don't waste a high card
    if (teammateWinning && trick.length < 4) {
      const sorted=[...pool].sort((a,b)=>cardPoints(a)-cardPoints(b)||rankIndex(a.rank)-rankIndex(b.rank));
      return sorted[0];
    }

    // Try to win with minimum force
    if (currentWinner) {
      const canBeat=pool.filter(c=>beats(c,currentWinner.card,leadSuit,trump))
                       .sort((a,b)=>rankIndex(a.rank)-rankIndex(b.rank));
      if (canBeat.length>0) return canBeat[0];
    }

    // Can't beat — play trump if available and not notrump
    if (!isNoTrump && trump) {
      const trumps=hand.filter(c=>c.suit===trump).sort((a,b)=>rankIndex(a.rank)-rankIndex(b.rank));
      if (trumps.length>0 && followable.length===0) return trumps[0];
    }

    // Play highest in pool to maximise points
    return [...pool].sort((a,b)=>cardPoints(b)-cardPoints(a)||rankIndex(b.rank)-rankIndex(a.rank))[0];
  } else {
    // Opposing team: avoid winning tricks that have point cards, dump low cards
    const trickHasPoints = trick.reduce((s,t)=>s+cardPoints(t.card),0) + pool.reduce((s,c)=>s+cardPoints(c),0);

    if (teammateWinning) {
      // Our side winning — throw a high card to maximise opponent's loss!
      return [...pool].sort((a,b)=>cardPoints(b)-cardPoints(a)||rankIndex(b.rank)-rankIndex(a.rank))[0];
    }

    // They're winning — play lowest to not add points to their trick
    return [...pool].sort((a,b)=>cardPoints(a)-cardPoints(b)||rankIndex(a.rank)-rankIndex(b.rank))[0];
  }
}

function totalRemainingPtsList(cards) {
  return cards.reduce((s,c)=>s+cardPoints(c),0);
}

// ══════════════════════════════════════════════════════
//  GAME CLASS
// ══════════════════════════════════════════════════════

class Game {
  constructor(roomId) {
    this.roomId  = roomId;
    this.players = [];
    this.viewers = []; // Feature 10: { socketId, name }
    this.phase   = 'waiting';
    this.dealer  = 0;
    this.deck    = [];

    this.currentBidder=0; this.highestBid=155; this.highestBidder=-1;
    this.passed=new Set(); this.bidLog=[];

    this.trump=null; this.askedCards=[]; this.teammates=[]; this.reveal={};

    this.round=0; this.turnPlayer=0; this.trick=[]; this.leadSuit=null;
    this.lastTrick=[]; this.lastTrickWinner=-1; this.trickPts={};
    this.earlyLossShown=false;
    this.autoLastTrickInProgress=false; // Feature 4

    this.roundScores={}; this.totalScores={}; this.lastGameover=null;
    this.roundHistory=[]; this.matchRound=0;
    this._autoBidTimers={};
  }

  // ── Player/Viewer management ──

  addPlayer(socketId, name, isBot=false) {
    if (this.players.length>=5) return -1;
    const idx=this.players.length;
    this.players.push({socketId,name,cards:[],disconnected:false,lastSeen:Date.now(),isBot});
    this.trickPts[idx]=0; this.roundScores[idx]=0;
    this.totalScores[idx]=this.totalScores[idx]||0; this.reveal[idx]=0;
    return idx;
  }

  addBot(name) { return this.addPlayer(null,name||`Bot${this.players.length+1}`,true); }

  // Feature 10: add viewer
  addViewer(socketId, name) {
    if (this.viewers.length>=5) return false;
    this.viewers.push({socketId, name});
    return true;
  }

  removeViewer(socketId) {
    this.viewers = this.viewers.filter(v=>v.socketId!==socketId);
  }

  reconnectPlayer(socketId, name, playerIndex) {
    let idx=-1;
    if (playerIndex>=0&&playerIndex<this.players.length&&this.players[playerIndex].name===name) idx=playerIndex;
    if (idx===-1) idx=this.players.findIndex(p=>p.name===name);
    if (idx===-1) return -1;
    const p=this.players[idx];
    p.socketId=socketId; p.disconnected=false; p.lastSeen=Date.now();
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
      this.reveal[i]=this.reveal[i+1]||0;
    }
    const last=this.players.length;
    delete this.trickPts[last]; delete this.roundScores[last];
    delete this.totalScores[last]; delete this.reveal[last];
    return removed.socketId;
  }

  // ── Round start with 4-Ace illegal deal check (Feature 2) ──

  startRound() {
    this.deck=shuffle(createDeck());
    this.phase='bidding';
    this.passed=new Set(); this.bidLog=[];
    this.highestBid=155; this.highestBidder=-1;
    this.trump=null; this.askedCards=[]; this.teammates=[];
    this.round=0; this.trick=[]; this.leadSuit=null;
    this.lastTrick=[]; this.lastTrickWinner=-1;
    this.lastGameover=null; this.earlyLossShown=false;
    this.autoLastTrickInProgress=false;
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

    // Feature 2: check if any player holds all 4 Aces
    for (let i=0;i<5;i++) {
      const aces=this.players[i].cards.filter(c=>c.rank==='A');
      if (aces.length===4) {
        return { illegalDeal:true, playerName:this.players[i].name };
      }
    }
    return null;
  }

  // ── Bidding ──

  placeBid(playerIdx, amount) {
    if (this.phase!=='bidding')         return 'Not the bidding phase';
    if (playerIdx!==this.currentBidder) return 'Not your turn to bid';
    if (this.passed.has(playerIdx))     return 'You have already passed';
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

  // ── Trump → Deal 2 (Feature 1: 'notrump' allowed) ──

  setTrump(playerIdx, suit) {
    if (this.phase!=='trump')           return 'Not the trump selection phase';
    if (playerIdx!==this.highestBidder) return 'Only the highest bidder chooses trump';
    if (!SUITS.includes(suit) && suit!==NO_TRUMP) return 'Invalid trump choice';
    this.trump = suit===NO_TRUMP ? NO_TRUMP : suit;
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
    this.askedCards=resolved; this.teammates=[];
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
    if (this.autoLastTrickInProgress) return 'Last trick is auto-playing';
    const player=this.players[playerIdx];
    const cardIdx=player.cards.findIndex(c=>c.id===cardId);
    if (cardIdx===-1) return 'You do not have that card';
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

    // Trump events (not applicable for notrump)
    const isNoTrump = !this.trump || this.trump===NO_TRUMP;
    const trumpEvent = (!isNoTrump && this.leadSuit && card.suit!==this.leadSuit && card.suit===this.trump)
      ? {type:'trump_played', playerName:player.name, card} : null;

    let higherTrumpEvent=null;
    if (!isNoTrump && card.suit===this.trump && this.trick.length>1) {
      const prevTrumps=this.trick.slice(0,-1).filter(t=>t.card.suit===this.trump);
      if (prevTrumps.length>0) {
        const highest=prevTrumps.reduce((h,t)=>rankIndex(t.card.rank)>rankIndex(h.card.rank)?t:h);
        if (rankIndex(card.rank)>rankIndex(highest.card.rank))
          higherTrumpEvent={type:'higher_trump',playerName:player.name,card,beaten:highest.card};
      }
    }

    if (this.trick.length<5) {
      this.turnPlayer=(this.turnPlayer+4)%5;
      return {cardPlayed:true, trumpEvent, higherTrumpEvent};
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

    const result={
      trickDone:true, winnerIndex:winner.playerIndex,
      winnerName:this.players[winner.playerIndex].name,
      ptsWon:pts, trickPts:{...this.trickPts}, trick:[...this.trick],
      trumpEvent, higherTrumpEvent,
    };

    this.lastTrick=[...this.trick];
    this.trick=[]; this.leadSuit=null;

    if (this.round===10) return {...result,...this.calculateFinalScores()};

    // Early loss detection
    const teamPtsNow=this.trickPts[this.highestBidder]+
      this.teammates.reduce((s,t)=>s+(this.trickPts[t]||0),0);
    const remPts=totalRemainingPts(this.players);
    const maxPossible=teamPtsNow+remPts;
    const earlyLoss=(!this.earlyLossShown&&maxPossible<this.highestBid)
      ?{bidder:this.highestBidder,bidderName:this.players[this.highestBidder].name,
        bid:this.highestBid,teamPtsNow,maxPossible}:null;
    if (earlyLoss) this.earlyLossShown=true;

    this.turnPlayer=winner.playerIndex;

    // Feature 4: auto-play last trick flag
    const isLastTrick = (this.round===9);
    return {...result, earlyLoss, isLastTrick, lastTrickLeader:winner.playerIndex};
  }

  // ── Feature 3: skip remaining tricks, go straight to score ──

  skipToScore() {
    if (this.phase!=='playing') return null;
    // Award zero points for unplayed cards (trick already started gets nullified)
    this.trick=[]; this.leadSuit=null;
    return this.calculateFinalScores();
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
      trump:this.trump,
      teammates:[...this.teammates], scores:{...scores}, totals:{...this.totalScores},
    });
    const go={
      gameOver:true, bid, bidder, bidderName:this.players[bidder].name,
      teamPts, won, teammates:this.teammates, trump:this.trump,
      roundScores:{...this.roundScores}, totalScores:{...this.totalScores},
      trickPts:{...this.trickPts}, roundHistory:this.roundHistory, matchRound:this.matchRound,
    };
    this.lastGameover=go; return go;
  }

  // ── State for a player ──

  stateFor(playerIdx) {
    return {
      phase:this.phase, myIndex:playerIdx, myCards:this.players[playerIdx]?.cards||[],
      players:this.players.map((p,i)=>({
        name:p.name, cardCount:p.cards.length, isDealer:i===this.dealer,
        trickPts:this.trickPts[i]||0, roundScore:this.roundScores[i]||0,
        totalScore:this.totalScores[i]||0, reveal:this.reveal[i]||0,
        disconnected:p.disconnected||false, isBot:p.isBot||false,
      })),
      viewerCount:this.viewers.length,
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
    };
  }

  // Feature 10: viewer state (no hand cards)
  viewerStateFor() {
    const s=this.stateFor(-1);
    s.myCards=[]; s.isViewer=true;
    return s;
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
    else if (s.isViewer) s.emit('state',game.viewerStateFor()); // Feature 10
  }
}

function broadcast(roomId, event, data) { io.to(roomId).emit(event,data); }

// ── Bot helpers ──

function scheduleBotTurn(roomId) {
  const game=games[roomId]; if (!game||game.phase!=='playing') return;
  if (game.autoLastTrickInProgress) return;
  const current=game.players[game.turnPlayer];
  if (!current||!current.isBot) return;
  setTimeout(()=>{
    if (!games[roomId]) return;
    const g=games[roomId];
    if (g.phase!=='playing'||!g.players[g.turnPlayer]?.isBot||g.autoLastTrickInProgress) return;
    const bidderIdx=g.highestBidder;
    const isTeam=g.turnPlayer===bidderIdx||g.teammates.includes(g.turnPlayer);
    const teamPtsNow=(g.trickPts[bidderIdx]||0)+g.teammates.reduce((s,t)=>s+(g.trickPts[t]||0),0);
    const card=botChooseCard(
      g.players[g.turnPlayer].cards, g.trick, g.leadSuit, g.trump,
      isTeam, teamPtsNow, g.highestBid, g.teammates, g.turnPlayer, g.players
    );
    const result=g.playCard(g.turnPlayer, card.id);
    if (typeof result==='string') return;
    broadcastState(roomId);
    handlePlayResult(roomId, result);
  },900);
}

function scheduleBotBid(roomId) {
  const game=games[roomId]; if (!game||game.phase!=='bidding') return;
  const current=game.players[game.currentBidder];
  if (!current||!current.isBot) return;
  setTimeout(()=>{
    if (!games[roomId]) return;
    const g=games[roomId];
    if (g.phase!=='bidding'||!g.players[g.currentBidder]?.isBot) return;
    const botIdx=g.currentBidder;
    const botName=g.players[botIdx]?.name||'Bot';
    const amount=botChooseBid(g.players[botIdx].cards, g.highestBid);
    const err=g.placeBid(botIdx, amount);
    if (err) return;
    broadcast(roomId,'msg',{text:`🤖 ${botName} ${amount==='pass'?'✋ passed':`bid ${amount}`}`});
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
    g.setTrump(g.highestBidder,suit);
    const trumpLabel=suit===NO_TRUMP?'No Trump':`${SUIT_SYMS[suit]} ${suit}`;
    broadcast(roomId,'msg',{text:`🤖 ${g.players[g.highestBidder].name} chose: ${trumpLabel}`});
    broadcastState(roomId);
    if (g.phase==='ask'&&g.players[g.highestBidder]?.isBot) scheduleBotAsk(roomId);
  },800);
}

function scheduleBotAsk(roomId) {
  const game=games[roomId]; if (!game||game.phase!=='ask') return;
  setTimeout(()=>{
    const g=games[roomId]; if (!g||g.phase!=='ask') return;
    if (!g.players[g.highestBidder]?.isBot) return;
    const cardIds=botChooseAsk(g.players[g.highestBidder].cards);
    const err=g.askForCards(g.highestBidder,cardIds);
    if (err) return;
    const asked=g.askedCards.map(c=>c.rank+SUIT_SYMS[c.suit]).join(' & ');
    broadcast(roomId,'msg',{text:`🤖 ${g.players[g.highestBidder].name} asked: ${asked}`});
    broadcastState(roomId);
    // Feature 4: check if we should auto-play last trick
    scheduleAutoLastTrickCheck(roomId);
    scheduleBotTurn(roomId);
  },800);
}

// Feature 4: auto-play last trick
function scheduleAutoLastTrickCheck(roomId) {
  // Called after a trick resolves and isLastTrick===true
  // Do nothing here – triggered from handlePlayResult
}

function autoPlayLastTrick(roomId, leaderIdx) {
  const game=games[roomId];
  if (!game||game.phase!=='playing') return;
  game.autoLastTrickInProgress=true;
  broadcastState(roomId);
  broadcast(roomId,'msg',{text:'🃏 Last trick – auto-playing!'});

  // Build play order starting from leaderIdx, anti-clockwise
  const order=[];
  for (let i=0;i<5;i++) order.push((leaderIdx+i*4)%5); // anti-clockwise = +4 mod 5

  let delay=500;
  for (const playerIdx of order) {
    setTimeout(()=>{
      const g=games[roomId]; if (!g||g.phase!=='playing') return;
      const hand=g.players[playerIdx].cards;
      if (hand.length===0) return;
      const cardId=hand[0].id; // only 1 card remains
      // Temporarily disable lock for this auto-play
      g.autoLastTrickInProgress=false;
      const result=g.playCard(playerIdx, cardId);
      g.autoLastTrickInProgress = (result?.cardPlayed===true); // re-lock if trick not done
      broadcastState(roomId);
      if (result?.cardPlayed) {
        // card played, trick not done yet, keep going
      }
      if (result?.trickDone||result?.gameOver) {
        g.autoLastTrickInProgress=false;
        broadcast(roomId,'trick',result);
        if (result.earlyLoss) broadcast(roomId,'early_loss',result.earlyLoss);
        if (result.gameOver) {
          // Hold 7 seconds then emit gameover
          setTimeout(()=>broadcast(roomId,'gameover',result),7000);
        }
      }
    }, delay);
    delay+=1000;
  }
}

// Central handler for play results
function handlePlayResult(roomId, result) {
  if (!result) return;
  if (result.trumpEvent)       broadcast(roomId,'trump_event',result.trumpEvent);
  if (result.higherTrumpEvent) broadcast(roomId,'trump_event',result.higherTrumpEvent);
  if (result.trickDone) {
    broadcast(roomId,'trick',result);
    if (result.earlyLoss) broadcast(roomId,'early_loss',result.earlyLoss);
    // Feature 4: auto last trick
    if (result.isLastTrick&&!result.gameOver) {
      autoPlayLastTrick(roomId, result.lastTrickLeader);
      return;
    }
  }
  if (result.gameOver) broadcast(roomId,'gameover',result);
  else scheduleBotTurn(roomId);
}

function scheduleAutoPass(roomId, playerIdx) {
  const game=games[roomId]; if (!game) return;
  const timer=setTimeout(()=>{
    const g=games[roomId]; if (!g||g.phase!=='bidding') return;
    if (g.currentBidder!==playerIdx) return;
    const p=g.players[playerIdx]; if (!p||!p.disconnected) return;
    const err=g.placeBid(playerIdx,'pass');
    if (!err) {
      broadcast(roomId,'msg',{text:`⚠️ ${p.name} auto-passed (disconnected)`});
      broadcastState(roomId);
      if (g.phase==='trump'&&g.players[g.highestBidder]?.isBot) scheduleBotTrump(roomId);
      else scheduleBotBid(roomId);
    }
  },30000);
  game._autoBidTimers[playerIdx]=timer;
}

// ══════════════════════════════════════════════════════
//  SOCKET EVENTS
// ══════════════════════════════════════════════════════

io.on('connection', socket=>{
  console.log('Connected:',socket.id);
  socket.conn.on('upgrade',t=>console.log('Upgraded:',t.name,socket.id));

  // ── Create ──
  socket.on('create',({name})=>{
    let roomId;
    do { roomId=Math.random().toString(36).slice(2,8).toUpperCase(); } while(games[roomId]);
    const game=new Game(roomId);
    const idx=game.addPlayer(socket.id,name);
    games[roomId]=game;
    socket.join(roomId); socket.roomId=roomId; socket.playerIndex=idx;
    socket.emit('joined',{roomId,playerIndex:idx,name});
    broadcastState(roomId);
  });

  // ── Join (player or viewer) ──
  socket.on('join',({roomId,name})=>{
    const game=games[roomId];
    if (!game) { socket.emit('err','Room not found'); return; }

    // Reconnect existing player by name
    const existingIdx=game.players.findIndex(p=>p.name===name);
    if (existingIdx!==-1) {
      const idx=game.reconnectPlayer(socket.id,name,existingIdx);
      if (idx!==-1) {
        socket.join(roomId); socket.roomId=roomId; socket.playerIndex=idx;
        socket.emit('joined',{roomId,playerIndex:idx,name});
        broadcastState(roomId);
        if (game.lastGameover) socket.emit('gameover',game.lastGameover);
        broadcast(roomId,'msg',{text:`${name} reconnected`});
        if (game.phase==='playing') scheduleBotTurn(roomId);
        return;
      }
    }

    // Feature 10: if game started and all 5 players present, try to join as viewer
    if (game.phase!=='waiting') {
      const alreadyViewer=game.viewers.find(v=>v.name===name);
      if (alreadyViewer) {
        alreadyViewer.socketId=socket.id;
        socket.join(roomId); socket.roomId=roomId; socket.isViewer=true;
        socket.emit('joined_as_viewer',{roomId,name,viewerCount:game.viewers.length});
        socket.emit('state',game.viewerStateFor());
        broadcast(roomId,'msg',{text:`👁 ${name} is watching`});
        return;
      }
      if (game.viewers.length<5) {
        const added=game.addViewer(socket.id,name);
        if (added) {
          socket.join(roomId); socket.roomId=roomId; socket.isViewer=true;
          socket.emit('joined_as_viewer',{roomId,name,viewerCount:game.viewers.length});
          socket.emit('state',game.viewerStateFor());
          broadcastState(roomId); // updates viewer count for players
          broadcast(roomId,'msg',{text:`👁 ${name} is watching`});
          return;
        }
      }
      socket.emit('err','Game started – use your original name to rejoin, or viewer slots are full');
      return;
    }

    if (game.players.length>=5) { socket.emit('err','Room is full (5/5)'); return; }
    const idx=game.addPlayer(socket.id,name);
    socket.join(roomId); socket.roomId=roomId; socket.playerIndex=idx;
    socket.emit('joined',{roomId,playerIndex:idx,name});
    broadcastState(roomId);
    broadcast(roomId,'msg',{text:`${name} joined!`});
  });

  // ── Add bot ──
  socket.on('add_bot',({name})=>{
    const game=games[socket.roomId];
    if (!game||game.phase!=='waiting'||socket.playerIndex!==0) { socket.emit('err','Only host can add bots in lobby'); return; }
    if (game.players.length>=5) { socket.emit('err','Room is full'); return; }
    const botName=name||`Bot ${game.players.length+1}`;
    game.addBot(botName);
    broadcastState(socket.roomId);
    broadcast(socket.roomId,'msg',{text:`🤖 Bot "${botName}" added`});
  });

  // ── Remove bot ──
  socket.on('remove_bot',({botIndex})=>{
    const game=games[socket.roomId];
    if (!game||game.phase!=='waiting'||socket.playerIndex!==0) return;
    if (!game.players[botIndex]?.isBot) { socket.emit('err','Not a bot'); return; }
    game.removePlayer(botIndex);
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
    if (game.players.length!==5) { socket.emit('err','Need exactly 5 players/bots'); return; }
    const illegal=game.startRound();
    if (illegal) {
      // Feature 2: illegal deal – redeal automatically
      broadcast(socket.roomId,'illegal_deal',{playerName:illegal.playerName});
      // Auto-retry after 3 seconds
      setTimeout(()=>{
        const g=games[socket.roomId]; if (!g) return;
        const ill2=g.startRound();
        if (ill2) { broadcast(socket.roomId,'illegal_deal',{playerName:ill2.playerName}); return; }
        broadcastState(socket.roomId);
        broadcast(socket.roomId,'msg',{text:'Cards redealt! Bidding begins.'});
        scheduleBotBid(socket.roomId);
      },3000);
      return;
    }
    broadcastState(socket.roomId);
    broadcast(socket.roomId,'msg',{text:'Game started! Deal 1 done – bidding begins.'});
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
    const err=game.setTrump(socket.playerIndex,suit);
    if (err) { socket.emit('err',err); return; }
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
    handlePlayResult(socket.roomId, result);
  });

  // ── Skip to score (Feature 3) ──
  socket.on('skip_to_score',()=>{
    const game=games[socket.roomId];
    if (!game||socket.playerIndex!==0||game.phase!=='playing') return;
    const result=game.skipToScore();
    if (!result) return;
    broadcastState(socket.roomId);
    broadcast(socket.roomId,'gameover',result);
    broadcast(socket.roomId,'msg',{text:'Host skipped to final scorecard'});
  });

  // ── Next round ──
  socket.on('next',()=>{
    const game=games[socket.roomId];
    if (!game||socket.playerIndex!==0) return;
    game.dealer=(game.dealer+1)%5;
    const illegal=game.startRound();
    if (illegal) {
      broadcast(socket.roomId,'illegal_deal',{playerName:illegal.playerName});
      setTimeout(()=>{
        const g=games[socket.roomId]; if (!g) return;
        const ill2=g.startRound();
        if (ill2) { broadcast(socket.roomId,'illegal_deal',{playerName:ill2.playerName}); return; }
        broadcastState(socket.roomId);
        broadcast(socket.roomId,'msg',{text:'Cards redealt! Bidding begins.'});
        scheduleBotBid(socket.roomId);
      },3000);
      return;
    }
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
        if (s) { s.leave(roomId); s.roomId=undefined; s.playerIndex=undefined; s.isViewer=undefined; }
      }
      delete games[roomId];
    },7000);
  });

  // ── Leave ──
  socket.on('leave',()=>{
    const game=games[socket.roomId];
    if (!game) return;
    if (socket.isViewer) {
      game.removeViewer(socket.id);
      broadcast(socket.roomId,'msg',{text:`👁 Viewer left`});
      broadcastState(socket.roomId);
      socket.leave(socket.roomId); socket.isViewer=undefined; socket.roomId=undefined;
      return;
    }
    if (game.phase!=='waiting'||socket.playerIndex===0) return;
    const name=game.players[socket.playerIndex]?.name||'A player';
    game.removePlayer(socket.playerIndex);
    const sockets=io.sockets.adapter.rooms.get(socket.roomId);
    if (sockets) for (const sid of sockets) {
      const s=io.sockets.sockets.get(sid);
      if (s&&s.playerIndex>socket.playerIndex) s.playerIndex--;
    }
    socket.leave(socket.roomId); socket.emit('kicked',{reason:'You left the room'});
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
    if (!game) return;
    if (socket.isViewer) {
      game.removeViewer(socket.id);
      broadcastState(socket.roomId);
      return;
    }
    if (socket.playerIndex===undefined) return;
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
      if (game.phase==='bidding'&&game.currentBidder===socket.playerIndex)
        scheduleAutoPass(socket.roomId,socket.playerIndex);
    }
    broadcastState(socket.roomId);
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
