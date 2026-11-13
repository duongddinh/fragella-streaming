"use strict";

function validSegmentSizes(index) {
  if (!validSegmentTimeline(index?.starts_ms)) return false;
  const levels = Object.entries(index.bytes || {});
  return levels.length >= 2 && levels.length <= 4 && levels.every(([level, sizes]) => {
    const starts = segmentStarts(index, level);
    return /^(480|720|1080|2160)p$/.test(level) && validSegmentTimeline(starts) &&
      Array.isArray(sizes) && sizes.length === starts.length && sizes.every(size => Number.isSafeInteger(size) && size > 0);
  });
}

function validSegmentTimeline(starts) {
  return Array.isArray(starts) && starts.length >= 1 && starts.length <= 1800 && starts[0] === 0 &&
    starts.every((time, i) => Number.isSafeInteger(time) && (i === 0 || time > starts[i - 1]));
}

function segmentStarts(index, profile) {
  return index.timelines_ms?.[profile] || index.starts_ms;
}

function renditionProfile(level) {
  // The nominal profile can differ from the pixel height for wide footage.
  return /\/(480p|720p|1080p|2160p)\/index\.m3u8$/.exec(level?.uri || "")?.[1];
}

function cachedAutoLevel(hls, normal, replay, position) {
  if (!hls.autoLevelEnabled || hls.media?.paused || replay?.savingEnabled === false || !replay?.frameAvailable(position)) return normal;
  const target = hls.levels.findIndex(level => level.uri === replay.variant.url);
  // A local segment costs no network bandwidth. Keep normal ABR for gaps and
  // let error recovery avoid a rendition that has failed to load.
  return target > normal && !hls.levels[target].loadError ? target : normal;
}

function segmentSizeCap(hls, cap, index) {
  if (!index || !hls.autoLevelEnabled || hls.media?.paused || hls.media?.seeking || cap <= hls.minAutoLevel) return cap;
  const buffer = hls.mainForwardBufferInfo;
  const bandwidth = hls.bandwidthEstimate;
  if (!buffer || buffer.len <= 0 || !Number.isFinite(bandwidth) || bandwidth <= 0) return cap;

  // Only use an estimate when the forward buffer ends at a known cut point.
  // Audio padding and timestamp rounding can shift that boundary slightly.
  const end = buffer.end * 1000;
  const rate = Math.abs(hls.media?.playbackRate || 1);
  const seconds = Math.max(0, buffer.len / rate - 0.25);
  const budget = seconds * bandwidth * 0.85 / 8;
  for (let level = hls.minAutoLevel + 1; level <= cap; level++) {
    const profile = renditionProfile(hls.levels[level]);
    const starts = segmentStarts(index, profile);
    const segment = starts.findIndex(time => Math.abs(time - end) <= 100);
    if (segment < 0 || Math.abs(starts[segment + 1] - end) <= 100) return cap;
    const bytes = index.bytes[profile]?.[segment];
    if (!bytes) return cap;
    if (bytes > budget) return level - 1;
  }
  return cap;
}

function upgradeBudget(media, buffer, refillAt, segmentStart, bandwidth, ttfb) {
  if (!buffer || media.paused || media.seeking || media.readyState < 3 || media.playbackRate <= 0 ||
      buffer.len / media.playbackRate < 8 || !Number.isFinite(bandwidth) || bandwidth <= 0) return null;
  // Reserve time for the normal refill and keep the replacement clear of the playhead.
  const lead = (segmentStart - media.currentTime) / media.playbackRate;
  const slack = (buffer.len - refillAt) / media.playbackRate;
  const seconds = Math.min(2, lead - 3, slack - 0.3);
  if (seconds <= 0.25) return null;
  const bytes = Math.min(8 * 1024 * 1024, Math.max(0, seconds - ttfb / 1000) * bandwidth / 16);
  return { bytes, timeout: seconds * 1000 };
}

function fullBufferBudget(media, start, end, bandwidth, ttfb, replay) {
  if (!Number.isFinite(bandwidth) || bandwidth <= 0 || media.playbackRate <= 0) return null;
  const time = media.currentTime, rate = media.playbackRate;
  if (replay && end > time - 3) return null;
  const lead = ((replay ? media.duration : start) - time) / rate;
  const seconds = Math.min(30, lead - (replay ? 0.5 : 3));
  if (seconds <= 0.25) return null;
  return { bytes: Math.min(16 * 1024 * 1024, Math.max(0, seconds - ttfb / 1000) * bandwidth * 0.7 / 8),
    timeout: seconds * 1000 };
}

function readUpgradePlaylist(Hls, url, signal, loader) {
  // Use the pinned parser in an unattached instance. Optional playlist errors
  // must never reach the controllers responsible for the playing video.
  return new Promise(resolve => {
    const reader = new Hls({ autoStartLoad: false, enableWorker: false, ...(loader && { loader }) });
    let settled = false;
    const finish = details => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      reader.destroy();
      resolve(details);
    };
    const abort = () => finish(null);
    signal.addEventListener("abort", abort, { once: true });
    reader.on(Hls.Events.ERROR, abort);
    reader.on(Hls.Events.MANIFEST_PARSED, (_event, { levels }) => {
      const details = levels[0]?.details;
      // Let the manifest event finish before destroying its controllers.
      queueMicrotask(() => { if (!signal.aborted) finish(details); });
    });
    reader.loadSource(url);
  });
}

function bufferedUpgrades(Hls, getIndex, metrics, preload, Loader = Hls.DefaultConfig.loader) {
  // The optional overlapping append uses the stock fragment pipeline in this pinned build.
  if (Hls.version !== "1.7.4") return {};
  const { streamController, abrController } = Hls.DefaultConfig;
  let committing = null;

  class UpgradeLoader extends Loader {
    load(context, config, callbacks) {
      if (context.frag !== committing?.frag || !committing?.data) return super.load(context, config, callbacks);
      const { data, loading } = committing;
      committing.data = null;
      this.stats.loaded = this.stats.total = data.byteLength;
      Object.assign(this.stats.loading, loading);
      callbacks.onSuccess({ url: context.url, data }, this.stats, context, null);
    }
  }

  class UpgradeAbrController extends abrController {
    onFragLoading(event, data) {
      if (data.frag !== committing?.frag && !preload?.available.has(data.frag.url)) super.onFragLoading(event, data);
    }
    onFragLoaded(event, data) {
      if (data.frag !== committing?.frag && !data.frag.stats.fromReplayCache) super.onFragLoaded(event, data);
    }
    onFragBuffered(event, data) {
      if (data.frag !== committing?.frag && !data.frag.stats.fromReplayCache) super.onFragBuffered(event, data);
    }
  }

  class UpgradeStreamController extends streamController {
    constructor(...args) {
      super(...args);
      this.attemptedUpgrades = new Set();
      this.misalignedUpgrades = new WeakSet();
      this.failedUpgradePlaylists = new WeakSet();
      const seek = this.onMediaSeeking;
      this.onMediaSeeking = () => {
        if (this.media?.currentTime < this.lastCurrentTime - 0.25) this.attemptedUpgrades.clear();
        this.cancelUpgrade();
        this.upgradePlaylistRequest?.abort();
        seek();
      };
      for (const event of [
        Hls.Events.FRAG_LOADING, Hls.Events.LEVEL_LOADING, Hls.Events.BUFFER_FLUSHING, Hls.Events.MEDIA_DETACHING,
      ]) {
        this.hls.on(event, () => {
          this.cancelUpgrade();
          this.upgradePlaylistRequest?.abort();
        });
      }
    }

    cancelUpgrade(status = "Canceled") {
      if (!this.pendingUpgrade) return;
      this.pendingUpgrade.request.abort();
      this.pendingUpgrade = null;
      metrics.last.status = status;
    }

    stopLoad() {
      this.cancelUpgrade();
      this.upgradePlaylistRequest?.abort();
      if (committing) metrics.last.status = "Canceled";
      committing = null;
      super.stopLoad();
    }

    onFragBuffered(event, data) {
      if (data.frag === committing?.frag) {
        // Keep normal scheduling anchored to the last forward append.
        if (this.fragPrevious === data.frag && committing.previous !== committing.lower) {
          this.fragPrevious = committing.previous;
        }
        if (this.fragmentTracker.getState(data.frag) === "OK") {
          if (!committing.lower.endList) this.fragmentTracker.removeFragment(committing.lower);
          metrics.applied++;
          metrics.last.status = "Applied";
        } else {
          metrics.last.status = "Skipped";
        }
        committing = null;
      }
      super.onFragBuffered(event, data);
    }

    _handleTransmuxComplete(data) {
      const upgrade = committing;
      if (upgrade && !upgrade.timingChecked &&
          data.chunkMeta.level === upgrade.frag.level && data.chunkMeta.sn === upgrade.frag.sn) {
        const video = data.remuxResult.video;
        const previous = video && upgrade.lower.elementaryStreams[video.type];
        // Playlists can agree while an open GOP puts HEVC frames on the other
        // side of a cut. Inspect the actual media before any codec or append event.
        const { media } = this;
        const tooClose = !media || media.seeking || (upgrade.replay ?
          upgrade.frag.end > media.currentTime - 3 : upgrade.frag.start < media.currentTime + 3 * media.playbackRate);
        if (tooClose || !previous || video.firstKeyFrame !== 0 ||
            (Number.isFinite(video.firstKeyFramePTS) && Math.abs(video.firstKeyFramePTS - video.startPTS) > 0.015) ||
            !(Math.abs(video.startPTS - previous.startPTS) <= 0.015 && Math.abs(video.endPTS - previous.endPTS) <= 0.015)) {
          metrics.last.status = tooClose ? "Canceled" : "Skipped (timing mismatch)";
          if (!tooClose) this.misalignedUpgrades.add(upgrade.frag);
          committing = null;
          this.resetTransmuxer();
          this.fragmentTracker.removeFragment(upgrade.frag);
          this.fragCurrent = null;
          this.state = "IDLE";
          return;
        }
        upgrade.timingChecked = true;
      }
      super._handleTransmuxComplete(data);
    }

    doTickIdle() {
      super.doTickIdle();
      if (this.state === "IDLE") this.tryUpgrade(false);
    }

    doTick() {
      super.doTick();
      if (this.state === "ENDED") this.tryUpgrade(true);
    }

    calculateOptimalSwitchPoint(level, buffer) {
      if (preload?.variant && preload.savingEnabled !== false && level?.uri === preload.variant.url && (preload.ready ||
          preload.covers(this.media.currentTime, buffer.end))) {
        // This rendition is local. A network throughput estimate would
        // unnecessarily delay the stock smooth switch until far into the film.
        return { fetchdelay: 0.25, okToFlushForwardBuffer: true };
      }
      return super.calculateOptimalSwitchPoint(level, buffer);
    }

    tryUpgrade(fullyBuffered) {
      const { hls, media } = this;
      const index = getIndex();
      if (!media || !index || !this.buffering || !hls.autoLevelEnabled || media.readyState < 3 ||
          media.paused || media.ended || media.seeking || document.hidden || navigator.connection?.saveData) {
        this.cancelUpgrade();
        return;
      }
      if (committing) {
        metrics.last.status = "Skipped";
        committing = null;
      }
      const buffer = hls.mainForwardBufferInfo;
      // A single real TimeRange must cover the rest of the film before using
      // the longer download deadline or spending data on a replay.
      const wholeRange = fullyBuffered && Array.from({ length: media.buffered.length }, (_, i) => ({
        start: media.buffered.start(i), end: media.buffered.end(i),
      })).find(range => range.start <= media.currentTime && range.end >= media.duration - 0.05);
      if (!buffer || (fullyBuffered && !wholeRange)) {
        this.cancelUpgrade();
        return;
      }
      const bandwidth = hls.bandwidthEstimate, ttfb = hls.ttfbEstimate || 0;
      const budgetFor = (level, start, end, replay) => fullyBuffered ? fullBufferBudget(media, start, end, bandwidth, ttfb, replay) :
        upgradeBudget(media, buffer, this.getMaxBufferLength(level.maxBitrate), start, bandwidth, ttfb);
      const pending = this.pendingUpgrade;
      if (pending) {
        const level = hls.levels[pending.frag.level];
        if (!level || pending.full !== fullyBuffered ||
            pending.frag.end > buffer.end + 0.05 || (wholeRange && pending.frag.start < wholeRange.start - 0.05) ||
            !budgetFor(level, pending.frag.start, pending.frag.end, pending.replay) ||
            this.fragmentTracker.getState(pending.lower) !== "OK") {
          this.cancelUpgrade();
        } else if (pending.data) {
          this.pendingUpgrade = null;
          committing = { ...pending, previous: this.fragPrevious };
          metrics.last.status = "Appending";
          if (pending.init) pending.frag.initSegment.data = pending.init;
          const next = this.nextLoadPosition;
          this.loadFragment(pending.frag, level, pending.frag.start);
          this.nextLoadPosition = next;
        }
        return;
      }
      if (this.upgradePlaylistRequest || performance.now() < (this.nextUpgradeAt || 0)) return;
      // Spare bandwidth can improve the buffered copy even if network ABR has
      // not selected a higher level yet. Keep the same deadline/codec checks.
      const levels = hls.levels.slice().reverse();
      let candidate = null;
      for (const level of levels) {
        const profile = renditionProfile(level);
        const sizes = index.bytes[profile];
        if (!sizes || level.details?.live || this.failedUpgradePlaylists.has(level)) continue;
        const avc = level.videoCodec?.startsWith("avc1.");
        if (!avc && !(profile === "2160p" && level.videoRange === "SDR" &&
            level.videoCodec?.startsWith("hvc1.") && this.canAppend4K(level))) continue;
        const match = this.findUpgrade(level, profile, segmentStarts(index, profile), sizes, buffer.end, wholeRange, budgetFor);
        if (!match) continue;
        candidate ||= match;
        if (!match.replay) {
          candidate = match;
          break;
        }
      }
      if (!candidate) return;
      const { frag, lower, key, bytes, timeout, replay, level, cached } = candidate;
      if (!frag) {
        this.prepareUpgradePlaylist(level, hls.levels.indexOf(level));
        return;
      }
      this.attemptedUpgrades.add(key);
      this.nextUpgradeAt = performance.now() + (cached ? 1000 : 8000);
      this.stageUpgrade(frag, lower, bytes, timeout, replay, fullyBuffered, cached);
    }

    findUpgrade(level, profile, starts, sizes, bufferEnd, wholeRange, budgetFor) {
      const { hls, media } = this;
      const first = starts.findIndex((_, i) => wholeRange ?
        i + 1 === starts.length || starts[i + 1] / 1000 >= media.currentTime - 20 :
        starts[i] / 1000 > media.currentTime + 3 * media.playbackRate);
      if (first < 0) return null;
      let candidate = null;
      for (let i = first; i < sizes.length; i++) {
        const start = starts[i] / 1000;
        const end = i + 1 < sizes.length ? starts[i + 1] / 1000 : wholeRange ? media.duration : Infinity;
        if (end > bufferEnd + 0.05) break;
        const replay = end <= media.currentTime - 3;
        if (replay && (!wholeRange || start < wholeRange.start - 0.1 || media.currentTime - end > 20)) continue;
        const frag = level.details?.fragments[i];
        const cached = preload?.available.has(frag?.url) ||
          (!frag && preload?.ready && preload.variant.url === level.uri);
        const budget = budgetFor(level, start, end, replay);
        const key = `${profile}/${i}`;
        if (!budget || (!cached && sizes[i] > budget.bytes) || this.attemptedUpgrades.has(key)) continue;
        const lower = this.fragmentTracker.getBufferedFrag((start + end) / 2, "main");
        const lowerLevel = hls.levels[lower?.level];
        if (!lowerLevel?.videoCodec?.startsWith("avc1.") || lowerLevel.maxBitrate >= level.maxBitrate ||
            (level.videoCodec.startsWith("avc1.") && lowerLevel.videoCodec.slice(0, 9) !== level.videoCodec.slice(0, 9)) ||
            lowerLevel.audioCodec !== level.audioCodec || lowerLevel.videoRange !== level.videoRange ||
            this.fragmentTracker.getState(lower) !== "OK") continue;
        // Let an active whole-film download continue. Individual upgrades
        // can still append segments that it has already saved.
        if (preload?.request && !preload.storageError && !cached) continue;
        const alignment = wholeRange || level.videoCodec.startsWith("hvc1.") ? 0.1 : 0.05;
        if (level.details && (!frag?.initSegment || frag.gap || frag.encrypted ||
            lower.cc !== frag.cc || Math.abs(lower.start - frag.start) > alignment || Math.abs(lower.end - frag.end) > alignment ||
            this.fragmentTracker.getState(frag) !== "NOT_LOADED" || this.misalignedUpgrades.has(frag) ||
            new URL(frag.url).origin !== location.origin)) continue;
        candidate = { frag, lower, key, bytes: sizes[i], timeout: budget.timeout, replay, level, cached };
        if (!replay) break; // Prefer the earliest reachable future segment.
      }
      return candidate;
    }

    canAppend4K(level) {
      const codec = [level.videoCodec, level.audioCodec].filter(Boolean).join(",");
      return this.hls.bufferController?.sourceBuffers?.some(([, buffer]) => typeof buffer?.changeType === "function") &&
        Hls.getMediaSource()?.isTypeSupported(`video/mp4; codecs="${codec}"`);
    }

    async prepareUpgradePlaylist(level, levelIndex) {
      if (new URL(level.uri).origin !== location.origin) {
        this.failedUpgradePlaylists.add(level);
        return;
      }
      const request = this.upgradePlaylistRequest = new AbortController();
      const timer = setTimeout(() => request.abort("timeout"), 2000);
      try {
        const loader = preload?.available.has(level.uri) ? preload.loader(() => {}) : undefined;
        const details = await readUpgradePlaylist(Hls, level.uri, request.signal, loader);
        if (request.signal.aborted || !details || details.live) {
          if (!request.signal.aborted || request.signal.reason === "timeout") this.failedUpgradePlaylists.add(level);
          return;
        }
        if (this.hls.levels[levelIndex] !== level) return;
        for (const frag of details.fragments) {
          frag.level = levelIndex;
          if (frag.initSegment) frag.initSegment.level = levelIndex;
        }
        level.details ||= details;
      } catch {
        this.failedUpgradePlaylists.add(level);
      } finally {
        clearTimeout(timer);
        this.upgradePlaylistRequest = null;
      }
    }

    async stageUpgrade(frag, lower, bytes, timeout, replay, full, cached = false) {
      const request = new AbortController();
      const pending = { frag, lower, request, replay, full, data: null };
      this.pendingUpgrade = pending;
      metrics.attempts++;
      metrics.last = { frag, from: renditionProfile(this.hls.levels[lower.level]),
        to: renditionProfile(this.hls.levels[frag.level]), replay, status: "Downloading" };
      const timer = setTimeout(() => this.cancelUpgrade("Timed out"), timeout);
      const start = performance.now();
      try {
        if (!frag.initSegment.data) {
          const response = await this.upgradeResponse(frag.initSegment.url, request.signal, cached);
          const length = Number(response.headers.get("Content-Length"));
          if (!response.ok || length <= 0 || length > 128 * 1024) return;
          pending.init = new Uint8Array(await response.arrayBuffer());
          if (pending.init.byteLength !== length) return;
        }
        const response = await this.upgradeResponse(frag.url, request.signal, cached);
        const first = performance.now();
        if (!response.ok || Number(response.headers.get("Content-Length")) !== bytes) return;
        const data = await response.arrayBuffer();
        if (!request.signal.aborted && data.byteLength === bytes) {
          pending.data = data;
          pending.loading = { start, first, end: performance.now() };
          if (!cached) metrics.bytes += bytes;
          metrics.last.status = "Ready";
        }
      } catch {
        // An optional download can fail without interrupting the buffered copy.
      } finally {
        clearTimeout(timer);
        if (!pending.data && this.pendingUpgrade === pending) this.cancelUpgrade("Failed");
      }
    }

    async upgradeResponse(url, signal, cacheOnly) {
      const release = preload?.pin(url);
      try {
        const cached = await preload?.match(url);
        if (cached) return new Response(await cached.arrayBuffer(), { headers: cached.headers });
      } finally { release?.(); }
      if (cacheOnly) throw new Error("Replay cache entry missing");
      preload?.stop();
      const asset = preload?.asset(url);
      if (asset) return preload.response(asset, await preload.playback(asset, signal));
      return fetch(url, { signal, mode: "same-origin", priority: "low" });
    }
  }

  return { fLoader: UpgradeLoader, streamController: UpgradeStreamController, abrController: UpgradeAbrController };
}

function segmentTransfer(frag, stats) {
  const { start, first, end } = stats.loading;
  const elapsed = end > start ? end - start : null;
  const firstByte = first > start && first <= end ? first - start : null;
  const entry = performance.getEntriesByName(frag.url, "resource").at(-1);
  // Resource Timing can include an older request for the same segment after a seek.
  const protocol = entry?.transferSize > 0 && entry.startTime >= start && entry.startTime <= end ? entry.nextHopProtocol : null;
  return { bytes: stats.loaded, elapsed, firstByte, protocol,
    bitrate: frag.duration > 0 ? stats.loaded * 8 / frag.duration : null };
}

class WatchedQuality {
  constructor() { this.ranges = []; }
  record(start, end, quality) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !quality) return;
    const next = [];
    for (const range of this.ranges) {
      if (range.end <= start || range.start >= end) next.push(range);
      else {
        if (range.start < start) next.push({ ...range, end: start });
        if (range.end > end) next.push({ ...range, start: end });
      }
    }
    next.push({ start, end, quality }); next.sort((a, b) => a.start - b.start);
    this.ranges = [];
    for (const range of next) {
      const previous = this.ranges.at(-1);
      if (previous && previous.quality === range.quality && Math.abs(range.start - previous.end) < 0.001) previous.end = range.end;
      else this.ranges.push(range);
    }
  }
  at(time) { return this.ranges.find(range => time >= range.start && time < range.end)?.quality || null; }
}

function displayQuality(width, height) {
  if (!width || !height) return null;
  if (width >= 3840 || height >= 2160) return "4K";
  if (width >= 1920 || height >= 1080) return "1080p";
  if (width >= 1280 || height >= 720) return "720p";
  return `${height}p`;
}

// A small handoff for a paused-frame upgrade, independent of disk quota.
// Only the selected rendition's opening data at this position is retained.
class UpgradeMemory {
  constructor(limit = 64 * 1024 * 1024) { this.limit = limit; this.bytes = 0; this.entries = new Map(); }
  remember(context, response) {
    if (this.entries.has(context.url)) return;
    const data = response.data;
    const bytes = typeof data === "string" ? new TextEncoder().encode(data).byteLength : data.byteLength;
    if (this.bytes + bytes > this.limit) throw new Error("Paused upgrade memory budget exceeded");
    this.entries.set(context.url, typeof data === "string" ? data : data.slice(0));
    this.bytes += bytes;
  }
  loader(Base, capture = false) {
    const memory = this;
    return class MemoryLoader extends Base {
      load(context, config, callbacks) {
        const data = memory.entries.get(context.url);
        if (data !== undefined) {
          this.context = context; this.memoryRead = true;
          const now = performance.now();
          this.stats.loaded = this.stats.total = typeof data === "string" ? new TextEncoder().encode(data).byteLength : data.byteLength;
          this.stats.fromReplayCache = true;
          Object.assign(this.stats.loading, { start: now, first: now, end: now });
          queueMicrotask(() => {
            if (!this.memoryRead) return;
            this.memoryRead = false;
            callbacks.onSuccess({ url: context.url, data: typeof data === "string" ? data : data.slice(0) }, this.stats, context, null);
          });
          return;
        }
        super.load(context, config, capture ? { ...callbacks, onSuccess: (response, stats, ...rest) => {
          try { memory.remember(context, response); }
          catch (error) { callbacks.onError({ code: 0, text: error.message }, context, null, stats); return; }
          callbacks.onSuccess(response, stats, ...rest);
        } } : callbacks);
      }
      abort() { this.memoryRead = false; super.abort(); }
      destroy() { this.memoryRead = false; super.destroy(); }
    };
  }
}

class StreamPlayer {
  constructor(video, quality, message) {
    this.video = video; this.quality = quality; this.message = message;
    this.hls = null; this.film = null; this.sequence = 0; this.mode = "auto";
    this.native = false;
    this.watchedQuality = new WatchedQuality();
    if (video.requestVideoFrameCallback) {
      const record = (_now, frame) => {
        if (!video.paused && !video.seeking && this.film) {
          this.watchedQuality.record(frame.mediaTime, frame.mediaTime + 1001 / 30000, displayQuality(frame.width, frame.height));
        }
        video.requestVideoFrameCallback(record);
      };
      video.requestVideoFrameCallback(record);
    } else {
      video.addEventListener("timeupdate", () => {
        if (!video.paused && !video.seeking && this.film) {
          const time = video.currentTime;
          const start = this.lastWatchedTime > time - 0.5 && this.lastWatchedTime < time ? this.lastWatchedTime : time;
          this.watchedQuality.record(start, time + 0.03, displayQuality(video.videoWidth, video.videoHeight));
          this.lastWatchedTime = time;
        }
      });
      for (const event of ["pause", "seeking"]) video.addEventListener(event, () => { this.lastWatchedTime = null; });
    }
    quality.addEventListener("change", () => this.choose(quality.value));
    video.addEventListener("resize", () => this.describe());
    video.addEventListener("playing", () => {
      this.clearPausedFrame();
      if (this.diagnostics) this.diagnostics.played = true;
      this.finishStall();
      this.describe();
    });
    video.addEventListener("waiting", () => {
      this.replay?.stop();
      const stats = this.diagnostics;
      if (stats?.played && !video.paused && !video.seeking && stats.stallStart === null) {
        stats.stalls++;
        stats.stallStart = performance.now();
      }
    });
    for (const event of ["pause", "seeking", "ended"]) video.addEventListener(event, () => this.finishStall());
    video.addEventListener("seeking", () => {
      this.replay?.observe(video.currentTime);
      if (!this.pausedFrameTransition) this.clearPausedFrame();
      this.replay?.stop();
    });
    video.addEventListener("play", () => { if (!this.pausedFrameTransition) this.clearPausedFrame(); });
    video.addEventListener("pause", () => this.refreshPausedFrame());
  }
  finishStall() {
    const stats = this.diagnostics;
    if (stats?.stallStart == null) return;
    stats.stallMs += performance.now() - stats.stallStart;
    stats.stallStart = null;
  }
  option(value, label) {
    const item = document.createElement("option"); item.value = value; item.textContent = label; return item;
  }
  options(levels) {
    const variants = levels || this.film?.stream?.variants || [];
    this.quality.replaceChildren(...(this.film?.stream ? [this.option("auto", "Auto")] : []),
      ...variants.slice().sort((a, b) => b.height - a.height).map(item => this.option(`height:${item.height}`,
        `${item.height >= 2160 ? "4K" : item.height + "p"}${item.color === "HLG" || item.videoRange === "HLG" ? " HDR" : ""}`)),
      this.option("original", "Original"));
    this.quality.hidden = false; this.quality.value = this.mode;
    if (!this.quality.value) this.quality.value = this.film?.stream ? "auto" : "original";
    this.video.dispatchEvent(new Event("qualitieschange"));
  }
  open(film, time = 0, play = true) {
    this.close(); this.film = film; this.watchedQuality = new WatchedQuality(); this.lastWatchedTime = null;
    this.start(film.stream ? "auto" : "original", time, play);
  }
  updateFilm(film) {
    if (!this.film || film.id !== this.film.id) return;
    const becameReady = !this.film.stream && film.stream;
    this.film = film;
    if (becameReady) { this.options(); this.describe(); }
  }
  dispose(keepPausedFrame = false) {
    if (!keepPausedFrame) this.clearPausedFrame();
    clearInterval(this.replayTimer);
    clearTimeout(this.sizeRetry);
    this.replay?.stop();
    this.sizeRequest?.abort(); this.sizeRequest = null;
    this.hls?.destroy(); this.hls = null;
    this.video.pause(); this.video.removeAttribute("src"); this.video.load();
    this.diagnostics = null;
  }
  close() {
    this.sequence++; this.dispose(); this.film = null;
    this.replay = null;
    this.quality.replaceChildren(); this.quality.hidden = true;
  }
  start(mode, time, play, cached = false, preferSaved = false) {
    const sequence = ++this.sequence, video = this.video;
    const handoff = preferSaved && this.pausedFrame?.visible ? this.pausedFrame : null;
    const startupUri = handoff?.uri || this.replay?.variant?.url;
    const savedStartLevel = preferSaved ? this.hls?.levels.findIndex(level => level.uri === startupUri) : -1;
    this.cancelPausedUpgrade();
    const rate = video.playbackRate, volume = video.volume, muted = video.muted;
    const keepPausedFrame = (cached || preferSaved) && play && !!this.pausedFrame?.visible;
    this.pausedFrameTransition = keepPausedFrame;
    this.dispose(keepPausedFrame); this.mode = mode; this.native = false;
    this.cachedPlayback = cached;
    this.replaySource = cached;
    const metrics = this.diagnostics = { segments: 0, bytes: 0, last: null, current: null, indexed: false,
      played: false, stalls: 0, stallMs: 0, stallStart: null, upgrades: { attempts: 0, applied: 0, bytes: 0, last: null } };
    const film = this.film;
    this.options();
    video.addEventListener("loadedmetadata", () => {
      if (sequence !== this.sequence) return;
      video.playbackRate = rate; video.volume = volume; video.muted = muted;
      if (time > 0 && Number.isFinite(video.duration) && time < video.duration - 0.25) video.currentTime = time;
      if (play) video.play().catch(error => {
        if (sequence === this.sequence && error.name !== "AbortError") this.message.textContent = "Press play to continue.";
      });
    }, { once: true });
    if (mode === "original") { video.src = film.file; this.describe(); return; }
    // Keep MSE playback attached when changing quality. Native HLS is the
    // fallback for devices without MSE; its source changes preserve position.
    if (!window.Hls?.isSupported()) {
      if (!video.canPlayType("application/vnd.apple.mpegurl")) { this.start("original", time, play); return; }
      this.native = true;
      const variant = film.stream.variants.find(item => `height:${item.height}` === mode);
      video.src = variant ? variant.url : film.stream.url; this.describe(); return;
    }
    if (this.replay?.source !== film.stream.url) this.replay = new ReplayPreload(film.stream.url);
    const replay = this.replay;
    replay.Hls = Hls;
    const cacheMiss = (fatal = false) => {
      // Exit the loader callback before tearing down its HLS instance.
      queueMicrotask(() => {
        if (sequence !== this.sequence) return;
        replay.invalidate();
        if (fatal) {
          replay.disabled = true;
          replay.status = "Cached playback unavailable";
        }
        this.start("auto", video.readyState ? video.currentTime : time, video.readyState ? !video.paused : play);
      });
    };
    let segmentSizes = null;
    // Give the built-in ABR controller a per-segment ceiling. Its codec,
    // display-size and error recovery logic still chooses the actual level.
    class SizeAwareHls extends Hls {
      savedStartupLevel() {
        if (!preferSaved || this.hasEnoughToStart || !(handoff?.memory || replay.frameAvailable(time))) return -1;
        return this.levels.findIndex(level => level.uri === startupUri && !level.loadError);
      }
      get maxAutoLevel() {
        return Math.max(this.savedStartupLevel(), segmentSizeCap(this, super.maxAutoLevel, segmentSizes));
      }
      get nextAutoLevel() {
        const startup = this.savedStartupLevel();
        if (startup >= 0) return startup;
        const position = this.cacheSwitchPosition ?? Math.max(this.media?.currentTime || 0, this.streamController.nextLoadPosition);
        return cachedAutoLevel(this, super.nextAutoLevel, replay, position);
      }
      set nextAutoLevel(value) { super.nextAutoLevel = value; }
      preferCachedBuffer() {
        this.cacheSwitchPosition = this.media.currentTime;
        try { this.streamController.nextLevelSwitch(); }
        finally { this.cacheSwitchPosition = null; }
      }
    }
    const ReplayLoader = replay.loader(cacheMiss, () => this.cachedPlayback);
    const Loader = handoff?.memory ? handoff.memory.loader(ReplayLoader) : ReplayLoader;
    const hls = new SizeAwareHls({ startLevel: savedStartLevel >= 0 ? savedStartLevel : 0, startPosition: cached || preferSaved ? time : -1, abrEwmaDefaultEstimate: 2000000,
      capLevelToPlayerSize: false, maxBufferLength: 1, maxMaxBufferLength: Infinity,
      maxBufferSize: 128 * 1024 * 1024, enableWorker: true,
      loader: Loader,
      ...(!cached && bufferedUpgrades(Hls, () => segmentSizes, metrics.upgrades, replay, Loader)) });
    this.hls = hls;
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      if (sequence !== this.sequence) return;
      this.options(cached ? undefined : hls.levels);
      if (preferSaved && (handoff?.memory || replay.frameAvailable(time))) {
        const target = hls.levels.findIndex(level => level.uri === startupUri);
        if (target >= 0) hls.startLevel = target;
      }
      if (!cached && film.stream.segment_sizes && hls.levels.length) {
        const loadSizes = async (attempt = 0) => {
          this.sizeRequest = new AbortController();
          try {
            const response = await fetch(film.stream.segment_sizes, {
              signal: this.sizeRequest.signal, credentials: "same-origin",
            });
            const index = response.ok ? await response.json() : null;
            if (sequence !== this.sequence) return;
            if (validSegmentSizes(index)) {
              segmentSizes = index;
              metrics.indexed = true;
              replay.configure(Hls, hls.levels, index);
              return;
            }
          } catch { /* Playback can continue while the optional index retries. */ }
          if (sequence !== this.sequence) return;
          if (attempt < 3) {
            replay.status = "Retrying segment sizes";
            this.sizeRetry = setTimeout(() => loadSizes(attempt + 1), 1000 * (attempt + 1));
          } else {
            replay.status = "Segment sizes unavailable";
          }
        };
        loadSizes();
      } else if (!cached) replay.status = "Segment sizes unavailable";
      if (mode !== "auto") {
        const index = hls.levels.findIndex(item => `height:${item.height}` === mode);
        if (index >= 0) hls.currentLevel = index;
        else { this.mode = "auto"; this.quality.value = "auto"; }
      }
      this.describe();
    });
    hls.on(Hls.Events.LEVEL_SWITCHED, () => { if (sequence === this.sequence) this.describe(); });
    hls.on(Hls.Events.FRAG_CHANGED, (_event, { frag }) => { metrics.current = frag; });
    for (const event of [Hls.Events.FRAG_LOADING, Hls.Events.LEVEL_LOADING]) {
      hls.on(event, () => {
        if (metrics.upgrades.last?.status !== "Appending") replay.stop();
      });
    }
    hls.on(Hls.Events.FRAG_LOADED, (_event, { frag }) => {
      if (this.cachedPlayback || frag.type !== "main" || !Number.isInteger(frag.sn) || !Number.isFinite(frag.stats?.loaded)) return;
      if (metrics.upgrades.last?.frag === frag && metrics.upgrades.last.status === "Appending") return;
      metrics.segments++;
      metrics.bytes += frag.stats.loaded;
      metrics.last = segmentTransfer(frag, frag.stats);
    });
    let networkRetries = 0, mediaRetries = 0;
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal || sequence !== this.sequence) return;
      if (this.cachedPlayback) { cacheMiss(true); return; }
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRetries++ < 2) {
        this.message.textContent = "Connection interrupted. Retrying…"; hls.startLoad();
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRetries++ < 1) hls.recoverMediaError();
      else { this.message.textContent = "Playback interrupted. Try another quality or reopen the film."; hls.stopLoad(); }
    });
    if (!cached) this.replayTimer = setInterval(() => this.preloadReplay(), 1000);
    hls.loadSource(cached ? replay.variant.url : film.stream.url); hls.attachMedia(video); this.describe();
  }
  preloadReplay() {
    const { video, hls, replay } = this;
    replay?.observe(video.currentTime);
    this.refreshPausedFrame();
    if (replay?.savingEnabled === false) { replay.stop(); replay.status = "Video saving off"; return; }
    if (this.mode !== "auto" || !hls || video.seeking || this.pausedUpgrade || navigator.connection?.saveData) {
      replay.stop();
      return;
    }
    if (!this.cachedPlayback && this.canPlayReplay() && !video.paused && !video.ended && this.bufferedAhead() > 4 * video.playbackRate) {
      const target = hls.levels.findIndex(level => level.uri === replay.variant.url);
      if (target >= 0) {
        this.cachedPlayback = true;
        // The higher rendition is fully downloaded. The stock smooth switch
        // can replace future buffer data directly from local storage.
        if (target === hls.currentLevel) hls.loadLevel = target;
        else hls.nextLevel = target;
        this.describe();
        return;
      }
    }
    // Replace future buffered video before the whole-film cache completes only
    // when every byte in the discarded forward range is already local. The
    // cache-aware ABR selection returns to normal network ABR at cache gaps.
    const buffer = hls.mainForwardBufferInfo;
    if (!this.cachedPlayback && !video.paused && !video.ended && hls.autoLevelEnabled &&
        video.readyState >= 3 && buffer?.len > 8 * video.playbackRate &&
        replay.variant?.height > video.videoHeight && replay.frameAvailable(video.currentTime) &&
        replay.covers(video.currentTime, buffer.end) &&
        ["IDLE", "ENDED"].includes(hls.inFlightFragments.main?.state) &&
        Date.now() >= (this.nextCachedSwitch || 0)) {
      this.nextCachedSwitch = Date.now() + 8000;
      hls.preferCachedBuffer();
    }
    if (!this.diagnostics.played || this.diagnostics.upgrades.last?.status === "Downloading") return;
    replay.tick(bytes => {
      if (this.hls !== hls || this.mode !== "auto" || video.seeking || navigator.connection?.saveData ||
          !["IDLE", "ENDED"].includes(hls.inFlightFragments.main?.state)) return false;
      if (video.paused || video.ended) return true;
      if (video.readyState < 3) return false;
      const ahead = this.bufferedAhead();
      if (video.currentTime + ahead >= video.duration - 0.05) return true;
      const slack = (ahead - hls.maxBufferLength) / video.playbackRate;
      return slack > 0.4 + bytes * 8 / (hls.bandwidthEstimate * 0.6);
    }, video.currentTime);
  }
  refreshPausedFrame() {
    const { video, replay, hls: main } = this;
    if (!main || this.mode !== "auto" || !video.paused || video.ended || video.seeking ||
        video.readyState < 2 || this.pausedFrameTransition || this.pausedUpgrade ||
        document.hidden || navigator.connection?.saveData) return;
    const shown = this.displayedVideo();
    const candidates = main.levels.filter(level => level.height > shown.videoHeight && !level.loadError &&
      Hls.getMediaSource()?.isTypeSupported(`video/mp4; codecs="${[level.videoCodec, level.audioCodec].filter(Boolean).join(",")}"`))
      .sort((a, b) => a.height - b.height || a.maxBitrate - b.maxBitrate);
    const saved = replay?.savingEnabled !== false && replay?.frameAvailable(video.currentTime) &&
      candidates.find(level => level.uri === replay.variant.url);
    const level = saved || candidates[0];
    if (!level) return;
    const time = video.currentTime;
    const signature = `${this.sequence}/${time}/${level.uri}`;
    if (this.failedPausedFrame?.signature === signature && Date.now() < this.failedPausedFrame.until) return;
    // Playback upgrades take priority over whole-film background saving.
    replay?.stop();
    const frame = document.createElement("video");
    frame.className = "paused-frame"; frame.muted = true; frame.playsInline = true; frame.hidden = true;
    frame.setAttribute("aria-hidden", "true"); video.parentElement.append(frame);
    const memory = new UpgradeMemory();
    const preview = this.pausedUpgrade = { video: frame, time, uri: level.uri, memory, visible: false };
    const metrics = this.diagnostics?.upgrades;
    const last = { frag: { start: time, end: time }, from: displayQuality(shown.videoWidth, shown.videoHeight),
      to: renditionProfile(level), status: "Downloading paused frame" };
    if (metrics) { metrics.attempts++; metrics.last = last; }
    const failed = () => {
      queueMicrotask(() => {
        if (this.pausedUpgrade !== preview) return;
        this.failedPausedFrame = { signature, until: Date.now() + 30000 };
        last.status = "Paused upgrade deferred";
        this.cancelPausedUpgrade();
      });
    };
    const Base = replay ? replay.loader(() => {}, false) : Hls.DefaultConfig.loader;
    const hls = preview.hls = new Hls({ autoStartLoad: true, startPosition: time, startLevel: 0,
      maxBufferLength: 0.5, maxMaxBufferLength: 0.5, maxBufferSize: 1024 * 1024, enableWorker: true,
      loader: memory.loader(Base, true) });
    preview.timer = setTimeout(failed, 15000);
    const reveal = () => {
      if (this.pausedUpgrade !== preview || !video.paused || video.seeking ||
          Math.abs(video.currentTime - time) > 0.01 || frame.seeking || frame.readyState < 2 ||
          Math.abs(frame.currentTime - time) > 0.05) return;
      if (frame.videoWidth <= shown.videoWidth && frame.videoHeight <= shown.videoHeight) { failed(); return; }
      // Keep the old picture until the higher-quality replacement is decoded.
      const previous = this.pausedFrame;
      this.pausedFrame = preview; this.pausedUpgrade = null; preview.visible = true;
      clearTimeout(preview.timer); frame.hidden = false; hls.pauseBuffering();
      previous?.hls?.destroy(); previous?.video.remove();
      if (metrics) metrics.applied++;
      last.status = "Paused frame applied";
      this.describe();
    };
    frame.addEventListener("loadedmetadata", () => { frame.currentTime = time; }, { once: true });
    frame.addEventListener("seeked", reveal); frame.addEventListener("loadeddata", reveal);
    hls.on(Hls.Events.FRAG_BUFFERED, reveal);
    hls.on(Hls.Events.ERROR, (_event, data) => { if (data.fatal) failed(); });
    hls.loadSource(level.uri); hls.attachMedia(frame);
  }
  cancelPausedUpgrade() {
    const pending = this.pausedUpgrade;
    if (!pending) return;
    this.pausedUpgrade = null; clearTimeout(pending.timer);
    pending.hls?.destroy(); pending.video.remove();
  }
  clearPausedFrame() {
    this.cancelPausedUpgrade();
    this.pausedFrameTransition = false;
    const preview = this.pausedFrame;
    if (!preview) return;
    this.pausedFrame = null;
    clearTimeout(preview.timer);
    preview.hls?.destroy();
    preview.video.remove();
    if (preview.visible) this.describe();
  }
  displayedVideo() {
    return this.pausedFrame?.visible ? this.pausedFrame.video : this.video;
  }
  canPlayReplay() {
    // Only a player opened on the cached rendition guarantees that the entire
    // buffer, including the opening and past segments, has that quality.
    return this.mode === "auto" && !this.replaySource && this.replay?.savingEnabled !== false && this.replay?.ready &&
      this.replay.source === this.film?.stream?.url;
  }
  play() {
    if (this.canPlayReplay()) {
      this.start("auto", this.video.ended ? 0 : this.video.currentTime, true, true);
      return Promise.resolve();
    }
    if (this.mode === "auto" && this.pausedFrame?.visible && (this.pausedFrame.memory || this.replay?.frameAvailable(this.video.currentTime))) {
      this.start("auto", this.video.currentTime, true, false, true);
      return Promise.resolve();
    }
    return this.video.play();
  }

  stopVideoSaving() {
    this.replay?.stop();
    // The decoded picture and its small memory handoff are playback state,
    // not disk storage. Turning saving off must not lower their quality.
    if (this.cachedPlayback && this.film) this.start("auto", this.video.currentTime, !this.video.paused);
  }
  seek(time) {
    this.replay?.observe?.(time, true);
    if (this.canPlayReplay() && time < this.video.currentTime - 0.5) {
      this.start("auto", time, !this.video.paused, true);
    } else {
      this.video.currentTime = time;
    }
  }
  choose(value) {
    if (!this.film || !value) return;
    if (value === "original" || this.mode === "original" || this.native || this.cachedPlayback) {
      if (this.cachedPlayback && value === "auto") return;
      this.start(value, this.video.currentTime, !this.video.paused); return;
    }
    this.mode = value;
    if (this.hls) this.hls.currentLevel = value === "auto" ? -1 : this.hls.levels.findIndex(item => `height:${item.height}` === value);
    this.describe();
  }
  bufferedAhead() {
    const video = this.video;
    // Match HLS's tolerance for tiny timestamp gaps between adjacent segments.
    // Larger gaps must still stop the reported playable buffer.
    const gap = this.hls?.config.maxBufferHole ?? 0.1;
    let end = video.currentTime;
    for (let i = 0; i < video.buffered.length; i++) {
      const start = video.buffered.start(i), next = video.buffered.end(i);
      if (next < video.currentTime) continue;
      if (start > end + gap) break;
      end = Math.max(end, next);
    }
    return end - video.currentTime;
  }
  qualityAt(time) {
    const hls = this.hls, replay = this.replay;
    const fragment = hls?.streamController?.getBufferedFrag(time);
    const level = fragment && hls.levels[fragment.level];
    const buffered = level ? (renditionProfile(level) === "2160p" ? "4K" : renditionProfile(level)) : null;
    const cached = replay?.savingEnabled !== false && replay?.frameAvailable(time) ?
      replay.variant.profile === "2160p" ? "4K" : replay.variant.profile : null;
    const downloading = new Set();
    const current = hls?.streamController?.fragCurrent;
    if (hls?.inFlightFragments.main?.state === "FRAG_LOADING" && current && time >= current.start && time < current.end) {
      const profile = renditionProfile(hls.levels[current.level]);
      if (profile) downloading.add(profile === "2160p" ? "4K" : profile);
    }
    const pending = hls?.streamController?.pendingUpgrade;
    if (pending && !pending.data && time >= pending.frag.start && time < pending.frag.end) {
      const profile = renditionProfile(hls.levels[pending.frag.level]);
      if (profile) downloading.add(profile === "2160p" ? "4K" : profile);
    }
    if (this.pausedUpgrade && Math.abs(time - this.pausedUpgrade.time) < 0.15) {
      const profile = renditionProfile({ uri: this.pausedUpgrade.uri });
      if (profile) downloading.add(profile === "2160p" ? "4K" : profile);
    }
    const savedFragment = replay?.details?.fragments.find(frag => time >= frag.start && time < frag.end);
    if (savedFragment && replay.transfers.has(savedFragment.url)) downloading.add(replay.variant.profile === "2160p" ? "4K" : replay.variant.profile);
    const nativeBuffered = !hls && Array.from({ length: this.video.buffered.length }, (_, i) =>
      time >= this.video.buffered.start(i) && time < this.video.buffered.end(i)).some(Boolean);
    return { buffered: buffered || (nativeBuffered ? displayQuality(this.video.videoWidth, this.video.videoHeight) : null),
      cached, downloading: [...downloading], watched: this.watchedQuality.at(time) };
  }
  stats() {
    const { video, hls, diagnostics: metrics } = this;
    const display = this.displayedVideo();
    const level = this.pausedFrame?.visible ? this.pausedFrame.hls.levels[0] : hls?.levels[hls.currentLevel];
    const downloadLevel = hls?.levels[hls.loadLevel];
    const frames = video.getVideoPlaybackQuality?.();
    return { width: display.videoWidth, height: display.videoHeight, buffered: this.bufferedAhead(),
      bufferTarget: hls?.maxBufferLength, bufferBytes: hls?.config.maxBufferSize,
      throughput: metrics?.segments && hls ? hls.bandwidthEstimate : null,
      downloadQuality: renditionProfile(downloadLevel),
      bitrate: level?.averageBitrate || level?.bitrate || null,
      codec: level?.videoCodec || (this.mode === "original" ? this.film?.codec : null),
      hls: !!hls, metrics,
      replay: this.replay,
      stallMs: metrics ? metrics.stallMs + (metrics.stallStart === null ? 0 : performance.now() - metrics.stallStart) : 0,
      dropped: frames?.droppedVideoFrames ?? null, total: frames?.totalVideoFrames ?? null,
      transport: hls ? this.pausedFrame?.visible ? "HLS.js / upgraded paused frame" :
        this.cachedPlayback ? "HLS.js / local cache" : "HLS.js" : this.native ? "Native HLS" : "Original file",
      mode: this.mode };
  }
  describe() {
    if (!this.film) return;
    const height = this.displayedVideo().videoHeight;
    const automatic = this.quality.querySelector('option[value="auto"]');
    if (automatic) automatic.textContent = this.mode === "auto" && height ? `Auto (${height >= 2160 ? "4K" : height + "p"})` : "Auto";
    this.quality.value = this.mode;
    this.message.textContent = !this.film.stream ? "Other qualities are being prepared. The original is available now." :
      this.mode === "original" ? "Playing the original file." : this.mode === "auto" ? "Quality adjusts automatically." : "Quality updated.";
    this.video.dispatchEvent(new Event("streamstatechange"));
  }
}
window.StreamPlayer = StreamPlayer;
