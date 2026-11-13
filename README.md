# Fragella streaming player

A browser player built on [hls.js](https://github.com/video-dev/hls.js), with
playback-first quality upgrades and a rolling replay cache.

- Improve buffered video when a higher-quality replacement can finish safely.
- Sharpen the same paused frame progressively and preserve it on resume.
- Share segment downloads between playback, upgrades, and caching.
- Keep useful high-quality segments around the playback position when storage fills.

[Read the design article](https://research.cytizennetworks.com/fragella-streaming).

## Use the player

Install the pinned dependency with `npm install`, then serve these scripts from
HTTPS or localhost in this order:

```html
<script src="/node_modules/hls.js/dist/hls.light.min.js"></script>
<script src="/public/storage.js"></script>
<script src="/public/replay.js"></script>
<script src="/public/player.js"></script>
```

Construct `new StreamPlayer(videoElement, qualitySelect, statusElement)` and call
`open(film)`. The film object supplies `id`, `file` (original URL), and
`stream: {url, variants, segment_sizes}`: an HLS master playlist, variants with
`height` and `url`, and the segment-size index. Serve media from the same origin
for cache reuse. Position the temporary `.paused-frame` video over the main video
with `pointer-events: none`.

`public/player.js` schedules playback and upgrades; `public/replay.js` manages
shared transfers and cached segments; `public/storage.js` provides cache controls.
The integration uses hls.js 1.7.4 internals, so dependency changes need review.
Native HLS remains a playback fallback. Optional upgrades depend on media
alignment, browser APIs, and device decoding support.

## Upstream

The [vendor](vendor) submodule opens **[video-dev/hls.js](https://github.com/video-dev/hls.js)**
at the v1.7.4 source revision. Clone with `--recurse-submodules` to inspect that
source locally; `npm install` supplies the browser distribution used above.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
