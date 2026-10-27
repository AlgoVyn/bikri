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
