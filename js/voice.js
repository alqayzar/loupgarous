// Narration vocale en français via l'API Web Speech.
// Les voix se chargent de façon asynchrone selon le navigateur.

let _voice = null;

function loadVoice() {
  const voices = speechSynthesis.getVoices();
  _voice =
    voices.find((v) => v.lang === 'fr-FR') ||
    voices.find((v) => v.lang.startsWith('fr')) ||
    null;
}

loadVoice();
speechSynthesis.addEventListener('voiceschanged', loadVoice);

/**
 * Lit un texte à voix haute en français.
 * Interrompt toute narration en cours avant de commencer.
 *
 * @param {string} text
 * @param {{ rate?: number, pitch?: number, volume?: number }} options
 */
export function say(text, { rate = 0.92, pitch = 1, volume = 1 } = {}) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'fr-FR';
  utterance.rate = rate;
  utterance.pitch = pitch;
  utterance.volume = volume;
  if (_voice) utterance.voice = _voice;

  speechSynthesis.speak(utterance);
}

/** Interrompt immédiatement la narration en cours. */
export function cancel() {
  speechSynthesis.cancel();
}

/** Indique si une narration est en cours. */
export function isSpeaking() {
  return speechSynthesis.speaking;
}
