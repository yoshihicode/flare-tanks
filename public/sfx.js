// Retro sound effects in the spirit of jsfxr (spec "効果音: jsfxr系ツールでレトロ音を生成").
// Each effect is a small parameter set rendered into samples once, then played as an AudioBuffer.
// Pure functions (no Web Audio here), so the smoke test can render them in Node.

// wave: square | saw | sine | noise. freq: start Hz. slide: frequency multiplier per second (0.2 = drops fast).
// attack / sustain / decay: envelope in seconds. punch: extra volume at the start of sustain.
// duty: square wave duty cycle. vib: vibrato {depth (fraction), speed (Hz)}. arp: jump to freq*ratio at time.
// lowpass: 0..1 smoothing (higher = duller). vol: 0..1
export const SFX = {
  fireLight: { wave: "square", freq: 1100, slide: 0.08, duty: 0.3, attack: 0, sustain: 0.02, decay: 0.07, vol: 0.35 },
  fireMedium: { wave: "square", freq: 700, slide: 0.12, duty: 0.4, attack: 0, sustain: 0.03, decay: 0.1, punch: 0.3, vol: 0.45 },
  fireHeavy: { wave: "saw", freq: 320, slide: 0.2, attack: 0, sustain: 0.05, decay: 0.2, punch: 0.5, lowpass: 0.3, vol: 0.6 },
  hint: { wave: "square", freq: 420, slide: 0.2, duty: 0.5, attack: 0.005, sustain: 0.03, decay: 0.12, lowpass: 0.85, vol: 0.5 },
  wall: { wave: "noise", freq: 2400, slide: 0.5, attack: 0, sustain: 0.01, decay: 0.05, lowpass: 0.4, vol: 0.25 },
  hit: { wave: "noise", freq: 1800, slide: 0.3, attack: 0, sustain: 0.03, decay: 0.12, punch: 0.4, vol: 0.5 },
  hurt: { wave: "saw", freq: 220, slide: 0.35, attack: 0, sustain: 0.04, decay: 0.18, vib: { depth: 0.2, speed: 30 }, vol: 0.6 },
  kill: { wave: "noise", freq: 900, slide: 0.15, attack: 0, sustain: 0.12, decay: 0.45, punch: 0.6, lowpass: 0.5, vol: 0.8 },
  capture: { wave: "square", freq: 523, duty: 0.25, attack: 0, sustain: 0.12, decay: 0.2, arp: { ratio: 1.5, at: 0.08 }, vol: 0.45 },
  lost: { wave: "square", freq: 440, slide: 0.5, duty: 0.4, attack: 0, sustain: 0.1, decay: 0.25, arp: { ratio: 0.75, at: 0.1 }, vol: 0.45 },
  pin: { wave: "sine", freq: 1320, attack: 0, sustain: 0.04, decay: 0.12, arp: { ratio: 1.26, at: 0.05 }, vol: 0.4 },
  count: { wave: "square", freq: 440, duty: 0.5, attack: 0, sustain: 0.08, decay: 0.05, vol: 0.35 },
  go: { wave: "square", freq: 880, duty: 0.5, attack: 0, sustain: 0.18, decay: 0.12, vol: 0.4 },
  win: { wave: "square", freq: 523, duty: 0.25, attack: 0, sustain: 0.3, decay: 0.3, arp: { ratio: 2, at: 0.15 }, vib: { depth: 0.02, speed: 6 }, vol: 0.45 },
  lose: { wave: "saw", freq: 330, slide: 0.4, attack: 0, sustain: 0.3, decay: 0.4, lowpass: 0.4, vol: 0.45 },
};

export const FIRE_SFX = { light: "fireLight", medium: "fireMedium", heavy: "fireHeavy" };

// Render one effect to mono samples (-1..1). rand is injectable so tests are repeatable
export function synth(p, sampleRate, rand = Math.random) {
  const total = p.attack + p.sustain + p.decay;
  const n = Math.max(1, Math.round(total * sampleRate));
  const out = new Float32Array(n);
  let phase = 0, noiseVal = 0, smooth = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    // Envelope: linear attack, sustain (with optional punch), linear decay
    let env;
    if (t < p.attack) env = t / p.attack;
    else if (t < p.attack + p.sustain) env = 1 + (p.punch ?? 0) * (1 - (t - p.attack) / p.sustain);
    else env = 1 - (t - p.attack - p.sustain) / p.decay;
    // Frequency with slide, arpeggio jump and vibrato
    let f = p.freq * Math.pow(p.slide ?? 1, t);
    if (p.arp && t >= p.arp.at) f *= p.arp.ratio;
    if (p.vib) f *= 1 + p.vib.depth * Math.sin(2 * Math.PI * p.vib.speed * t);
    const prevPhase = phase;
    phase = (phase + f / sampleRate) % 1;
    let v;
    switch (p.wave) {
      case "square": v = phase < (p.duty ?? 0.5) ? 1 : -1; break;
      case "saw": v = 2 * phase - 1; break;
      case "sine": v = Math.sin(2 * Math.PI * phase); break;
      default: // noise: a new random value each cycle, so freq sets its "pitch"
        if (phase < prevPhase) noiseVal = rand() * 2 - 1;
        v = noiseVal;
    }
    smooth += (v - smooth) * (1 - (p.lowpass ?? 0));
    out[i] = Math.max(-1, Math.min(1, smooth * Math.max(0, env) * p.vol));
  }
  return out;
}
