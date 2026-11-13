"use strict";

const REPLAY_CACHE = "fragella-replay-v1";
const REPLAY_PLAYLIST_LIMIT = 256 * 1024;
const REPLAY_INIT_LIMIT = 128 * 1024;
// Retain at most one rejected write for retry, never an unbounded RAM cache.
const REPLAY_RETRY_LIMIT = 32 * 1024 * 1024;

class ReplayPreload {
  constructor(source) {
    this.source = source;
    this.status = "Waiting for playback";
    this.available = new Set();
    this.bytes = 0;
    this.segments = 0;
    this.ready = false;
    this.transfers = new Map();
    this.writes = new Map();
    this.sharedDownloads = 0;
    this.playbackSavedBytes = 0;
    this.reclaimedBytes = 0;
    this.evictedBytes = 0;
    this.position = 0;
    this.seekTargets = new Map();
    this.entryBytes = new Map();
    this.readers = new Map();
  }

  configure(Hls, levels, index) {
    if (this.variant || this.disabled) return;
    if (!("caches" in window) || !navigator.locks || !AbortSignal.any || !AbortSignal.timeout) {
      this.status = "Browser cache unavailable";
      this.disabled = true;
      return;
    }
    for (const level of levels.slice().sort((a, b) => b.height - a.height || b.maxBitrate - a.maxBitrate)) {
      const profile = renditionProfile(level);
      const sizes = index.bytes[profile];
      if (!sizes) continue;
      const bytes = sizes.reduce((total, value) => total + value, 0);
      const codec = [level.videoCodec, level.audioCodec].filter(Boolean).join(",");
      const url = new URL(level.uri, location.href);
      if (url.origin !== location.origin || !level.videoCodec ||
          !Hls.getMediaSource()?.isTypeSupported(`video/mp4; codecs="${codec}"`)) continue;
      this.variant = { url: url.href, sizes, bytes, profile, width: level.width, height: level.height };
      this.Hls = Hls;
      this.status = "Waiting for spare bandwidth";
      return;
    }
    this.status = "No compatible rendition";
    this.disabled = true;
  }

  stop() {
    this.request?.abort();
  }

  get savingEnabled() { return window.streamStorage?.enabled !== false; }

  observe(time, seeking = false) {
    if (!Number.isFinite(time) || time < 0) return;
    if (seeking || Math.abs(time - this.position) > 8) {
      this.stop();
      if (seeking) {
        this.predictionRevision = (this.predictionRevision || 0) + 1;
        const key = Math.floor(time / 4), old = this.seekTargets.get(key);
        this.seekTargets.set(key, { time, hits: (old?.hits || 0) + 1, seen: Date.now() });
        if (this.seekTargets.size > 24) {
          const oldest = [...this.seekTargets].sort((a, b) => a[1].seen - b[1].seen)[0][0];
          this.seekTargets.delete(oldest);
        }
      }
    }
    this.position = time;
    if (this.capacityBytes && this.blockedAsset && this.asset(this.blockedAsset)?.bytes &&
        !this.workingSet().some(asset => asset.url === this.blockedAsset)) {
      this.unsaved = null; this.blockedAsset = null; this.storageError = null; this.retryAt = 0;
    }
  }

  fragmentFor(url) {
    if (this.rankedDetails !== this.details) {
      this.rankedDetails = this.details;
      this.fragmentsByUrl = new Map((this.details?.fragments || []).map(frag => [frag.url, frag]));
    }
    return this.fragmentsByUrl?.get(url);
  }

  priority(asset) {
    const frag = this.fragmentFor(asset.url);
    if (!frag) return Infinity; // Never evict the playlist or initialization.
    const ahead = frag.start - this.position, behind = this.position - frag.end;
    if (ahead <= 0 && behind < 0) return 1000000;
    if (ahead >= 0 && ahead < 30) return 900000 - ahead * 100;
    let prediction = 0;
    for (const target of this.seekTargets.values()) {
      if (target.hits >= 2 && target.time >= frag.start - 4 && target.time < frag.end + 4) {
        const direct = target.time >= frag.start && target.time < frag.end;
        prediction = Math.max(prediction, (direct ? 800000 : 790000) + Math.min(target.hits, 10) * 100 - Math.abs(ahead));
      }
    }
    if (behind >= 0 && behind < 30) return Math.max(prediction, 700000 - behind * 100);
    return Math.max(prediction, ahead >= 0 ? 500000 - ahead : 300000 - behind);
  }

  storedBytes() {
    return [...this.available].reduce((sum, url) => sum + (this.entryBytes.get(url) || this.asset(url)?.bytes || 0), 0);
  }

  cacheBudget() {
    // Learn from actual write failures, not Chrome's privacy-adjusted estimate.
    if (!this.capacityBytes) return Infinity;
    return Math.floor(this.capacityBytes - Math.min(8 * 1024 * 1024, this.capacityBytes * 0.02));
  }

  workingSet() {
    if (!this.assets) return [];
    const key = `${this.position}/${this.capacityBytes}/${this.predictionRevision}/${this.entryBytes.get(this.variant.url)}/${this.entryBytes.get(this.assets[0].url)}`;
    if (this.planKey === key && this.planAssets === this.assets) return this.plan;
    const sorted = this.assets.slice(1).sort((a, b) => this.priority(b) - this.priority(a));
    let remaining = this.cacheBudget() - (this.entryBytes.get(this.variant.url) || REPLAY_PLAYLIST_LIMIT) -
      (this.entryBytes.get(this.assets[0].url) || REPLAY_INIT_LIMIT);
    this.planKey = key; this.planAssets = this.assets;
    return this.plan = [this.assets[0], ...sorted.filter(asset => {
      if (asset.bytes > remaining) return false;
      remaining -= asset.bytes;
      return true;
    })];
  }

  protectedAsset(url) {
    if (this.readers.has(url) || this.writes.has(url) || this.transfers.has(url)) return true;
    const frag = this.fragmentFor(url);
    return frag && frag.start <= this.position + 0.15 && frag.end >= this.position - 0.15;
  }

  pin(url) {
    this.readers.set(url, (this.readers.get(url) || 0) + 1);
    return () => {
      const left = this.readers.get(url) - 1;
      if (left > 0) this.readers.set(url, left);
      else this.readers.delete(url);
    };
  }

  async trimFor(cache, incoming) {
    let needed = this.storedBytes() + (incoming.bytes || incoming.limit) - this.cacheBudget();
    if (needed <= 0 || !this.assets) return;
    const wanted = new Set(this.workingSet().map(asset => asset.url));
    const victims = this.assets.slice(1).filter(asset => this.available.has(asset.url) &&
      !wanted.has(asset.url) && !this.protectedAsset(asset.url)).sort((a, b) => this.priority(a) - this.priority(b));
    for (const victim of victims) {
      if (needed <= 0) break;
      if (await cache.delete(victim.url)) {
        this.available.delete(victim.url); this.entryBytes.delete(victim.url);
        this.evictedBytes += victim.bytes; needed -= victim.bytes;
        this.ready = false;
      }
    }
    this.updateProgress();
  }

  invalidate() {
    this.ready = false;
    this.cacheOpening = null;
    this.available.clear();
    this.entryBytes.clear();
    this.capacityBytes = null;
    this.planKey = null;
    this.bytes = this.segments = 0;
    this.status = "Cache entry missing";
    this.retryAt = Date.now() + 1000;
  }

  asset(url) {
    if (!this.variant) return null;
    if (url === this.variant.url) return { url, limit: REPLAY_PLAYLIST_LIMIT, text: true };
    if (url === new URL("init.mp4", this.variant.url).href) return { url, limit: REPLAY_INIT_LIMIT };
    const match = /\/seg-(\d{5})\.m4s$/.exec(url);
    const bytes = match && this.variant.sizes[Number(match[1])];
    return bytes && url === new URL(`seg-${match[1]}.m4s`, this.variant.url).href ? { url, bytes } : null;
  }

  async prune(cache) {
    for (const key of await cache.keys()) {
      if (this.asset(key.url)) continue;
      const old = await cache.match(key);
      const bytes = Number(old?.headers.get("Content-Length"));
      if (await cache.delete(key)) this.reclaimedBytes += Number.isFinite(bytes) ? bytes : 0;
    }
  }

  async openCache() {
    if (!this.savingEnabled) throw new DOMException("Video saving is off", "AbortError");
    if (!this.cacheOpening) this.cacheOpening = navigator.locks.request(REPLAY_CACHE, async () => {
      const cache = await window.caches.open(REPLAY_CACHE);
      // Free the previous film and obsolete versions BEFORE the first new write.
      await this.prune(cache);
      this.available = new Set((await cache.keys()).map(key => key.url).filter(url => this.asset(url)));
      for (const url of this.available) {
        const response = await cache.match(url);
        const bytes = Number(response?.headers.get("Content-Length"));
        if (bytes > 0) this.entryBytes.set(url, bytes);
      }
      this.cache = cache;
      if (this.assets) this.updateProgress();
      return cache;
    }).catch(error => { this.cacheOpening = null; throw error; });
    return this.cacheOpening;
  }

  async match(url) {
    if (!this.available.has(url)) return null;
    try {
      const response = await this.cache?.match(url);
      if (response) return response;
    } catch { /* An evicted entry is a normal cache miss. */ }
    this.available.delete(url);
    this.ready = false;
    this.cacheOpening = null;
    if (this.assets) this.updateProgress();
    return null;
  }

  async storageFailure(error) {
    this.storageError = error.name || "Error";
    const full = error.name === "QuotaExceededError";
    this.disabled = error.name === "SecurityError" || error.name === "NotSupportedError";
    this.status = full ? "Browser storage full; saved video retained" : this.disabled ? "Browser storage blocked" : "Retrying preload";
    this.retryAt = Date.now() + (full ? 60000 : 15000);
    try { this.storage = await navigator.storage?.estimate(); } catch { /* Estimates are optional. */ }
  }

  async tick(canDownload, time = 0) {
    this.observe(time);
    if (!this.savingEnabled) { this.status = "Video saving off"; return; }
    if (!this.variant || this.ready || this.disabled || this.request ||
        Date.now() < (this.retryAt || 0) || !canDownload(REPLAY_PLAYLIST_LIMIT)) return;
    const request = this.request = new AbortController();
    try {
      await this.preload(request.signal, canDownload, time);
    } catch (error) {
      if (!request.signal.aborted) await this.storageFailure(error);
    } finally {
      this.request = null;
      if (request.signal.aborted && !this.ready && !this.storageError) this.status = "Waiting for spare bandwidth";
    }
  }

  async preload(signal, canDownload, time) {
    const { url, sizes } = this.variant;
    await this.openCache();
    if (signal.aborted) return;
    // Retry the same rejected bytes before issuing another background request.
    if (this.unsaved) {
      const retained = this.unsaved;
      if (!this.capacityBytes || this.workingSet().some(asset => asset.url === retained.asset.url)) {
        await this.save(retained.asset, retained.result);
      } else this.unsaved = null;
    }
    const playlist = this.asset(url);
    if (!this.assets) {
      if (!canDownload(playlist.limit)) return;
      await this.store(playlist, signal);
      if (signal.aborted) return;
      const details = await readUpgradePlaylist(this.Hls, url, signal, this.loader(() => {}));
      if (signal.aborted) return;
      this.assets = this.assetsFor(details);
      this.details = details;
      if (!this.assets) {
        await this.cache.delete(url);
        this.status = "Unsupported replay playlist";
        this.disabled = true;
        return;
      }
    }
    this.updateProgress();
    await this.store(playlist, signal);
    for (const asset of this.workingSet()) {
      if (signal.aborted) return;
      if (this.available.has(asset.url)) continue;
      if (!canDownload(asset.bytes || asset.limit)) {
        this.status = "Waiting for spare bandwidth";
        return;
      }
      this.status = "Downloading";
      await this.store(asset, signal);
      // The first quota error may have changed a whole-film preload into a
      // bounded working set. Replan next tick instead of churning the cache.
      if (this.capacityBytes && !this.workingSet().some(item => item.url === asset.url)) break;
    }
    if (signal.aborted) return;
    this.ready = this.segments === sizes.length && this.available.has(url) && this.available.has(this.assets[0].url);
    this.status = this.ready ? "Ready" : this.capacityBytes ? "Predictive rolling cache ready" : "Waiting for spare bandwidth";
    // Space may become available later. Probe sparingly without evicting useful
    // video, and grow the learned budget only after a real successful write.
    if (!this.ready && this.capacityBytes && Date.now() >= (this.nextProbeAt || Infinity)) {
      const extra = this.assets.slice(1).filter(asset => !this.available.has(asset.url))
        .sort((a, b) => this.priority(b) - this.priority(a))[0];
      if (extra && canDownload(extra.bytes)) {
        this.nextProbeAt = Date.now() + 30000;
        await this.store(extra, signal, true);
      }
    }
  }

  assetsFor(details) {
    const { url, sizes } = this.variant;
    const init = new URL("init.mp4", url).href;
    if (!details || details.live || details.fragments.length !== sizes.length) return null;
    const assets = [{ url: init, limit: REPLAY_INIT_LIMIT }];
    const seen = new Set();
    for (const [i, frag] of details.fragments.entries()) {
      if (!/^seg-\d{5}\.m4s$/.test(frag.relurl) || frag.url !== new URL(frag.relurl, url).href ||
          seen.has(frag.url) || frag.initSegment?.url !== init || frag.initSegment.byteRange.length ||
          frag.encrypted || frag.gap || frag.byteRange.length) return null;
      seen.add(frag.url);
      assets.push({ url: frag.url, bytes: sizes[i] });
    }
    return assets;
  }

  assetsNear(time) {
    const current = this.details.fragments.findIndex(frag => time >= frag.start && time < frag.end);
    if (current < 0) return this.assets;
    // Cache the current segment and the remaining film before revisiting the past.
    return [this.assets[0], ...this.assets.slice(current + 1), ...this.assets.slice(1, current + 1).reverse()];
  }

  cachedRanges() {
    if (!this.details || !this.assets || !this.available.has(this.variant.url) ||
        !this.available.has(this.assets[0].url)) return [];
    const ranges = [];
    for (const frag of this.details.fragments) {
      if (!this.available.has(frag.url)) continue;
      const previous = ranges.at(-1);
      if (previous && frag.start <= previous.end + 0.001) previous.end = frag.end;
      else ranges.push({ start: frag.start, end: frag.end });
    }
    return ranges;
  }

  frameAvailable(time) {
    if (!this.assets || !this.available.has(this.variant.url) || !this.available.has(this.assets[0].url)) return false;
    const current = this.details.fragments.findIndex(frag => time >= frag.start && time < frag.end);
    if (current < 0) return false;
    const frag = this.details.fragments[current];
    const needed = [current];
    // A frame close to a cut can be carried in the neighboring media file.
    if (current > 0 && time - frag.start < 0.15) needed.push(current - 1);
    if (current + 1 < this.variant.sizes.length && frag.end - time < 0.15) needed.push(current + 1);
    return needed.every(i => this.available.has(this.assets[i + 1].url));
  }

  covers(start, end) {
    return end > start && this.cachedRanges().some(range => range.start <= start && range.end >= end - 0.05);
  }

  updateProgress() {
    this.bytes = this.segments = 0;
    for (const asset of this.assets) {
      if (asset.bytes && this.available.has(asset.url)) {
        this.bytes += asset.bytes;
        this.segments++;
      }
    }
  }

  response(asset, result) {
    return new Response(result.data, { headers: { "Content-Length": String(result.data.byteLength),
      "Content-Type": asset.text ? "application/vnd.apple.mpegurl" : "video/mp4" } });
  }

  async save(asset, result, probe = false) {
    if (!this.savingEnabled) return;
    if (this.available.has(asset.url)) return;
    if (this.writes.has(asset.url)) return this.writes.get(asset.url).promise;
    let stored = false;
    const write = (async () => {
      const cache = await this.openCache();
      await navigator.locks.request(REPLAY_CACHE, async () => {
        if (!this.savingEnabled) return;
        if (!probe && this.capacityBytes && asset.bytes &&
            !this.workingSet().some(item => item.url === asset.url)) return;
        if (!probe && this.capacityBytes) await this.trimFor(cache, asset);
        let failure;
        for (let attempt = 0; attempt < 4; attempt++) {
          try { await cache.put(asset.url, this.response(asset, result)); failure = null; break; }
          catch (error) {
            if (error.name !== "QuotaExceededError") throw error;
            failure = error;
            // Another tab or an older version may have left stale entries.
            if (!attempt) { await this.prune(cache); continue; }
            if (probe) { this.nextProbeAt = Date.now() + 300000; return; }
            if (!this.assets || !this.details ||
                this.assets.slice(1).filter(item => this.available.has(item.url)).length < 2) throw error;
            this.capacityBytes = Math.min(this.storedBytes(), this.capacityBytes ? this.capacityBytes * 0.75 : Infinity);
            this.nextProbeAt = Date.now() + 300000;
            this.storageError = null; this.retryAt = 0; this.blockedAsset = null;
            this.status = "Predictive rolling cache ready";
            if (asset.bytes && !this.workingSet().some(item => item.url === asset.url)) return;
            await this.trimFor(cache, asset);
          }
        }
        if (failure) throw failure;
        this.available.add(asset.url);
        this.entryBytes.set(asset.url, result.data.byteLength);
        stored = true;
        if (probe) this.capacityBytes = this.storedBytes() + Math.min(8 * 1024 * 1024, this.storedBytes() * 0.02);
      });
      if (!this.savingEnabled || !stored) return;
      if (this.unsaved?.asset.url === asset.url) this.unsaved = null;
      if (!this.blockedAsset || this.blockedAsset === asset.url) {
        this.blockedAsset = null;
        this.storageError = null;
        this.retryAt = 0;
      }
      if (this.assets) {
        this.updateProgress();
        this.ready = this.segments === this.variant.sizes.length &&
          this.available.has(this.variant.url) && this.available.has(this.assets[0].url);
        if (this.ready) this.status = "Ready";
      }
    })();
    this.writes.set(asset.url, { promise: write, result });
    try { await write; }
    catch (error) {
      if (error.name === "QuotaExceededError") this.blockedAsset = asset.url;
      if (error.name === "QuotaExceededError" && !this.unsaved && result.data.byteLength <= REPLAY_RETRY_LIMIT) {
        this.unsaved = { asset, result };
      }
      await this.storageFailure(error);
      throw error;
    } finally { this.writes.delete(asset.url); }
  }

  async store(asset, signal, probe = false) {
    if (signal.aborted || this.available.has(asset.url)) return;
    const result = await this.download(asset, signal);
    if (signal.aborted) return;
    await this.save(asset, result, probe);
  }

  download(asset, signal, progress) {
    signal.throwIfAborted();
    const writing = this.writes.get(asset.url);
    if (writing) { this.sharedDownloads++; return Promise.resolve(writing.result); }
    let transfer = this.transfers.get(asset.url);
    if (transfer) this.sharedDownloads++;
    else {
      const controller = new AbortController();
      transfer = { controller, clients: new Set(), progress: new Set(), settled: false,
        loading: { start: performance.now(), first: 0, end: 0 }, loaded: 0 };
      const current = transfer;
      this.transfers.set(asset.url, transfer);
      current.promise = (async () => {
        // This explicit cache owns reuse. Avoid a second automatic HTTP-cache
        // copy of every highest-quality segment competing for local disk.
        let response = await fetch(asset.url, { mode: "same-origin", cache: "no-store",
          priority: progress ? "high" : "low", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]) });
        current.loading.first = performance.now();
        if (response.status !== 200 || response.url !== asset.url) {
          await response.body?.cancel(); throw new Error("Replay asset is incomplete");
        }
        const length = response.headers.get("Content-Length");
        if (length !== null && !response.headers.has("Content-Encoding") &&
            (!Number.isSafeInteger(Number(length)) || Number(length) <= 0 ||
             (asset.bytes ? Number(length) !== asset.bytes : Number(length) > asset.limit))) {
          await response.body?.cancel(); throw new Error("Replay asset is incomplete");
        }
        response = await this.readBounded(asset, response, bytes => {
          current.loaded = bytes;
          for (const notify of current.progress) notify(current);
        });
        const data = await response.arrayBuffer();
        current.loading.end = performance.now();
        return { data, loading: current.loading, fromCache: false };
      })().finally(() => {
        current.settled = true;
        if (this.transfers.get(asset.url) === current) this.transfers.delete(asset.url);
      });
    }
    const client = {};
    transfer.clients.add(client);
    if (progress) transfer.progress.add(progress);
    return new Promise((resolve, reject) => {
      const abort = () => reject(new DOMException("Download canceled", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      transfer.promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    }).finally(() => {
      transfer.clients.delete(client);
      if (progress) transfer.progress.delete(progress);
      // FRAG_LOADING cancels background work before its playback loader joins.
      // Defer cancellation for that handoff, preserving the shared request.
      if (!transfer.clients.size && !transfer.settled) setTimeout(() => {
        if (!transfer.clients.size && !transfer.settled) transfer.controller.abort();
      }, 0);
    });
  }

  async playback(asset, signal, progress) {
    const release = this.pin(asset.url);
    try { return await this.playbackRead(asset, signal, progress); }
    finally { release(); }
  }

  async playbackRead(asset, signal, progress) {
    if (!this.savingEnabled) return this.download(asset, signal, progress);
    try { await this.openCache(); } catch (error) { await this.storageFailure(error); }
    signal.throwIfAborted();
    const response = await this.match(asset.url);
    if (response) return { data: await response.arrayBuffer(), fromCache: true };
    const retained = this.unsaved?.asset.url === asset.url ? this.unsaved.result : null;
    const result = retained || await this.download(asset, signal, progress);
    if (!signal.aborted && !this.disabled && Date.now() >= (this.retryAt || 0)) {
      // Cache persistence must never delay delivery of a playable segment.
      const saving = this.save(asset, result);
      saving.then(() => { if (asset.bytes) this.playbackSavedBytes += asset.bytes; }, () => {});
    }
    return result;
  }

  async readBounded(asset, response, progress) {
    const reader = response.body.getReader();
    const limit = asset.bytes || asset.limit;
    let bytes = 0;
    const chunks = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > limit) throw new Error("Replay asset exceeds its size limit");
        chunks.push(value);
        progress?.(bytes);
      }
    } finally {
      await reader.cancel();
    }
    if (!bytes || (asset.bytes && bytes !== asset.bytes)) throw new Error("Replay asset is incomplete");
    return new Response(new Blob(chunks), { headers: { "Content-Length": String(bytes),
      "Content-Type": response.headers.get("Content-Type") || "application/octet-stream" } });
  }

  loader(onMiss, requireCache = true) {
    const replay = this;
    const BaseLoader = this.Hls.DefaultConfig.loader;
    return class ReplayLoader extends BaseLoader {
      load(context, config, callbacks) {
        this.context = context;
        this.stats.fromReplayCache = false;
        const required = typeof requireCache === "function" ? requireCache() : requireCache;
        if (!required && !replay.savingEnabled) return super.load(context, config, callbacks);
        const asset = replay.asset(context.url);
        if (!required && !asset) return super.load(context, config, callbacks);
        if (!required && (context.rangeEnd || context.rangeStart)) return super.load(context, config, callbacks);
        if (!required && asset && !(context.rangeEnd || context.rangeStart)) {
          const operation = this.read = { context, callbacks, request: new AbortController() };
          const timer = setTimeout(() => {
            if (this.read !== operation) return;
            this.read = null; operation.request.abort();
            callbacks.onTimeout(this.stats, context, null);
          }, config.timeout || 20000);
          replay.playback(asset, operation.request.signal, transfer => {
            if (this.read !== operation) return;
            this.stats.loaded = transfer.loaded;
            Object.assign(this.stats.loading, transfer.loading);
          }).then(result => {
            if (this.read !== operation) return;
            this.read = null;
            this.stats.loaded = this.stats.total = result.data.byteLength;
            this.stats.fromReplayCache = result.fromCache;
            const now = performance.now();
            Object.assign(this.stats.loading, result.loading || { start: now, first: now, end: now });
            // HLS transfers ArrayBuffers to its decoder worker. Give that
            // consumer ownership without detaching bytes still being saved
            // or read by another consumer of this shared download.
            const data = context.responseType === "arraybuffer" ? result.data.slice(0) : new TextDecoder().decode(result.data);
            callbacks.onSuccess({ url: context.url, data }, this.stats, context, null);
          }, error => {
            if (this.read !== operation) return;
            this.read = null;
            callbacks.onError({ code: 0, text: error.message }, context, null, this.stats);
          }).finally(() => clearTimeout(timer));
          return;
        }
        const operation = this.read = { context, callbacks };
        const start = performance.now();
        const release = replay.pin(context.url);
        replay.match(context.url).then(async response => {
          if (!response) throw new Error("Replay asset is missing");
          return context.responseType === "arraybuffer" ? response.arrayBuffer() : response.text();
        }).finally(release).then(data => {
          if (this.read !== operation) return;
          this.read = null;
          this.stats.loaded = this.stats.total = data.byteLength ?? data.length;
          this.stats.fromReplayCache = true;
          Object.assign(this.stats.loading, { start, first: start, end: performance.now() });
          callbacks.onSuccess({ url: context.url, data }, this.stats, context, null);
        }, () => {
          if (this.read !== operation) return;
          this.read = null;
          if (!required) {
            super.load(context, config, callbacks);
            return;
          }
          onMiss();
          callbacks.onError({ code: 0, text: "Replay cache unavailable" }, context, null, this.stats);
        });
      }

      abort() {
        const operation = this.read;
        if (!operation) { super.abort(); return; }
        this.read = null;
        operation.request?.abort();
        this.stats.aborted = true;
        operation.callbacks.onAbort?.(this.stats, operation.context, null);
      }

      destroy() {
        this.read?.request?.abort();
        this.read = null;
        super.destroy();
      }
    };
  }
}
window.ReplayPreload = ReplayPreload;
