# 🃏 Bridge Card Game – Complete Beginner's Guide

Your 5-player Bridge game is fully built and ready to run!
Follow this guide step-by-step — no prior coding experience needed.

---

## 📁 What's in This Folder

```
bridge-game/
├── server.js          ← The brain of the game (runs on your computer / server)
├── package.json       ← Tells Node.js which tools this app needs
└── public/
    ├── index.html     ← The game's web page
    ├── style.css      ← Makes it look beautiful
    └── client.js      ← Makes the game interactive in the browser
```

---

## 🚀 Step 1 – Install Node.js (one-time setup)

Node.js is the engine that runs the game server.

1. Go to: **https://nodejs.org**
2. Download the **LTS version** (the green button)
3. Install it like a normal program (Next → Next → Finish)
4. To verify, open a terminal and type:
   ```
   node --version
   ```
   You should see something like `v20.x.x`

> **On Windows:** Search "Command Prompt" or "PowerShell" in the Start menu.
> **On Mac:** Search "Terminal" in Spotlight (Cmd+Space).

---

## 🔧 Step 2 – Install the Game's Libraries (one-time setup)

1. Open your terminal
2. Navigate to the game folder:
   ```
   cd path/to/bridge-game
   ```
   *(e.g. `cd Desktop/bridge-game`)*
3. Run:
   ```
   npm install
   ```
   Takes ~30 seconds. Downloads Express and Socket.IO.

---

## ▶️ Step 3 – Run the Game Locally

```
node server.js
```

You'll see:
```
🃏 Bridge Game Server running at http://localhost:3000
```

Open your browser at: **http://localhost:3000**

**For friends on the same Wi-Fi:**
- Windows: run `ipconfig`, find "IPv4 Address" (e.g. `192.168.1.5`)
- Mac/Linux: run `ifconfig`, find `inet` under `en0`
- Friends open: `http://192.168.1.5:3000`

---

## 🃏 How to Play – Complete Rules

### Lobby
1. One person clicks **"Create Room"** → gets a 6-letter code
2. Others click **"Join Room"** → enter the code
3. Host clicks **"Start Game"** when all 5 are seated
   *(Game cannot start with fewer or more than 5 players)*

---

### Phase 1 – Deal 1 (6 cards each)
- Dealer is chosen; 6 cards dealt clockwise to each player
- Each player now has 6 cards

---

### Phase 2 – Bidding
- Starts with the player to the **right of the dealer**, then proceeds **anti-clockwise**
- Each player can **bid or pass**
- Valid bids: any **multiple of 5 from 160 to 290** (inclusive)
- Each bid must be **higher** than the previous bid
- **Pass** = you cannot bid again this round
- Bidding ends when **4 players have passed**
- The remaining player is the **highest bidder**

---

### Phase 3 – Trump Selection
- The highest bidder picks one of the 4 suits as **trump**
- After they choose, **Deal 2 happens automatically** (4 more cards dealt clockwise)
- Each player now has **10 cards**

---

### Phase 4 – Ask
- The highest bidder picks **any 2 cards not in their 10-card hand**
- This ask is **public** — everyone sees which cards were asked for
- The players who hold those cards are the bidder's **secret teammates**
  - Nobody else knows who holds them — until they play the asked cards

---

### Phase 5 – Playing (10 tricks)
- The player to the **right of the dealer** plays the first card
- Play continues **anti-clockwise**
- **Must follow suit** if you have a card of the lead suit
- If you have no card of the lead suit, you may play any card
- **Trump beats all other suits**
- If multiple players play trump, the **highest trump wins**
- A card of neither the lead suit nor trump **never wins**
- The winner of each trick leads the next one

---

### Teammate Reveal
- When a player plays one of the asked cards, they are shown as **🤝 Teammate**
- If the same player plays both asked cards, they become **🤝🤝 Double Teammate**
- Teams: if cards are with 2 different players → 3 vs 2; if same player → 2 vs 3

---

### Phase 6 – Scoring

**Bidder:**
- Wins: **+bid** points
- Loses: **−bid** points

**Two separate teammates:**
- Wins: **+⌈bid ÷ 3⌉** each (rounded up to next multiple of 5)
- Loses: **−⌈bid ÷ 3⌉** each

**One player holds both asked cards:**
- Wins: **+⌈2 × bid ÷ 3⌉** (rounded up to next multiple of 5)
- Loses: **−⌈2 × bid ÷ 3⌉**

**Opponents: always 0**

---

## 🎴 Card Points Reference

| Card | Points |
|---|---|
| Ace (all 4 suits) | 20 pts each |
| King, Queen, Jack, Ten (all 4 suits) | 10 pts each |
| Five (all 4 suits) | 5 pts each |
| **Three of Spades** | **30 pts** |
| All other cards | 0 pts |
| **Total** | **290 pts** |

**Card order (high to low):** A > K > Q > J > 10 > 9 > 8 > 7 > 6 > 5 > 4 > 3 > 2

---

## 🌐 Step 4 – Host Online for Free (Anyone Can Join)

Use **Render.com**:

1. Upload your code to GitHub:
   - Create account at **https://github.com**
   - Download GitHub Desktop: **https://desktop.github.com**
   - Create a new repository and drag your `bridge-game` folder in
   - Click "Commit to main" → "Push to origin"

2. Go to **https://render.com**, sign in with GitHub

3. Click **New +** → **Web Service** → connect your repo

4. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Plan:** Free

5. Click **Create Web Service** → get a URL like `https://bridge-game-xyz.onrender.com`

6. **Share that link with your friends — that's all they need!**

> ⚠️ Free Render servers sleep after 15 min of inactivity (~30 sec to wake). For always-on, upgrade to Starter ($7/month) or use Railway.app.

---

## 📱 Step 5 – Android (Play Store)

To publish on the Play Store, use **PWABuilder**:

1. Deploy online (Step 4)
2. Go to **https://www.pwabuilder.com**
3. Paste your game URL
4. Click **Start** → **Android** → **Download Package**
5. Upload the `.aab` file to Google Play Console ($25 one-time developer fee)

---

## 🐛 Common Issues

| Problem | Fix |
|---|---|
| `node: command not found` | Reinstall Node.js from nodejs.org |
| `npm install` fails | Make sure you're in the bridge-game folder |
| Port 3000 in use | Change `3000` to `3001` in server.js |
| Friends can't connect locally | Check same Wi-Fi; check firewall settings |
| Only host can see Start button | This is correct — host controls the start |

---

Happy playing! 🃏
