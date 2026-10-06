interface Playback {
  time: number;
  playing: boolean;
  rate: number;
}

/** Both recordings share a timeline, so a theme change can keep the viewer's place. */
export function demoTheme(video: HTMLVideoElement | null): (dark: boolean) => void {
  const source = video?.querySelector("source");
  if (!video || !source) return () => {};
  const link = video.querySelector("a");
  let pending: Playback | null = null;
  let loadPauses = 0;
  let restore: AbortController | null = null;

  video.addEventListener("play", () => {
    if (pending) pending.playing = true;
  });
  video.addEventListener("pause", () => {
    // Replacing a playing resource queues a pause event.
    if (loadPauses > 0) loadPauses--;
    else if (pending) pending.playing = false;
  });

  return (dark) => {
    const mode = dark ? "dark" : "light";
    const src = video.dataset[`${mode}Src`];
    const poster = video.dataset[`${mode}Poster`];
    if (!src || !poster) return;
    video.dataset.demoTheme = mode;
    video.poster = poster;
    if (link) link.href = src;
    if (source.getAttribute("src") === src) return;

    restore?.abort();
    // Retain the last position through repeated switches before metadata arrives.
    pending ??= video.currentTime > 0 || !video.paused || video.ended
      ? { time: video.currentTime, playing: !video.paused && !video.ended, rate: video.playbackRate }
      : null;
    if (pending) {
      video.preload = "metadata";
      restore = new AbortController();
      video.addEventListener("loadedmetadata", () => {
        const playback = pending;
        pending = null;
        if (!playback) return;
        video.playbackRate = playback.rate;
        video.currentTime = Math.min(playback.time, Number.isFinite(video.duration) ? video.duration : playback.time);
      }, { once: true, signal: restore.signal });
    }
    if (!video.paused) loadPauses++;
    source.src = src;
    // Keep preload as a hint until playback starts. Some browsers fetch metadata anyway.
    video.src = src;
    if (pending) {
      video.load();
      // Start within the theme button's user gesture, before asynchronous metadata.
      if (pending.playing) void video.play().catch(() => { /* Native controls remain available if playback is blocked. */ });
    }
  };
}
