// Minimal AudioWorkletProcessor used purely as a reliable tick source: it doesn't
// process audio, it just counts render quanta and pings the main thread at a
// steady ~16ms cadence. Unlike requestAnimationFrame, this keeps firing when the
// tab is backgrounded or the page is janky, since the audio render thread must
// keep running for audio playback to stay correct.
class AudioClockProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._ticksPerCallback = Math.max(1, Math.round((sampleRate / 128) * 0.016));
    this._count = 0;
  }

  process() {
    this._count += 1;
    if (this._count >= this._ticksPerCallback) {
      this._count = 0;
      this.port.postMessage(null);
    }
    return true;
  }
}

registerProcessor("audio-clock-processor", AudioClockProcessor);
