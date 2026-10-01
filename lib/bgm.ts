// Web Audio BGM: white noise / gentle tones
let audioCtx: AudioContext | null = null;
let noiseNode: { stop: () => void } | null = null;

function getCtx() {
  if (!audioCtx) audioCtx = new AudioContext();
  return audioCtx;
}

export function playWhiteNoise() {
  stopBGM();
  try {
    const ctx = getCtx();
    const bufferSize = 2 * ctx.sampleRate;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * 0.3;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 800;
    const gain = ctx.createGain();
    gain.gain.value = 0.15;
    src.connect(filter); filter.connect(gain); gain.connect(ctx.destination);
    src.start();
    noiseNode = { stop: () => { try { src.stop(); } catch {} } };
  } catch {}
}

export function playCheerfulTone() {
  stopBGM();
  try {
    const ctx = getCtx();
    const notes = [523, 659, 784]; // C E G
    let i = 0;
    const interval = setInterval(() => {
      const osc = ctx.createOscillator();
      osc.frequency.value = notes[i % notes.length];
      const g = ctx.createGain();
      g.gain.value = 0.08;
      osc.connect(g); g.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.3);
      i++;
    }, 500);
    noiseNode = { stop: () => clearInterval(interval) };
  } catch {}
}

export function stopBGM() {
  try { noiseNode?.stop(); } catch {}
  noiseNode = null;
}
