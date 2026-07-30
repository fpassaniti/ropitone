export class WakeLockController {
  constructor() {
    this.sentinel = null;
    this.supported = "wakeLock" in navigator;
    this._onVisibilityChange = this._onVisibilityChange.bind(this);
  }

  async request() {
    if (!this.supported) return false;
    try {
      this.sentinel = await navigator.wakeLock.request("screen");
      document.addEventListener("visibilitychange", this._onVisibilityChange);
      return true;
    } catch {
      return false;
    }
  }

  async _onVisibilityChange() {
    if (document.visibilityState === "visible" && this.sentinel == null) {
      await this.request();
    }
  }

  release() {
    document.removeEventListener("visibilitychange", this._onVisibilityChange);
    this.sentinel?.release().catch(() => {});
    this.sentinel = null;
  }
}
