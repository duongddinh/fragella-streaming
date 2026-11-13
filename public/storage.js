"use strict";

class VideoStorage {
  constructor() {
    this.key = "fragella-video-storage-v1";
    this.cacheKey = "fragella-video-cache-enabled-v1";
    try { this.choice = localStorage.getItem(this.key); } catch { this.choice = null; }
    this.choice = ["enabled", "disabled"].includes(this.choice) ? this.choice : null;
    // The notice controls persistence, not ordinary best-effort caching.
    // Legacy "disabled" choices declined the notice and now keep normal caching.
    this.enabled = true;
    try { this.enabled = localStorage.getItem(this.cacheKey) !== "disabled"; } catch { /* Best effort remains the default. */ }
    this.enabled = this.enabled && this.supported;
    this.message = "";
    window.addEventListener("storage", event => {
      if (event.key !== this.key && event.key !== this.cacheKey) return;
      if (event.key === this.key) this.choice = event.newValue;
      else this.enabled = event.newValue !== "disabled" && this.supported;
      window.dispatchEvent(new Event("videostoragechange"));
    });
  }
  get supported() {
    try { return !!(window.caches && navigator.locks); } catch { return false; }
  }
  async choose(enabled) {
    // Ask the browser only in response to the viewer's explicit button click.
    let permission = Promise.resolve(false);
    try {
      if (enabled && this.supported && navigator.storage?.persist) permission = navigator.storage.persist().catch(() => false);
    } catch { /* Some browsers block persistence requests in embedded players. */ }
    this.choice = enabled && this.supported ? "enabled" : "disabled";
    try { localStorage.setItem(this.key, this.choice); } catch { /* Keep this session's choice. */ }
    this.message = enabled ? "Checking browser storage protection…" : "Normal caching continues within your browser's space limits. It may remove saved video when it needs space.";
    window.dispatchEvent(new Event("videostoragechange"));
    const protectedStorage = await permission;
    if (enabled) this.message = protectedStorage ?
      "Saved video is protected from browser cleanup. Space limits and rolling cache replacement still apply." :
      "Normal caching continues. Your browser may remove saved video when it needs space.";
    window.dispatchEvent(new Event("videostoragechange"));
  }
  setEnabled(enabled) {
    this.enabled = enabled && this.supported;
    try { localStorage.setItem(this.cacheKey, this.enabled ? "enabled" : "disabled"); } catch { /* Keep the session's choice. */ }
    this.message = this.enabled ? "Normal caching is enabled within your browser's space limits." : "Video caching is off. Streaming still works normally.";
    window.dispatchEvent(new Event("videostoragechange"));
  }
  async inspect() {
    if (!this.supported) return { bytes: 0, protectedStorage: false, available: false };
    const protectedStorage = await navigator.storage?.persisted?.().catch(() => false) || false;
    // Never create a cache merely to inspect storage while saving is off.
    const bytes = await navigator.locks.request("fragella-replay-v1", async () => {
      const names = await caches.keys();
      let total = 0;
      if (names.includes("fragella-replay-v1")) {
        const cache = await caches.open("fragella-replay-v1");
        for (const request of await cache.keys()) {
          const response = await cache.match(request);
          const length = Number(response?.headers.get("Content-Length"));
          if (Number.isFinite(length)) total += length;
        }
      }
      return total;
    });
    return { bytes, protectedStorage, available: true };
  }
  async clear(replay) {
    // Turn saving off first, so active downloads cannot refill the cache.
    this.setEnabled(false);
    replay?.stop();
    if (replay?.cacheOpening) await replay.cacheOpening.catch(() => {});
    if (replay?.writes) await Promise.allSettled([...replay.writes.values()].map(write => write.promise));
    if (this.supported) await navigator.locks.request("fragella-replay-v1", () => caches.delete("fragella-replay-v1"));
    if (replay) { replay.invalidate(); replay.unsaved = null; }
    this.message = "Saved video cleared. Saving is off; you can enable it again here.";
    window.dispatchEvent(new Event("videostoragechange"));
  }
}
window.VideoStorage = VideoStorage;
window.streamStorage = new VideoStorage();
