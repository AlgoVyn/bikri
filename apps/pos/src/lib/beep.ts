let count = 0;
let ctx: AudioContext | null = null;

/** Scanner beep: 60 ms tone through WebAudio (screens/05). Never throws. */
export function beep(): void {
  count += 1;
  try {
    ctx ??= new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 1800;
    gain.gain.value = 0.08;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.06);
  } catch {
    // No audio device: the count still records the beep.
  }
}

/** Beeps since load (e2e checks screens/05 AC 1). */
export function beepCount(): number {
  return count;
}

/** Soft two-tone confirmation when a sale is saved (optional per device). */
export function saleChime(): void {
  try {
    ctx ??= new AudioContext();
    const at = ctx.currentTime;
    for (const [frequency, delay] of [
      [880, 0],
      [1320, 0.08],
    ] as const) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0.055, at + delay);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + delay + 0.18);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at + delay);
      osc.stop(at + delay + 0.18);
    }
  } catch {
    // No audio device.
  }
}
