import { get, set } from './storage.js';

// ─── Image ────────────────────────────────────────────────────────────────────

function resizeImage(file, maxPx = 200) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const ratio = Math.min(maxPx / img.width, maxPx / img.height, 1);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * ratio);
      canvas.height = Math.round(img.height * ratio);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('load failed')); };
    img.src = url;
  });
}

function showAvatar(base64) {
  document.getElementById('avatar-img').src = base64;
  document.getElementById('avatar-img').classList.remove('hidden');
  document.getElementById('avatar-placeholder').classList.add('hidden');
}

// ─── Profile ──────────────────────────────────────────────────────────────────

async function loadProfile() {
  const profile = await get('profile');
  if (!profile) return;
  if (profile.username) document.getElementById('username-input').value = profile.username;
  if (profile.photo) showAvatar(profile.photo);
}

async function saveProfile() {
  const imgEl = document.getElementById('avatar-img');
  const photo = imgEl.classList.contains('hidden') ? null : imgEl.src;
  const username = document.getElementById('username-input').value.trim() || 'Joueur';
  await set('profile', { username, photo });
  return { username, photo };
}

// ─── Modal ────────────────────────────────────────────────────────────────────

function openJoinModal() {
  document.getElementById('join-modal').classList.remove('hidden');
  document.getElementById('room-id-input').focus();
}

function closeJoinModal() {
  document.getElementById('join-modal').classList.add('hidden');
  document.getElementById('room-id-input').value = '';
  document.getElementById('room-id-input').classList.remove('border-[#DE3C4B]');
}

// ─── Actions ──────────────────────────────────────────────────────────────────

async function handleCreate() {
  await saveProfile();
  await set('session', { pendingRole: 'host' });
  location.href = 'room.html';
}

async function handleJoin() {
  const roomId = document.getElementById('room-id-input').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!roomId) {
    document.getElementById('room-id-input').classList.add('border-[#DE3C4B]');
    return;
  }
  await saveProfile();
  await set('session', { pendingRole: 'guest', targetRoomId: roomId });
  location.href = `room.html#${roomId}`;
}

// ─── Listeners ────────────────────────────────────────────────────────────────

function setupListeners() {
  document.getElementById('username-input').addEventListener('input', saveProfile);

  document.getElementById('avatar-wrapper').addEventListener('click', () => {
    document.getElementById('photo-input').click();
  });

  document.getElementById('photo-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    // Preview immédiat via FileReader
    const reader = new FileReader();
    reader.onload = (evt) => showAvatar(evt.target.result);
    reader.readAsDataURL(file);

    // Resize pour le stockage, puis remplace la preview
    try {
      const base64 = await resizeImage(file);
      showAvatar(base64);
    } catch {
      // La preview FileReader est déjà affichée, on continue
    }
    await saveProfile();
  });

  document.getElementById('btn-create').addEventListener('click', handleCreate);
  document.getElementById('btn-join').addEventListener('click', openJoinModal);
  document.getElementById('btn-cancel-join').addEventListener('click', closeJoinModal);
  document.getElementById('btn-confirm-join').addEventListener('click', handleJoin);

  document.getElementById('join-modal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('join-modal')) closeJoinModal();
  });

  document.getElementById('room-id-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleJoin();
    document.getElementById('room-id-input').classList.remove('border-[#DE3C4B]');
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  await loadProfile();
  setupListeners();
}

init();
