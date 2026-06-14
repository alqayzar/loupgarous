import { get, set, del } from './storage.js';
import { ROLES, assignRoles } from './roles.js';
import { say, isSpeaking } from './voice.js';
import { DEFAULT_PHRASES } from './phrases.js';

const COLORS = ['#DE3C4B', '#6380C2', '#2CB585'];

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  peer: null,
  isHost: false,
  roomId: null,
  myId: null,
  myRoleId: null,
  players: [],
  connections: {},
  hostConn: null,
  assignments: [],
  activeRoles: new Set(),
  roleQuantities: {},
  phrases: { ...DEFAULT_PHRASES },
  witchPotions: { save: true, kill: true },
};

// Night phase state (host-driven; guests receive broadcasts)
const night = {
  phase: 'idle',           // current phase key
  roundNumber: 0,
  eliminated: new Set(),   // Set<peerId> — dead across all nights
  nightDeaths: [],         // [{player, cause}] deaths this night
  wolfVictim: null,        // peerId killed by wolves
  wolfVotes: {},           // {wolfPeerId: targetPeerId}
  wolfConfirmed: new Set(),
  villageVotes: {},        // {playerPeerId: targetPeerId}
  villageConfirmed: new Set(),
  witchRevived: null,
  witchKillTarget: null,
  myVote: null,            // this client's current vote
  witchSelecting: false,   // witch is in kill-selection mode
};

let nightTimer = null;

// ─── Entry Point ──────────────────────────────────────────────────────────────

async function init() {
  const gameSession = await get('gameSession');
  if (!gameSession?.roomId) { location.href = 'index.html'; return; }

  state.isHost       = gameSession.isHost;
  state.roomId       = gameSession.roomId;
  state.myId         = gameSession.myId;
  state.myRoleId     = gameSession.myRoleId;
  state.players      = gameSession.players || [];
  state.assignments  = gameSession.assignments || [];
  if (gameSession.activeRoles)    state.activeRoles    = new Set(gameSession.activeRoles);
  if (gameSession.roleQuantities) state.roleQuantities = gameSession.roleQuantities;
  if (gameSession.phrases)        Object.assign(state.phrases, gameSession.phrases);
  if (gameSession.witchPotions)   Object.assign(state.witchPotions, gameSession.witchPotions);
  if (gameSession.eliminated)     gameSession.eliminated.forEach(id => night.eliminated.add(id));

  document.getElementById('game-room-id').textContent = formatRoomCode(state.roomId);

  showRoleReveal();
  setupActions();
  setupPeer();
}

// ─── Screens ──────────────────────────────────────────────────────────────────

function showRoleReveal() {
  const role = ROLES.find((r) => r.id === state.myRoleId) ?? ROLES[0];
  document.getElementById('reveal-bg').style.backgroundColor = role.color;
  document.getElementById('reveal-icon').innerHTML = `<path d="${role.icon}"/>`;
  document.getElementById('reveal-name').textContent = role.name;
  document.getElementById('reveal-desc').textContent = role.description;
  document.getElementById('screen-reveal').style.display = 'flex';
  document.getElementById('screen-players').style.display = 'none';
  hideNightUI();
}

function showPlayers() {
  document.getElementById('screen-reveal').style.display = 'none';
  document.getElementById('screen-players').style.display = 'flex';
  renderPlayers();
}

// ─── Player Grid ──────────────────────────────────────────────────────────────

function renderPlayers() {
  document.getElementById('game-players-grid').innerHTML =
    state.players.map((p, i) => createPlayerCard(p, i)).join('');

  // Délégation pour la sélection (vote loups / village)
  document.getElementById('game-players-grid').onclick = (e) => {
    const card = e.target.closest('.player-card[data-peer-id]');
    if (!card) return;
    handleCardClick(card.dataset.peerId);
  };
}

function createPlayerCard(player, index) {
  const color = COLORS[index % COLORS.length];
  const isDead = night.eliminated.has(player.id);
  const isVictim = player.id === night.wolfVictim && !isDead;

  const avatarHtml = player.photo
    ? `<img src="${escapeAttr(player.photo)}" class="w-full h-full object-cover" alt="">`
    : `<svg class="w-10 h-10 text-white/60" fill="currentColor" viewBox="0 0 24 24">
         <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/>
       </svg>`;

  // Badge de votes sur cette carte (qui a voté pour ce joueur ?)
  const voteBadges = buildVoteBadges(player.id);

  // Sélection actuelle de ce client
  const isMyVote = night.myVote === player.id;
  const selectedBorder = isMyVote ? 'ring-4 ring-white ring-offset-2' : '';

  // Surbrillance victime loup (tour sorcière)
  const victimGlow = isVictim ? 'ring-4 ring-[#DE3C4B] ring-offset-2' : '';

  const deadOverlay = isDead
    ? `<div class="absolute inset-0 bg-black/60 flex items-center justify-center rounded-2xl">
         <svg class="w-8 h-8 text-white/50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
           <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12"/>
         </svg>
       </div>`
    : '';

  return `
    <div class="player-card relative rounded-2xl overflow-visible shadow-sm flex flex-col h-44 ${selectedBorder} ${victimGlow} cursor-pointer select-none transition-all"
         data-peer-id="${escapeAttr(player.id)}" style="background-color:${color}">
      ${deadOverlay}
      ${voteBadges}
      <div class="flex-1 flex flex-col items-center justify-center gap-2 px-3 py-3">
        <div class="w-16 h-16 rounded-full overflow-hidden bg-white/20 flex items-center justify-center flex-shrink-0">
          ${avatarHtml}
        </div>
        <div class="text-center min-w-0 w-full">
          <p class="text-sm font-semibold text-white truncate">${escapeHtml(player.username)}</p>
          ${player.isHost ? `<span class="text-xs font-bold uppercase tracking-wider text-white/70">Host</span>` : ''}
          ${isDead ? `<span class="text-xs font-bold text-white/50">Éliminé</span>` : ''}
        </div>
      </div>
    </div>
  `;
}

// Retourne les petits avatars/badges des joueurs ayant voté pour ce joueur
function buildVoteBadges(targetPeerId) {
  const votes = night.phase === 'wolves-awake' ? night.wolfVotes : night.villageVotes;
  const voters = Object.entries(votes)
    .filter(([, t]) => t === targetPeerId)
    .map(([voterId]) => state.players.find(p => p.id === voterId))
    .filter(Boolean);

  if (!voters.length) return '';

  const badgeHtml = voters.map((v, i) => {
    const photoHtml = v.photo
      ? `<img src="${escapeAttr(v.photo)}" class="w-full h-full object-cover" alt="">`
      : `<svg class="w-3 h-3 text-white/70" fill="currentColor" viewBox="0 0 24 24"><path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/></svg>`;
    return `<div class="w-6 h-6 rounded-full bg-gray-800 border-2 border-white overflow-hidden flex items-center justify-center flex-shrink-0" style="margin-left:${i > 0 ? '-8px' : '0'}">${photoHtml}</div>`;
  }).join('');

  return `<div class="absolute -top-3 left-2 flex items-center z-10">${badgeHtml}</div>`;
}

// ─── Actions générales ────────────────────────────────────────────────────────

function setupActions() {
  document.getElementById('btn-continue').addEventListener('click', showPlayers);
  document.getElementById('btn-show-role').addEventListener('click', showRoleReveal);

  if (state.isHost) {
    document.getElementById('btn-stop-game').style.display   = '';
    document.getElementById('btn-restart-game').style.display = '';
    document.getElementById('btn-next-night').style.display   = '';
    document.getElementById('btn-stop-game').addEventListener('click', stopGame);
    document.getElementById('btn-restart-game').addEventListener('click', restartGame);
    document.getElementById('btn-next-night').addEventListener('click', startNight);
  }

  // Barre sélection nuit
  document.getElementById('btn-night-confirm').addEventListener('click', confirmVote);
  document.getElementById('btn-night-cancel').addEventListener('click', cancelVote);

  // Barre sorcière
  document.getElementById('btn-witch-revive').addEventListener('click', witchRevive);
  document.getElementById('btn-witch-kill').addEventListener('click', witchKillMode);
  document.getElementById('btn-witch-done').addEventListener('click', witchDone);
}

function stopGame() {
  clearTimeout(nightTimer);
  broadcastToGuests({ type: 'game-stop' });
  del('gameSession');
  setTimeout(() => { location.href = `room.html#${state.roomId}`; }, 200);
}

function restartGame() {
  clearTimeout(nightTimer);
  const newAssignments = assignRoles(state.players, state.activeRoles, state.roleQuantities);
  state.assignments = newAssignments;
  const myAssignment = newAssignments.find((a) => a.peerId === state.myId);
  state.myRoleId = myAssignment?.roleId ?? 'villager';
  night.eliminated = new Set();
  night.phase = 'idle';
  saveGameSession();
  newAssignments.forEach(({ peerId, roleId }) => {
    if (peerId === state.myId) return;
    const conn = state.connections[peerId];
    if (conn?.open) conn.send({ type: 'game-restart', roleId, players: state.players });
  });
  showRoleReveal();
}

// ─── Night Phase (Host) ───────────────────────────────────────────────────────

function startNight() {
  clearTimeout(nightTimer);
  night.roundNumber++;
  night.nightDeaths   = [];
  night.wolfVictim    = null;
  night.wolfVotes     = {};
  night.wolfConfirmed = new Set();
  night.villageVotes  = {};
  night.villageConfirmed = new Set();
  night.witchRevived  = null;
  night.witchKillTarget = null;
  night.myVote        = null;
  enterPhase('village-sleep');
}

function enterPhase(phase) {
  clearTimeout(nightTimer);
  night.phase = phase;

  // Broadcast phase to guests (with relevant data)
  const phaseData = buildPhaseData(phase);
  broadcastToGuests({ type: 'phase', phase, data: phaseData });

  // Host renders their own view
  renderPhaseForMe(phase, phaseData);
  renderPlayers();

  if (phase === 'village-sleep') {
    speakAndToast(state.phrases.villageSleep);
    nightTimer = setTimeout(() => enterPhase('wolves-awake'), 20000);
  }
  else if (phase === 'wolves-awake') {
    speakAndToast(state.phrases.wolvesAwake);
    // Waits for wolf confirmations (event-driven)
    night.wolfVotes     = {};
    night.wolfConfirmed = new Set();
    // Host is a wolf? Pre-register
    if (getMyRole() === 'wolf') {
      night.myVote = null;
    }
  }
  else if (phase === 'wolves-sleep') {
    speakAndToast(state.phrases.wolvesSleep);
    nightTimer = setTimeout(() => {
      if (hasAliveWitch()) enterPhase('witch-awake');
      else enterPhase('village-awake');
    }, 5000);
  }
  else if (phase === 'witch-awake') {
    speakAndToast(state.phrases.witchAwake);
    // Waits for witch done (event-driven)
  }
  else if (phase === 'witch-sleep') {
    speakAndToast(state.phrases.witchSleep);
    nightTimer = setTimeout(() => enterPhase('village-awake'), 5000);
  }
  else if (phase === 'village-awake') {
    speakAndToast(state.phrases.villageAwake);
    calculateNightDeaths();
    nightTimer = setTimeout(() => enterPhase('death-announce'), 5000);
  }
  else if (phase === 'death-announce') {
    announceDeaths(() => enterPhase('village-vote'));
  }
  else if (phase === 'village-vote') {
    speakAndToast(state.phrases.villageVote);
    night.villageVotes     = {};
    night.villageConfirmed = new Set();
    night.myVote           = null;
  }
  else if (phase === 'idle') {
    hideNightUI();
  }
}

function buildPhaseData(phase) {
  const aliveWolves = getAlivePlayers().filter(p => getPlayerRole(p.id) === 'wolf').map(p => p.id);
  const witch = getAlivePlayers().find(p => getPlayerRole(p.id) === 'witch');
  return {
    wolves: aliveWolves,
    witchId: witch?.id ?? null,
    wolfVictim: night.wolfVictim,
    wolfVotes: night.wolfVotes,
    wolfConfirmed: [...night.wolfConfirmed],
    villageVotes: night.villageVotes,
    villageConfirmed: [...night.villageConfirmed],
    eliminated: [...night.eliminated],
    witchPotions: state.witchPotions,
  };
}

function renderPhaseForMe(phase, data) {
  hideNightUI();

  if (phase === 'idle') return;

  showPhaseBanner(phaseBannerLabel(phase));

  if (phase === 'village-sleep') {
    // Host sees everything — no overlay
    return;
  }

  if (phase === 'wolves-awake') {
    if (getMyRole() === 'wolf') {
      enterSelectionMode('wolf', data);
    } else if (!state.isHost) {
      showEyesClosed('Les loups choisissent…');
    }
    return;
  }

  if (phase === 'wolves-sleep') {
    if (!state.isHost) showEyesClosed('');
    return;
  }

  if (phase === 'witch-awake') {
    if (state.myId === data.witchId) {
      night.wolfVictim = data.wolfVictim;
      showWitchBar(data);
    } else if (!state.isHost) {
      showEyesClosed('La sorcière agit…');
    }
    return;
  }

  if (phase === 'witch-sleep') {
    if (!state.isHost) showEyesClosed('');
    return;
  }

  if (phase === 'village-awake' || phase === 'death-announce') {
    // Everyone wakes up
    return;
  }

  if (phase === 'village-vote') {
    enterSelectionMode('village', data);
    return;
  }
}

// ─── Selection Mode ───────────────────────────────────────────────────────────

function enterSelectionMode(type, data) {
  night.myVote = null;
  const bar = document.getElementById('night-action-bar');
  const cancelBtn = document.getElementById('btn-night-cancel');
  const confirmBtn = document.getElementById('btn-night-confirm');
  bar.style.display = '';
  cancelBtn.style.display = type === 'wolf' ? '' : 'none';
  confirmBtn.disabled = true;
  confirmBtn.classList.add('opacity-50');
  if (type === 'wolf') confirmBtn.textContent = 'Confirmer victime';
  if (type === 'village') confirmBtn.textContent = 'Confirmer vote';

  // Update night.wolfVotes / villageVotes from broadcast data
  if (type === 'wolf' && data) night.wolfVotes = data.wolfVotes || {};
  if (type === 'village' && data) night.villageVotes = data.villageVotes || {};

  renderPlayers();
}

function handleCardClick(peerId) {
  const phase = night.phase;
  if (phase !== 'wolves-awake' && phase !== 'village-vote' && !night.witchSelecting) return;

  // Cannot select eliminated players
  if (night.eliminated.has(peerId)) return;

  // Wolf cannot vote for another wolf
  if (phase === 'wolves-awake') {
    const amIWolf = getMyRole() === 'wolf';
    if (!amIWolf) return;
    const targetIsWolf = getPlayerRole(peerId) === 'wolf';
    if (targetIsWolf) return;
  }

  // Cannot vote for yourself in village vote
  if (phase === 'village-vote' && peerId === state.myId) return;

  // Witch kill selection
  if (night.witchSelecting) {
    if (peerId === state.myId) return;
    night.witchKillTarget = peerId;
    night.witchSelecting = false;
    document.getElementById('night-action-bar').style.display = 'none';
    document.getElementById('witch-action-bar').style.display = '';
    renderPlayers();
    return;
  }

  night.myVote = peerId;

  const confirmBtn = document.getElementById('btn-night-confirm');
  confirmBtn.disabled = false;
  confirmBtn.classList.remove('opacity-50');

  renderPlayers();

  // Host broadcasts their own pre-vote to guests (so they can see badge updates)
  if (state.isHost) {
    if (phase === 'wolves-awake') {
      night.wolfVotes[state.myId] = peerId;
      broadcastToWolves({ type: 'wolf-votes-update', votes: night.wolfVotes, confirmed: [...night.wolfConfirmed] });
    } else if (phase === 'village-vote') {
      night.villageVotes[state.myId] = peerId;
      broadcastToGuests({ type: 'village-votes-update', votes: night.villageVotes, confirmed: [...night.villageConfirmed] });
    }
  } else {
    // Guest sends pre-selection to host
    if (phase === 'wolves-awake') {
      state.hostConn?.send({ type: 'wolf-pre-select', targetId: peerId });
    } else if (phase === 'village-vote') {
      state.hostConn?.send({ type: 'village-pre-select', targetId: peerId });
    }
  }
}

function confirmVote() {
  if (!night.myVote) return;
  const phase = night.phase;
  if (state.isHost) {
    if (phase === 'wolves-awake') {
      night.wolfVotes[state.myId] = night.myVote;
      night.wolfConfirmed.add(state.myId);
      checkWolfConfirmation();
    } else if (phase === 'village-vote') {
      night.villageVotes[state.myId] = night.myVote;
      night.villageConfirmed.add(state.myId);
      checkVillageConfirmation();
    }
  } else {
    if (phase === 'wolves-awake') {
      state.hostConn?.send({ type: 'wolf-confirm', targetId: night.myVote });
    } else if (phase === 'village-vote') {
      state.hostConn?.send({ type: 'village-confirm', targetId: night.myVote });
    }
  }
  // Disable button after confirm
  const confirmBtn = document.getElementById('btn-night-confirm');
  confirmBtn.disabled = true;
  confirmBtn.classList.add('opacity-50');
  confirmBtn.textContent = 'Voté ✓';
}

function cancelVote() {
  night.myVote = null;
  renderPlayers();
  const confirmBtn = document.getElementById('btn-night-confirm');
  confirmBtn.disabled = true;
  confirmBtn.classList.add('opacity-50');
}

// ─── Wolf Vote (Host) ─────────────────────────────────────────────────────────

function checkWolfConfirmation() {
  const aliveWolves = getAlivePlayers().filter(p => getPlayerRole(p.id) === 'wolf');
  const allConfirmed = aliveWolves.length > 0 &&
    aliveWolves.every(w => night.wolfConfirmed.has(w.id));

  // Broadcast updated state to wolves
  broadcastToWolves({ type: 'wolf-votes-update', votes: night.wolfVotes, confirmed: [...night.wolfConfirmed] });

  if (allConfirmed) {
    // Tally: most voted target
    night.wolfVictim = tallyVotes(night.wolfVotes) ?? null;
    enterPhase('wolves-sleep');
  }
}

// ─── Witch Turn ───────────────────────────────────────────────────────────────

function showWitchBar(data) {
  night.wolfVictim = data?.wolfVictim ?? night.wolfVictim;
  const bar = document.getElementById('witch-action-bar');
  bar.style.display = '';

  // Disable revive if: no victim or potion already used
  const reviveBtn = document.getElementById('btn-witch-revive');
  const killBtn   = document.getElementById('btn-witch-kill');
  reviveBtn.disabled = !night.wolfVictim || !state.witchPotions.save;
  killBtn.disabled   = !state.witchPotions.kill;
  reviveBtn.classList.toggle('opacity-40', reviveBtn.disabled);
  killBtn.classList.toggle('opacity-40', killBtn.disabled);

  renderPlayers();
}

function witchRevive() {
  if (!night.wolfVictim || !state.witchPotions.save) return;
  night.witchRevived = night.wolfVictim;
  state.witchPotions.save = false;
  renderPlayers();
  // Show feedback
  document.getElementById('btn-witch-revive').textContent = '✓ Sauvé';
  document.getElementById('btn-witch-revive').disabled = true;
  document.getElementById('btn-witch-revive').classList.add('opacity-40');
}

function witchKillMode() {
  if (!state.witchPotions.kill) return;
  night.witchSelecting = true;
  // Switch to selection bar
  document.getElementById('witch-action-bar').style.display = 'none';
  const bar = document.getElementById('night-action-bar');
  const cancelBtn = document.getElementById('btn-night-cancel');
  const confirmBtn = document.getElementById('btn-night-confirm');
  bar.style.display = '';
  cancelBtn.style.display = '';
  cancelBtn.textContent = 'Annuler';
  cancelBtn.onclick = () => {
    night.witchSelecting = false;
    night.witchKillTarget = null;
    document.getElementById('night-action-bar').style.display = 'none';
    document.getElementById('witch-action-bar').style.display = '';
    cancelBtn.onclick = cancelVote; // restore
  };
  confirmBtn.disabled = true;
  confirmBtn.classList.add('opacity-50');
  confirmBtn.textContent = 'Choisir une cible…';
}

function witchDone() {
  const revived = night.witchRevived;
  const killed  = night.witchKillTarget;

  if (killed) {
    state.witchPotions.kill = false;
  }

  document.getElementById('witch-action-bar').style.display = 'none';

  if (state.isHost) {
    // Apply locally
    applyWitchChoices(revived, killed);
    enterPhase('witch-sleep');
  } else {
    // Send choices to host
    state.hostConn?.send({ type: 'witch-done', revived, killed });
  }

  saveGameSession();
}

function applyWitchChoices(revived, killed) {
  night.witchRevived    = revived;
  night.witchKillTarget = killed;
  if (revived) night.wolfVictim = null; // saved
}

// ─── Village Vote (Host) ──────────────────────────────────────────────────────

function checkVillageConfirmation() {
  const aliveVoters = getAlivePlayers();
  const allConfirmed = aliveVoters.length > 0 &&
    aliveVoters.every(p => night.villageConfirmed.has(p.id));

  broadcastToGuests({ type: 'village-votes-update', votes: night.villageVotes, confirmed: [...night.villageConfirmed] });

  if (allConfirmed) {
    const eliminated = tallyVotes(night.villageVotes);
    if (!eliminated) {
      // Tie with no clear winner → re-vote
      night.villageVotes = {};
      night.villageConfirmed = new Set();
      night.myVote = null;
      broadcastToGuests({ type: 'phase', phase: 'village-vote', data: buildPhaseData('village-vote') });
      renderPhaseForMe('village-vote', buildPhaseData('village-vote'));
      showToast('Égalité ! Revote.');
    } else {
      night.eliminated.add(eliminated);
      saveGameSession();
      broadcastToGuests({ type: 'player-eliminated', peerId: eliminated });
      renderPlayers();
      enterPhase('idle');
    }
  }
}

// ─── Deaths ───────────────────────────────────────────────────────────────────

function calculateNightDeaths() {
  night.nightDeaths = [];
  const victim = night.wolfVictim;
  if (victim && victim !== night.witchRevived) {
    const p = state.players.find(pl => pl.id === victim);
    if (p) night.nightDeaths.push({ player: p, cause: 'wolf' });
  }
  if (night.witchKillTarget) {
    const p = state.players.find(pl => pl.id === night.witchKillTarget);
    if (p) night.nightDeaths.push({ player: p, cause: 'witch' });
  }
  night.nightDeaths.forEach(d => night.eliminated.add(d.player.id));
  saveGameSession();
  broadcastToGuests({ type: 'deaths', deaths: night.nightDeaths.map(d => ({ peerId: d.player.id, cause: d.cause })) });
  renderPlayers();
}

// Prononce les annonces de mort, puis appelle done()
function announceDeaths(done) {
  if (night.nightDeaths.length === 0) {
    speakAndToast(state.phrases.noDeaths, () => done());
    return;
  }

  // Shuffle deaths
  const deaths = [...night.nightDeaths].sort(() => Math.random() - 0.5);
  let i = 0;

  function next() {
    if (i >= deaths.length) { done(); return; }
    const { player } = deaths[i++];
    const role = ROLES.find(r => r.id === getPlayerRole(player.id));

    const deadText = state.phrases.playerDead.replace('{name}', player.username);
    const roleText = state.phrases.playerRole.replace('{role}', role?.name ?? '');

    speakAndToast(deadText, () => {
      setTimeout(() => speakAndToast(roleText, () => {
        setTimeout(next, 800);
      }), 400);
    });
  }
  next();
}

// ─── Guest Message Handler ────────────────────────────────────────────────────

function handleHostMessage(data) {
  if (data.type === 'game-stop') {
    del('gameSession');
    location.href = `room.html#${state.roomId}`;
    return;
  }
  if (data.type === 'game-restart') {
    state.myRoleId = data.roleId;
    if (data.players) state.players = sanitizePlayers(data.players);
    night.eliminated = new Set();
    showRoleReveal();
    return;
  }
  if (data.type === 'phase') {
    night.phase = data.phase;
    const d = data.data || {};
    if (d.eliminated) night.eliminated = new Set(d.eliminated);
    if (d.wolfVotes)     night.wolfVotes     = d.wolfVotes;
    if (d.villageVotes)  night.villageVotes  = d.villageVotes;
    if (d.wolfVictim !== undefined) night.wolfVictim = d.wolfVictim;
    night.myVote = null;
    renderPhaseForMe(data.phase, d);
    renderPlayers();
    return;
  }
  if (data.type === 'wolf-votes-update') {
    night.wolfVotes = data.votes;
    // Update confirmed badges — don't change buttons (guest manages their own confirm state)
    renderPlayers();
    return;
  }
  if (data.type === 'village-votes-update') {
    night.villageVotes = data.votes;
    renderPlayers();
    return;
  }
  if (data.type === 'deaths') {
    data.deaths?.forEach(d => night.eliminated.add(d.peerId));
    renderPlayers();
    return;
  }
  if (data.type === 'player-eliminated') {
    night.eliminated.add(data.peerId);
    renderPlayers();
    return;
  }
}

// Guest incoming messages from host (wolf votes etc. sent to host)
function handleGuestMessageFromConn(data) {
  if (!state.isHost) return;

  if (data.type === 'wolf-pre-select') {
    night.wolfVotes[data.senderId] = data.targetId;
    broadcastToWolves({ type: 'wolf-votes-update', votes: night.wolfVotes, confirmed: [...night.wolfConfirmed] });
    renderPlayers();
    return;
  }
  if (data.type === 'wolf-confirm') {
    night.wolfVotes[data.senderId] = data.targetId;
    night.wolfConfirmed.add(data.senderId);
    checkWolfConfirmation();
    return;
  }
  if (data.type === 'village-pre-select') {
    night.villageVotes[data.senderId] = data.targetId;
    broadcastToGuests({ type: 'village-votes-update', votes: night.villageVotes, confirmed: [...night.villageConfirmed] });
    renderPlayers();
    return;
  }
  if (data.type === 'village-confirm') {
    night.villageVotes[data.senderId] = data.targetId;
    night.villageConfirmed.add(data.senderId);
    checkVillageConfirmation();
    return;
  }
  if (data.type === 'witch-done') {
    applyWitchChoices(data.revived, data.killed);
    enterPhase('witch-sleep');
    return;
  }
}

// ─── Night UI Helpers ─────────────────────────────────────────────────────────

function hideNightUI() {
  document.getElementById('eyes-closed-overlay').style.display = 'none';
  document.getElementById('night-action-bar').style.display   = 'none';
  document.getElementById('witch-action-bar').style.display   = 'none';
  document.getElementById('phase-banner').style.display       = 'none';
}

function showEyesClosed(label) {
  document.getElementById('eyes-closed-label').textContent = label || '';
  document.getElementById('eyes-closed-overlay').style.display = 'flex';
}

function showPhaseBanner(text) {
  const banner = document.getElementById('phase-banner');
  document.getElementById('phase-banner-text').textContent = text;
  banner.style.display = '';
}

function phaseBannerLabel(phase) {
  const map = {
    'village-sleep': 'La nuit tombe…',
    'wolves-awake':  'Les loups se réveillent',
    'wolves-sleep':  'Les loups se rendorment',
    'witch-awake':   'La sorcière agit',
    'witch-sleep':   'La sorcière se rendort',
    'village-awake': 'Le village se réveille',
    'death-announce':'Bilan de la nuit',
    'village-vote':  'Vote du village',
  };
  return map[phase] || '';
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function speakAndToast(text, onDone) {
  say(text);
  showToast(text, onDone);
}

function showToast(text, onDone) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'bg-gray-900 text-white text-sm font-semibold px-4 py-3 rounded-2xl shadow-xl transition-opacity duration-300';
  toast.textContent = text;
  container.appendChild(toast);

  // Remove when speech ends (poll) or after 6s max
  const start = Date.now();
  const poll = setInterval(() => {
    const elapsed = Date.now() - start;
    if ((!isSpeaking() && elapsed > 500) || elapsed > 10000) {
      clearInterval(poll);
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
      onDone?.();
    }
  }, 200);
}

// ─── Broadcast Helpers ────────────────────────────────────────────────────────

function broadcastToGuests(msg) {
  Object.values(state.connections).forEach((conn) => {
    if (conn.open) conn.send(msg);
  });
}

function broadcastToWolves(msg) {
  const aliveWolves = getAlivePlayers()
    .filter(p => getPlayerRole(p.id) === 'wolf' && p.id !== state.myId);
  aliveWolves.forEach(w => {
    const conn = state.connections[w.id];
    if (conn?.open) conn.send(msg);
  });
}

// ─── P2P ──────────────────────────────────────────────────────────────────────

function setupPeer() {
  if (state.isHost) setupHostPeer(false);
  else setupGuestPeer(state.myId);
}

function setupHostPeer(retried) {
  state.peer?.destroy();
  state.peer = new Peer(state.myId);

  state.peer.on('connection', (conn) => {
    state.connections[conn.peer] = conn;
    conn.on('data', (data) => {
      // Attach sender ID so host knows who sent
      handleGuestMessageFromConn({ ...data, senderId: conn.peer });
    });
    conn.on('close', () => delete state.connections[conn.peer]);
    conn.on('error', () => delete state.connections[conn.peer]);
  });

  state.peer.on('error', (err) => {
    if (err.type === 'unavailable-id' && !retried) {
      setTimeout(() => setupHostPeer(true), 1500);
    } else {
      console.error('[game host]', err.type, err);
    }
  });
}

function setupGuestPeer(peerId) {
  state.peer?.destroy();
  state.peer = peerId ? new Peer(peerId) : new Peer();

  state.peer.on('open', () => {
    const conn = state.peer.connect(state.roomId);
    state.hostConn = conn;
    conn.on('data', handleHostMessage);
    conn.on('error', (err) => console.error('[game guest conn]', err.type));
  });

  state.peer.on('error', (err) => {
    if (err.type === 'unavailable-id') setupGuestPeer(null);
    else console.error('[game guest peer]', err.type, err);
  });
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function getMyRole() {
  return getPlayerRole(state.myId);
}

function getPlayerRole(peerId) {
  return state.assignments.find(a => a.peerId === peerId)?.roleId ?? null;
}

function getAlivePlayers() {
  return state.players.filter(p => !night.eliminated.has(p.id));
}

function hasAliveWitch() {
  return getAlivePlayers().some(p => getPlayerRole(p.id) === 'witch');
}

// Retourne le peerId qui a reçu le plus de votes. null si aucune victoire claire.
function tallyVotes(votes) {
  const counts = {};
  Object.values(votes).forEach(t => { counts[t] = (counts[t] || 0) + 1; });
  const sorted = Object.entries(counts).sort(([, a], [, b]) => b - a);
  if (!sorted.length) return null;
  const [winner, top] = sorted[0];
  if (sorted.length > 1 && sorted[1][1] === top) return null; // tie
  return winner;
}

function saveGameSession() {
  set('gameSession', {
    isHost: state.isHost,
    roomId: state.roomId,
    myId: state.myId,
    myRoleId: state.myRoleId,
    players: state.players,
    assignments: state.assignments,
    activeRoles: [...state.activeRoles],
    roleQuantities: { ...state.roleQuantities },
    phrases: { ...state.phrases },
    witchPotions: { ...state.witchPotions },
    eliminated: [...night.eliminated],
  });
}

function sanitizePlayers(players) {
  return players.map(p => ({ ...p, photo: sanitizePhoto(p.photo) }));
}

function formatRoomCode(code) {
  const c = code.toUpperCase();
  return c.length === 6 ? `${c.slice(0, 3)}-${c.slice(3)}` : c;
}

function sanitizePhoto(photo) {
  if (!photo || typeof photo !== 'string') return null;
  if (!photo.startsWith('data:image/')) return null;
  if (photo.length > 500_000) return null;
  return photo;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeAttr(str) {
  return String(str).replace(/"/g, '&quot;');
}

init();
