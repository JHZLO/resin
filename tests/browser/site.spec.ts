import { expect, test, type Page } from "@playwright/test";

const videoSelector = "#demo video";
const light = "assets/resin-demo.mp4?v=20261006";
const dark = "assets/resin-demo-dark.mp4?v=20261006";

async function openLight(page: Page) {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/#demo");
  await expect(page.locator(videoSelector)).toHaveAttribute("data-demo-theme", "light");
  await page.locator("#theme").click();
  await expect(page.locator("#theme")).toHaveAttribute("data-mode", "light");
}

async function preparePlayback(page: Page, time = 12.4) {
  const supported = await page.locator(videoSelector).evaluate((video: HTMLVideoElement) => video.canPlayType('video/mp4; codecs="avc1.64002a"'));
  test.skip(!supported, "This browser has no H.264 decoder");
  await page.locator(videoSelector).evaluate(async (video: HTMLVideoElement) => {
    video.muted = true;
    await video.play();
    video.pause();
  });
  await page.locator(videoSelector).evaluate((video: HTMLVideoElement, time) => {
    video.currentTime = time;
    video.volume = 0.4;
    video.playbackRate = 1.25;
  }, time);
  await expect.poll(() => page.locator(videoSelector).evaluate((video: HTMLVideoElement) => video.seeking)).toBe(false);
  await expect.poll(() => page.locator(videoSelector).evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(time, 1);
}

async function expectLoaded(page: Page, filename: string) {
  await expect.poll(() => page.locator(videoSelector).evaluate((video: HTMLVideoElement) => ({
    source: new URL(video.currentSrc || location.href).pathname.split("/").at(-1),
    ready: video.readyState >= 2 && !video.seeking,
  }))).toEqual({ source: filename, ready: true });
}

test.beforeEach(async ({ page }) => {
  await page.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\//, route => route.abort());
});

test("matches automatic and saved themes without loading either video before play", async ({ page }) => {
  const videos: string[] = [];
  const errors: string[] = [];
  page.on("request", request => { if (/resin-demo.*\.mp4/.test(request.url())) videos.push(request.url()); });
  page.on("pageerror", error => errors.push(error.message));
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/#demo");
  await expect(page.locator(`${videoSelector} source`)).toHaveAttribute("src", dark);
  await expect(page.locator(videoSelector)).toHaveAttribute("poster", /resin-demo-dark-poster/);
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator(`${videoSelector} source`)).toHaveAttribute("src", light);
  await page.locator("#theme").click();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator(`${videoSelector} source`)).toHaveAttribute("src", light);
  await page.locator("#theme").click();
  await page.emulateMedia({ colorScheme: "light" });
  await page.reload();
  await expect(page.locator(videoSelector)).toHaveAttribute("data-demo-theme", "dark");
  await expect(page.locator(`${videoSelector} a`)).toHaveAttribute("href", dark);
  expect(videos).toEqual([]);
  await page.goto("/docs/");
  await page.locator("#theme").click();
  expect(errors).toEqual([]);
});

test("keeps a paused position through rapid theme changes while a video is loading", async ({ page }) => {
  await openLight(page);
  await preparePlayback(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(/resin-demo-dark\.mp4/, async route => { await gate; await route.continue(); });
  try {
    for (let i = 0; i < 4; i++) await page.locator("#theme").click();
    await expect(page.locator(`${videoSelector} source`)).toHaveAttribute("src", dark);
  } finally {
    release();
  }
  await expectLoaded(page, "resin-demo-dark.mp4");
  const state = await page.locator(videoSelector).evaluate((video: HTMLVideoElement) => ({
    time: video.currentTime, paused: video.paused, rate: video.playbackRate, muted: video.muted, volume: video.volume,
  }));
  expect(state.time).toBeCloseTo(12.4, 1);
  expect(state).toMatchObject({ paused: true, rate: 1.25, muted: true });
  expect(state.volume).toBeCloseTo(0.4);
});

test("continues playback at the same point when changing the theme", async ({ page }) => {
  await openLight(page);
  await preparePlayback(page, 20);
  await page.locator(videoSelector).evaluate((video: HTMLVideoElement) => video.play());
  await page.locator("#theme").click();
  await expectLoaded(page, "resin-demo-dark.mp4");
  await expect.poll(() => page.locator(videoSelector).evaluate((video: HTMLVideoElement) => video.paused)).toBe(false);
  const time = await page.locator(videoSelector).evaluate((video: HTMLVideoElement) => video.currentTime);
  expect(time).toBeGreaterThanOrEqual(20);
  expect(time).toBeLessThan(24);
  await page.locator(videoSelector).evaluate((video: HTMLVideoElement) => video.pause());
  await page.locator("#theme").click();
  await expectLoaded(page, "resin-demo.mp4");
  await expect.poll(() => page.locator(videoSelector).evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
});

test("does not restart a finished video when the theme changes", async ({ page }) => {
  await openLight(page);
  await preparePlayback(page, 31.95);
  await page.locator(videoSelector).evaluate((video: HTMLVideoElement) => video.play());
  await expect.poll(() => page.locator(videoSelector).evaluate((video: HTMLVideoElement) => video.ended)).toBe(true);
  await page.locator("#theme").click();
  await expectLoaded(page, "resin-demo-dark.mp4");
  const state = await page.locator(videoSelector).evaluate((video: HTMLVideoElement) => ({ time: video.currentTime, paused: video.paused }));
  expect(state.time).toBeCloseTo(32, 1);
  expect(state.paused).toBe(true);
});
