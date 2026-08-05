const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static('public'));

// --- OFFICIAL TALLY-UP DICE FACES ---
const DICE = {
  red:    ["★", "★", "★", 50, "50_CIRCLED", 100],
  orange: ["★", "★", "★", 60, "70_CIRCLED", 70],
  yellow: ["★", "★", 20, 20, "40_CIRCLED", 70],
  green:  ["★", "★", 30, "40_CIRCLED", 40, 40],
  blue:   ["★", "10_CIRCLED", "10_CIRCLED", 10, 20, 50],
  pink:   ["★", "20_CIRCLED", "20_CIRCLED", 20, 20, 20],
  seventh: ["+100", "-100", "x2", "+1", "+2", "+3"]
};

let gameState = {
  players: [],          
  currentPlayerIndex: 0,
  roundScore: 0,
  selectedDice: [],     
  phase: 'SELECT_DICE', // 'SELECT_DICE', 'ROLL_WHITE_DIE', 'EXTRA_DICE_CHOICE', 'ROLL_PLUS_THREE', 'TALLY_UP_RACE', 'DECISION_MOMENT', 'ROUND_OVER', 'GAME_OVER'
  lastRoll: null,
  pendingExtraDiceCount: 0,
  bannerMessage: null,
  winner: null,
  tallyClaimed: false
};

function rollDice(color) {
  const faces = DICE[color];
  return faces[Math.floor(Math.random() * faces.length)];
}

function parseFace(face) {
  if (face === "★") return { val: 0, isStar: true, isCircled: false };
  if (typeof face === "string" && face.endsWith("_CIRCLED")) {
    const rawVal = face.replace("_CIRCLED", "");
    return { val: parseInt(rawVal, 10), isStar: false, isCircled: true };
  }
  return { val: Number(face), isStar: false, isCircled: false };
}

io.on('connection', (socket) => {
  socket.on('joinGame', (name) => {
    gameState.players.push({
      id: socket.id,
      name: name || `Player ${gameState.players.length + 1}`,
      totalScore: 0,
      roundScore: 0,
      status: 'IN',
      madeDecision: false
    });
    io.emit('stateUpdate', gameState);
  });

  socket.on('resetGame', () => {
    gameState = {
      players: gameState.players.map(p => ({
        ...p,
        totalScore: 0,
        roundScore: 0,
        status: 'IN',
        madeDecision: false
      })),
      currentPlayerIndex: 0,
      roundScore: 0,
      selectedDice: [],
      phase: 'SELECT_DICE',
      lastRoll: null,
      pendingExtraDiceCount: 0,
      bannerMessage: null,
      winner: null,
      tallyClaimed: false
    };
    io.emit('stateUpdate', gameState);
  });

  socket.on('selectDice', (chosenColors) => {
    const player = gameState.players[gameState.currentPlayerIndex];
    if (socket.id !== player.id || gameState.phase !== 'SELECT_DICE') return;

    if (chosenColors.length === 3) {
      gameState.selectedDice = chosenColors;
      io.emit('triggerRollAnimation', { mode: 'NEW', colors: chosenColors });
      setTimeout(() => {
        startRollSession();
      }, 650);
    }
  });

  socket.on('claimTallyUp', () => {
    if (gameState.phase === 'TALLY_UP_RACE' && !gameState.tallyClaimed) {
      gameState.tallyClaimed = true;
      const winnerPlayer = gameState.players.find(p => p.id === socket.id);

      gameState.players.forEach(p => {
        const added = (p.id === winnerPlayer.id) ? 200 : 100;
        p.totalScore += added;
      });

      io.emit('dramaticTallyUp', {
        winnerName: winnerPlayer ? winnerPlayer.name : 'Someone'
      });

      openDecisionMoment();
    }
  });

  socket.on('rollWhiteDie', () => {
    const player = gameState.players[gameState.currentPlayerIndex];
    if (socket.id !== player.id || gameState.phase !== 'ROLL_WHITE_DIE') return;

    io.emit('triggerRollAnimation', { mode: 'APPEND', colors: ['seventh'] });
    
    setTimeout(() => {
      const seventhFace = rollDice('seventh');
      gameState.lastRoll.seventh = seventhFace;

      let currentRollSum = gameState.lastRoll.results.reduce((acc, r) => acc + parseFace(r.face).val, 0);

      if (seventhFace === "+100") {
        applyRollPoints(currentRollSum + 100);
      } else if (seventhFace === "-100") {
        applyRollPoints(currentRollSum - 100);
      } else if (seventhFace === "x2") {
        let totalBeforeDouble = gameState.roundScore + currentRollSum;
        let doubledTotal = totalBeforeDouble * 2;
        
        gameState.roundScore = doubledTotal;
        gameState.players.forEach(p => {
          if (p.status === 'IN') p.roundScore = doubledTotal;
        });
        openDecisionMoment();
      } else if (["+1", "+2"].includes(seventhFace)) {
        gameState.roundScore += currentRollSum;
        gameState.players.forEach(p => {
          if (p.status === 'IN') p.roundScore += currentRollSum;
        });
        gameState.pendingExtraDiceCount = parseInt(seventhFace.replace("+", ""), 10);
        gameState.phase = 'EXTRA_DICE_CHOICE';
        io.emit('stateUpdate', gameState);
      } else if (seventhFace === "+3") {
        gameState.roundScore += currentRollSum;
        gameState.players.forEach(p => {
          if (p.status === 'IN') p.roundScore += currentRollSum;
        });
        gameState.phase = 'ROLL_PLUS_THREE';
        io.emit('stateUpdate', gameState);
      }
    }, 650);
  });

  socket.on('selectExtraDice', (extraColors) => {
    const player = gameState.players[gameState.currentPlayerIndex];
    if (socket.id !== player.id || gameState.phase !== 'EXTRA_DICE_CHOICE') return;

    if (extraColors.length === gameState.pendingExtraDiceCount) {
      io.emit('triggerRollAnimation', { mode: 'APPEND', colors: extraColors });
      setTimeout(() => {
        resolveExtraRolls(extraColors);
      }, 650);
    }
  });

  socket.on('rollPlusThree', () => {
    const player = gameState.players[gameState.currentPlayerIndex];
    if (socket.id !== player.id || gameState.phase !== 'ROLL_PLUS_THREE') return;

    const unchosen = Object.keys(DICE).filter(c => c !== 'seventh' && !gameState.selectedDice.includes(c));
    io.emit('triggerRollAnimation', { mode: 'APPEND', colors: unchosen });
    
    setTimeout(() => {
      resolveExtraRolls(unchosen);
    }, 650);
  });

  socket.on('rollAgain', () => {
    const player = gameState.players[gameState.currentPlayerIndex];
    if (socket.id !== player.id || gameState.phase !== 'DECISION_MOMENT') return;
    
    const pendingInPlayers = gameState.players.filter(p => p.status === 'IN' && !p.madeDecision);
    if (pendingInPlayers.length > 0) return;

    io.emit('triggerRollAnimation', { mode: 'NEW', colors: gameState.selectedDice });
    setTimeout(() => {
      startRollSession();
    }, 650);
  });

  socket.on('startNextRound', () => {
    const player = gameState.players[gameState.currentPlayerIndex];
    if (socket.id !== player.id || gameState.phase !== 'ROUND_OVER') return;

    gameState.roundScore = 0;
    gameState.selectedDice = [];
    gameState.lastRoll = null;
    gameState.bannerMessage = null;
    gameState.phase = 'SELECT_DICE';

    io.emit('stateUpdate', gameState);
  });

  socket.on('makeDecision', (choice) => {
    const player = gameState.players.find(p => p.id === socket.id);
    if (player && gameState.phase === 'DECISION_MOMENT' && player.status === 'IN') {
      player.madeDecision = true;
      if (choice === 'OUT') {
        player.status = 'OUT';
        player.totalScore += player.roundScore;
        player.roundScore = 0;
      }

      const remainingIn = gameState.players.filter(p => p.status === 'IN');
      if (remainingIn.length === 0) {
        endRound("All players opted OUT! Round ended.");
        return;
      }

      io.emit('stateUpdate', gameState);
    }
  });

  socket.on('disconnect', () => {
    gameState.players = gameState.players.filter(p => p.id !== socket.id);
    io.emit('stateUpdate', gameState);
  });
});

function startRollSession() {
  gameState.bannerMessage = null;
  gameState.tallyClaimed = false;
  gameState.players.forEach(p => { p.madeDecision = false; });

  const activeDice = [...gameState.selectedDice];
  const results = activeDice.map(color => ({ color, face: rollDice(color) }));
  
  let stars = 0;
  let circledFound = false;
  let baseSum = 0;

  results.forEach(r => {
    const parsed = parseFace(r.face);
    if (parsed.isStar) stars++;
    if (parsed.isCircled) circledFound = true;
    baseSum += parsed.val;
  });

  gameState.lastRoll = { results, seventh: null, extraResults: [] };

  if (stars === 3) {
    gameState.phase = 'TALLY_UP_RACE';
    io.emit('stateUpdate', gameState);
    return;
  }

  if (stars === 2) {
    handleBust("💥 BUST! 2 stars rolled.");
    return;
  }

  if (circledFound) {
    gameState.phase = 'ROLL_WHITE_DIE';
    io.emit('stateUpdate', gameState);
    return;
  }

  applyRollPoints(baseSum);
}

function resolveExtraRolls(extraColors) {
  const extraResults = extraColors.map(color => ({ color, face: rollDice(color) }));
  gameState.lastRoll.extraResults = extraResults;

  const allResults = [...gameState.lastRoll.results, ...extraResults];
  const totalStars = allResults.reduce((acc, r) => acc + (parseFace(r.face).isStar ? 1 : 0), 0);

  if (totalStars >= 2) {
    handleBust(`💥 BUST! ${totalStars} stars face up after extra dice!`);
  } else {
    let extraDiceSum = extraResults.reduce((acc, r) => acc + parseFace(r.face).val, 0);
    applyRollPoints(extraDiceSum);
  }
}

function applyRollPoints(addedPoints) {
  gameState.roundScore += addedPoints;
  
  gameState.players.forEach(p => {
    if (p.status === 'IN') {
      p.roundScore += addedPoints;
    }
  });

  openDecisionMoment();
}

function openDecisionMoment() {
  gameState.phase = 'DECISION_MOMENT';
  io.emit('stateUpdate', gameState);
}

function handleBust(reason) {
  gameState.players.forEach(p => {
    if (p.status === 'IN') {
      p.roundScore = 0;
    }
  });

  gameState.bannerMessage = { type: 'bust', text: reason };
  endRound(reason);
}

function endRound(reason) {
  gameState.players.forEach(p => {
    p.totalScore += p.roundScore;
    p.roundScore = 0;
    p.status = 'IN';
    p.madeDecision = false;
  });

  const winners = gameState.players.filter(p => p.totalScore >= 2500);

  if (winners.length > 0) {
    winners.sort((a, b) => b.totalScore - a.totalScore);
    
    const winningPlayer = winners[0];

    gameState.winner = {
      name: winningPlayer.name,
      totalScore: winningPlayer.totalScore
    };
    
    gameState.phase = 'GAME_OVER';
  } else {
    gameState.currentPlayerIndex = (gameState.currentPlayerIndex + 1) % gameState.players.length;
    gameState.phase = 'ROUND_OVER';
  }

  io.emit('stateUpdate', gameState);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});