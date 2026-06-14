import { get, set, del } from './storage.js';
import { ROLES, assignRoles } from './roles.js';
import { say, cancel, isSpeaking } from './voice.js';
import { DEFAULT_PHRASES, PHRASE_LABELS } from './phrases.js';

const COLORS = ['#DE3C4B', '#6380C2', '#2CB585'];

// Caractères sans ambiguïté : pas de 0/O, 1/I/L
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateRoomCode(length = 6) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
}

// Affichage avec tiret central : ABCDEF → ABC-DEF
function formatRoomCode(code) {
  const c = code.toUpperCase();
  return c.length === 6 ? `${c.slice(0, 3)}-${c.slice(3)}` : c;
}

// Normalise l'input utilisateur : "abc-def" ou "ABC DEF" → "ABCDEF"
function normalizeRoomCode(input) {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  peer: null,
  isHost: false,
  roomId: null,
  myId: null,
  players: [],         // [{ id, username, photo, isHost }]
  connections: {},     // host only — peerId → DataConnection
  hostConn: null,      // guest only — DataConnection to host
  activeRoles: new Set(ROLES.map((r) => r.id)),
  roleQuantities: Object.fromEntries(
    ROLES.filter((r) => r.quantity).map((r) => [r.id, r.quantity.default])
  ),
  phrases: { ...DEFAULT_PHRASES },
};

// ─── Entry Point ──────────────────────────────────────────────────────────────

async function init() {
  const urlRoomId = location.hash.slice(1) || null;
  const [session, profile, savedRoles, savedQuantities, savedPhrases] = await Promise.all([
    get('session'),
    get('profile'),
    get('roleSettings'),
    get('roleQuantities'),
    get('voicePhrases'),
  ]);
  const myProfile = profile || { username: 'Joueur', photo: null };

  if (savedPhrases) Object.assign(state.phrases, savedPhrases);

  if (savedRoles) {
    state.activeRoles = new Set(savedRoles);
    // Les rôles obligatoires sont toujours actifs, même avec des données anciennes
    ROLES.filter((r) => r.required).forEach((r) => state.activeRoles.add(r.id));
  }
  if (savedQuantities) Object.assign(state.roleQuantities, savedQuantities);

  if (session?.role === 'host' && urlRoomId === session.roomId) {
    setupAsHost(myProfile, session.myPeerId);
  } else if (session?.role === 'guest' && urlRoomId === session.roomId) {
    setupAsGuest(myProfile, urlRoomId, session.myPeerId);
  } else if (session?.pendingRole === 'host') {
    setupAsHost(myProfile, null);
  } else if (session?.pendingRole === 'guest' && urlRoomId) {
    setupAsGuest(myProfile, urlRoomId, null);
  } else {
    location.href = 'index.html';
    return;
  }

  setupNavActions();
}

// ─── Host Mode ────────────────────────────────────────────────────────────────

function setupAsHost(profile, savedPeerId) {
  state.isHost = true;
  const peerId = savedPeerId ?? generateRoomCode();
  state.peer = new Peer(peerId);

  state.peer.on('open', async (id) => {
    state.myId = id;
    state.roomId = id;
    state.players = [{ id, username: profile.username, photo: profile.photo, isHost: true }];

    history.replaceState(null, '', `#${id}`);
    await set('session', { role: 'host', roomId: id, myPeerId: id });

    updateRoomId(id);
    document.getElementById('host-actions').classList.remove('hidden');
    renderPlayers();
  });

  state.peer.on('connection', handleIncomingConnection);

  state.peer.on('error', (err) => {
    console.error('[PeerJS host]', err.type, err);
    if (err.type === 'unavailable-id') {
      del('session');
      location.href = 'index.html';
    } else {
      showError(`Erreur réseau: ${err.type}`);
    }
  });
}

function handleIncomingConnection(conn) {
  conn.on('data', (data) => {
    if (data.type === 'join') {
      const player = {
        id: conn.peer,
        username: data.player.username,
        photo: sanitizePhoto(data.player.photo),
        isHost: false,
      };
      const idx = state.players.findIndex((p) => p.id === conn.peer);
      if (idx >= 0) {
        state.players[idx] = player;
      } else {
        state.players.push(player);
      }
      state.connections[conn.peer] = conn;
      renderPlayers();
      broadcastPlayerList();
    }

    if (data.type === 'leave') {
      removePlayer(conn.peer);
    }
  });

  conn.on('close', () => removePlayer(conn.peer));
  conn.on('error', () => removePlayer(conn.peer));
}

function removePlayer(peerId) {
  state.players = state.players.filter((p) => p.id !== peerId);
  delete state.connections[peerId];
  renderPlayers();
  broadcastPlayerList();
}

function kickPlayer(peerId) {
  const conn = state.connections[peerId];
  if (conn?.open) conn.send({ type: 'kicked' });
  removePlayer(peerId);
}

function broadcastPlayerList() {
  const msg = { type: 'playerList', players: state.players };
  Object.values(state.connections).forEach((conn) => {
    if (conn.open) conn.send(msg);
  });
}

function startGame() {
  if (state.players.length < 2) {
    showError('Il faut au moins 2 joueurs pour lancer la partie.');
    return;
  }

  const assignments = assignRoles(state.players, state.activeRoles, state.roleQuantities);
  const myAssignment = assignments.find((a) => a.peerId === state.myId);

  set('gameSession', {
    isHost: true,
    roomId: state.roomId,
    myId: state.myId,
    myRoleId: myAssignment?.roleId ?? 'villager',
    players: state.players,
    assignments,
    activeRoles: [...state.activeRoles],
    roleQuantities: { ...state.roleQuantities },
    phrases: { ...state.phrases },
  }).then(() => {
    assignments.forEach(({ peerId, roleId }) => {
      if (peerId === state.myId) return;
      const conn = state.connections[peerId];
      if (conn?.open) conn.send({ type: 'game-start', roleId, players: state.players });
    });
    setTimeout(() => {
      location.href = `game.html#${state.roomId}`;
    }, 250);
  });
}

// ─── Guest Mode ───────────────────────────────────────────────────────────────

function setupAsGuest(profile, targetRoomId, savedPeerId) {
  state.isHost = false;
  state.roomId = targetRoomId;
  state.peer = savedPeerId ? new Peer(savedPeerId) : new Peer();

  state.peer.on('open', async (id) => {
    state.myId = id;
    await set('session', { role: 'guest', roomId: targetRoomId, myPeerId: id });
    updateRoomId(targetRoomId);
    connectToHost(profile, targetRoomId);
  });

  state.peer.on('error', (err) => {
    if (err.type === 'peer-unavailable') {
      showError('Salle introuvable. Vérifiez le code.');
    } else if (err.type === 'unavailable-id') {
      // Saved peer ID taken — retry with fresh ID
      state.peer = new Peer();
      state.peer.on('open', async (id) => {
        state.myId = id;
        await set('session', { role: 'guest', roomId: targetRoomId, myPeerId: id });
        updateRoomId(targetRoomId);
        connectToHost(profile, targetRoomId);
      });
      state.peer.on('error', (e) => showError(`Erreur: ${e.type}`));
    } else {
      showError(`Erreur: ${err.type}`);
    }
  });
}

function connectToHost(profile, targetRoomId) {
  const conn = state.peer.connect(targetRoomId);
  state.hostConn = conn;

  conn.on('open', () => {
    conn.send({
      type: 'join',
      player: { id: state.myId, username: profile.username, photo: profile.photo },
    });
  });

  conn.on('data', async (data) => {
    if (data.type === 'playerList') {
      state.players = data.players.map((p) => ({ ...p, photo: sanitizePhoto(p.photo) }));
      renderPlayers();
    }
    if (data.type === 'hostLeft') {
      del('session');
      alert('Le host a quitté la partie.');
      location.href = 'index.html';
    }
    if (data.type === 'kicked') {
      state.peer?.destroy();
      del('session');
      alert('Vous avez été expulsé de la partie.');
      location.href = 'index.html';
    }
    if (data.type === 'game-start') {
      const players = (data.players || []).map((p) => ({ ...p, photo: sanitizePhoto(p.photo) }));
      await set('gameSession', {
        isHost: false,
        roomId: state.roomId,
        myId: state.myId,
        myRoleId: data.roleId,
        players,
      });
      location.href = `game.html#${state.roomId}`;
    }
  });

  conn.on('close', () => showError('Connexion perdue avec le host.'));
  conn.on('error', (err) => showError(`Erreur de connexion: ${err.type}`));
}

// ─── UI Rendering ─────────────────────────────────────────────────────────────

function renderPlayers() {
  const grid = document.getElementById('players-grid');
  const countEl = document.getElementById('player-count');
  const n = state.players.length;
  countEl.textContent = `${n} joueur${n !== 1 ? 's' : ''}`;
  grid.innerHTML = state.players.map(createPlayerCard).join('');
}

function createPlayerCard(player, index) {
  const color = COLORS[index % COLORS.length];
  const avatarHtml = player.photo
    ? `<img src="${escapeAttr(player.photo)}" class="w-full h-full object-cover" alt="">`
    : `<svg class="w-10 h-10 text-white/60" fill="currentColor" viewBox="0 0 24 24">
         <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/>
       </svg>`;

  const kickBtn = state.isHost && !player.isHost
    ? `<button class="kick-btn absolute top-2 right-2 w-6 h-6 rounded-full bg-black/20 hover:bg-black/40 flex items-center justify-center transition-colors" data-peer-id="${escapeAttr(player.id)}" title="Expulser">
         <svg class="w-3 h-3 text-white pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
           <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M6 18L18 6M6 6l12 12"/>
         </svg>
       </button>`
    : '';

  return `
    <div class="relative rounded-2xl overflow-hidden shadow-sm flex flex-col h-44" style="background-color:${color}">
      ${kickBtn}
      <div class="flex-1 flex flex-col items-center justify-center gap-2 px-3 py-3">
        <div class="w-16 h-16 rounded-full overflow-hidden bg-white/20 flex items-center justify-center flex-shrink-0">
          ${avatarHtml}
        </div>
        <div class="text-center min-w-0 w-full">
          <p class="text-sm font-semibold text-white truncate">${escapeHtml(player.username)}</p>
          ${player.isHost ? `<span class="text-xs font-bold uppercase tracking-wider text-white/70">Host</span>` : ''}
        </div>
      </div>
    </div>
  `;
}

function updateRoomId(id) {
  document.getElementById('room-id-display').textContent = formatRoomCode(id);
}

function showError(message) {
  const el = document.getElementById('error-banner');
  el.textContent = message;
  el.classList.remove('hidden');
}

// ─── Nav Actions ──────────────────────────────────────────────────────────────

const ICON_COPY = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>`;
const ICON_CHECK = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>`;

function setupNavActions() {
  const btnCopy = document.getElementById('btn-copy');
  btnCopy.addEventListener('click', () => {
    if (!state.roomId) return;
    navigator.clipboard.writeText(formatRoomCode(state.roomId)).then(() => {
      btnCopy.innerHTML = ICON_CHECK;
      btnCopy.style.color = '#2CB585';
      setTimeout(() => {
        btnCopy.innerHTML = ICON_COPY;
        btnCopy.style.color = '';
      }, 1500);
    });
  });

  document.getElementById('btn-leave').addEventListener('click', async () => {
    if (state.isHost) {
      Object.values(state.connections).forEach((c) => {
        if (c.open) c.send({ type: 'hostLeft' });
      });
    } else {
      if (state.hostConn?.open) state.hostConn.send({ type: 'leave' });
    }
    state.peer?.destroy();
    await del('session');
    location.href = 'index.html';
  });

  // Délégation d'événement pour les boutons kick (innerHTML est re-rendu à chaque maj)
  document.getElementById('players-grid').addEventListener('click', (e) => {
    const btn = e.target.closest('.kick-btn');
    if (!btn) return;
    kickPlayer(btn.dataset.peerId);
  });

  if (state.isHost) {
    document.getElementById('btn-start').addEventListener('click', startGame);
    setupSettingsModal();
  }
}

// ─── Settings Modal ───────────────────────────────────────────────────────────

function setupSettingsModal() {
  const modal = document.getElementById('settings-modal');

  document.getElementById('btn-settings').addEventListener('click', () => {
    renderSettings();
    modal.classList.remove('hidden');
  });

  document.getElementById('btn-close-settings').addEventListener('click', () => {
    modal.classList.add('hidden');
  });

  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.add('hidden');
  });

  document.getElementById('settings-content').addEventListener('input', (e) => {
    if (e.target.id === 'voice-rate')
      document.getElementById('voice-rate-val').textContent = parseFloat(e.target.value).toFixed(2);
    if (e.target.id === 'voice-pitch')
      document.getElementById('voice-pitch-val').textContent = parseFloat(e.target.value).toFixed(1);

    const phraseInput = e.target.closest('.phrase-input');
    if (phraseInput) {
      state.phrases[phraseInput.dataset.phraseKey] = phraseInput.value;
      set('voicePhrases', { ...state.phrases });
    }
  });

  // Délégation unique pour les sections, rôles et test voix
  document.getElementById('settings-content').addEventListener('click', (e) => {
    const toggle = e.target.closest('.section-toggle');
    if (toggle) { toggleSection(toggle.dataset.target); return; }

    const qtyBtn = e.target.closest('.role-qty-btn');
    if (qtyBtn) { changeRoleQuantity(qtyBtn.dataset.roleId, qtyBtn.dataset.dir); return; }

    const roleCard = e.target.closest('.role-card');
    if (roleCard) { toggleRole(roleCard.dataset.roleId); return; }

    const voiceBtn = e.target.closest('.voice-play-btn');
    if (voiceBtn) { handleVoiceTest(voiceBtn); return; }
  });
}

// Ajouter une section ici pour qu'elle apparaisse dans les paramètres
function renderSettings() {
  const sections = [
    { id: 'roles',     title: 'Rôles disponibles', html: ROLES.map(createRoleCard).join('') },
    { id: 'narration', title: 'Narration',          html: buildNarrationHtml() },
    { id: 'voice',     title: 'Voix',               html: buildVoiceTestHtml() },
  ];

  document.getElementById('settings-content').innerHTML = sections
    .map(buildSection)
    .join('<div class="border-t border-gray-100"></div>');
}

function buildSection({ id, title, html }) {
  return `
    <div>
      <button class="section-toggle w-full flex items-center justify-between py-4 select-none" data-target="section-${id}">
        <span class="text-xs font-bold uppercase tracking-wider text-gray-400">${escapeHtml(title)}</span>
        <svg class="section-chevron w-4 h-4 text-gray-300 transition-transform duration-200 rotate-180" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M19 9l-7 7-7-7"/>
        </svg>
      </button>
      <div id="section-${id}" class="flex flex-col gap-3 pb-4">
        ${html}
      </div>
    </div>
  `;
}

function toggleSection(targetId) {
  const content = document.getElementById(targetId);
  const chevron = document.querySelector(`[data-target="${targetId}"] .section-chevron`);
  const isOpen = !content.classList.contains('hidden');
  content.classList.toggle('hidden', isOpen);
  chevron?.classList.toggle('rotate-180', !isOpen);
}

// Rafraîchit uniquement le contenu de la section rôles (appelé après toggleRole)
function renderRoles() {
  const el = document.getElementById('section-roles');
  if (el) el.innerHTML = ROLES.map(createRoleCard).join('');
}

function createRoleCard(role) {
  const active = state.activeRoles.has(role.id);

  const iconSvg = `<svg class="w-8 h-8 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
    <path d="${role.icon}"/>
  </svg>`;

  const cursor = role.required ? 'cursor-not-allowed' : 'cursor-pointer active:scale-95';

  const lockIcon = `<svg class="w-3.5 h-3.5 text-white/50 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
    <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/>
  </svg>`;

  const rightSection = (() => {
    if (!active) return '';
    const qty = role.quantity ? buildQtyControl(role) : '';
    const lock = role.required ? lockIcon : '';
    return `<div class="flex items-center gap-2 flex-shrink-0 ml-auto">${qty}${lock}</div>`;
  })();

  if (active) {
    return `
      <div class="role-card rounded-2xl px-4 py-3 flex items-center gap-3 ${cursor} select-none transition-transform text-white border-2 border-transparent" data-role-id="${role.id}" style="background-color:${role.color}">
        ${iconSvg}
        <div class="flex-1 min-w-0">
          <p class="font-bold text-sm leading-tight">${escapeHtml(role.name)}</p>
          <p class="text-xs text-white/70 leading-tight mt-0.5">${escapeHtml(role.description)}</p>
        </div>
        ${rightSection}
      </div>
    `;
  }

  return `
    <div class="role-card rounded-2xl px-4 py-3 flex items-center gap-4 cursor-pointer select-none active:scale-95 transition-transform border-2 border-dashed border-gray-200" data-role-id="${role.id}">
      <div style="color:${role.color};opacity:0.3">${iconSvg}</div>
      <div>
        <p class="font-semibold text-sm text-gray-400 leading-tight">${escapeHtml(role.name)}</p>
        <p class="text-xs text-gray-300 leading-tight mt-0.5">${escapeHtml(role.description)}</p>
      </div>
    </div>
  `;
}

async function toggleRole(roleId) {
  const role = ROLES.find((r) => r.id === roleId);
  if (role?.required) return;

  if (state.activeRoles.has(roleId)) {
    state.activeRoles.delete(roleId);
  } else {
    state.activeRoles.add(roleId);
  }
  await set('roleSettings', [...state.activeRoles]);
  renderRoles();
}

function buildQtyControl(role) {
  const qty = state.roleQuantities[role.id] ?? role.quantity.default;
  const atMin = qty <= role.quantity.min;
  const atMax = qty >= role.quantity.max;
  const btnBase = 'role-qty-btn w-7 h-7 rounded-lg flex items-center justify-center font-bold text-sm leading-none transition-colors';
  return `
    <div class="flex items-center gap-1">
      <button class="${btnBase} ${atMin ? 'bg-white/10 text-white/30 cursor-not-allowed' : 'bg-white/20 text-white'}"
        data-role-id="${role.id}" data-dir="-" ${atMin ? 'disabled' : ''}>−</button>
      <span class="w-5 text-center font-bold text-sm tabular-nums">${qty}</span>
      <button class="${btnBase} ${atMax ? 'bg-white/10 text-white/30 cursor-not-allowed' : 'bg-white/20 text-white'}"
        data-role-id="${role.id}" data-dir="+" ${atMax ? 'disabled' : ''}>+</button>
    </div>
  `;
}

async function changeRoleQuantity(roleId, dir) {
  const role = ROLES.find((r) => r.id === roleId);
  if (!role?.quantity) return;
  const current = state.roleQuantities[roleId] ?? role.quantity.default;
  const next = dir === '+'
    ? Math.min(current + 1, role.quantity.max)
    : Math.max(current - 1, role.quantity.min);
  state.roleQuantities[roleId] = next;
  await set('roleQuantities', state.roleQuantities);
  renderRoles();
}

// ─── Voice Test ───────────────────────────────────────────────────────────────

const VOICE_ICON_PLAY = `<svg class="w-5 h-5 pointer-events-none" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`;
const VOICE_ICON_STOP = `<svg class="w-5 h-5 pointer-events-none" fill="currentColor" viewBox="0 0 24 24"><path d="M6 6h12v12H6z"/></svg>`;

function buildNarrationHtml() {
  return Object.entries(PHRASE_LABELS).map(([key, label]) => `
    <div class="flex flex-col gap-1">
      <label class="text-xs font-semibold text-gray-500">${escapeHtml(label)}</label>
      <input type="text" class="phrase-input border-2 border-gray-100 rounded-xl px-3 py-2 text-sm text-gray-800 focus:border-[#6380C2] focus:outline-none bg-gray-50"
        data-phrase-key="${escapeAttr(key)}"
        value="${escapeAttr(state.phrases[key] ?? DEFAULT_PHRASES[key])}">
    </div>
  `).join('');
}

function buildVoiceTestHtml() {
  return `
    <div class="flex flex-col gap-4">
      <div class="flex flex-col gap-1.5">
        <div class="flex justify-between items-baseline">
          <label class="text-sm font-semibold text-gray-700">Vitesse</label>
          <span id="voice-rate-val" class="text-sm font-mono text-[#6380C2]">0.92</span>
        </div>
        <input id="voice-rate" type="range" min="0.5" max="2" step="0.05" value="0.92"
          class="w-full cursor-pointer accent-[#6380C2]">
      </div>

      <div class="flex flex-col gap-1.5">
        <div class="flex justify-between items-baseline">
          <label class="text-sm font-semibold text-gray-700">Tonalité</label>
          <span id="voice-pitch-val" class="text-sm font-mono text-[#6380C2]">1.0</span>
        </div>
        <input id="voice-pitch" type="range" min="0" max="2" step="0.1" value="1"
          class="w-full cursor-pointer accent-[#6380C2]">
      </div>

      <div class="flex gap-2">
        <input
          id="voice-test-input"
          type="text"
          value="La nuit tombe sur le village…"
          class="flex-1 min-w-0 border-2 border-gray-100 rounded-xl px-3 py-2.5 text-sm text-gray-800 focus:border-[#6380C2] focus:outline-none bg-gray-50"
        >
        <button class="voice-play-btn w-11 h-11 flex-shrink-0 flex items-center justify-center rounded-xl bg-[#6380C2] text-white active:scale-95 transition-transform select-none">
          ${VOICE_ICON_PLAY}
        </button>
      </div>
    </div>
  `;
}

function handleVoiceTest(btn) {
  if (isSpeaking()) {
    cancel();
    btn.innerHTML = VOICE_ICON_PLAY;
    btn.style.backgroundColor = '';
    return;
  }
  const text  = document.getElementById('voice-test-input')?.value.trim();
  const rate  = parseFloat(document.getElementById('voice-rate')?.value  ?? 0.92);
  const pitch = parseFloat(document.getElementById('voice-pitch')?.value ?? 1);
  if (!text) return;
  say(text, { rate, pitch });
  btn.innerHTML = VOICE_ICON_STOP;
  btn.style.backgroundColor = '#DE3C4B';
  // Remet le bouton en état play quand la voix s'arrête
  const restore = setInterval(() => {
    if (!isSpeaking()) {
      btn.innerHTML = VOICE_ICON_PLAY;
      btn.style.backgroundColor = '';
      clearInterval(restore);
    }
  }, 200);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function sanitizePhoto(photo) {
  if (!photo || typeof photo !== 'string') return null;
  if (!photo.startsWith('data:image/')) return null;
  if (photo.length > 500_000) return null;
  return photo;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(str) {
  return String(str).replace(/"/g, '&quot;');
}

init();
