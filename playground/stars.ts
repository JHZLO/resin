// The star count on the GitHub buttons of the playground and the site. A click opens the repository,
// where the star itself is given: starring from here would need the visitor to sign in to GitHub.
// Without a token GitHub answers 60 requests an hour per address, so a count is kept for an hour. It
// stays hidden while it is 0 or when GitHub does not answer.

const API = "https://api.github.com/repos/JHZLO/resin";
const STORE = "resin.stars";
const HOUR = 60 * 60 * 1000;

async function starCount(): Promise<number | null> {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? "null") as { n: number; at: number } | null;
    if (saved && typeof saved.n === "number" && Date.now() - saved.at < HOUR) return saved.n;
  } catch {
    /* no storage: ask GitHub */
  }
  try {
    const res = await fetch(API, { headers: { accept: "application/vnd.github+json" } });
    if (!res.ok) return null;
    const n = ((await res.json()) as { stargazers_count?: unknown }).stargazers_count;
    if (typeof n !== "number") return null;
    try {
      localStorage.setItem(STORE, JSON.stringify({ n, at: Date.now() }));
    } catch {
      /* the next page asks again */
    }
    return n;
  } catch {
    return null;
  }
}

/** 1.2k from 1234, as GitHub writes it */
const short = (n: number): string => (n < 1000 ? String(n) : `${(n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, "")}k`);

/** Fill every `[data-stars]` with the count, and name it in the button's label */
export async function showStars(): Promise<void> {
  const slots = [...document.querySelectorAll<HTMLElement>("[data-stars]")];
  if (!slots.length) return;
  const n = await starCount();
  if (!n) return;
  for (const slot of slots) {
    slot.textContent = short(n);
    slot.hidden = false;
    const link = slot.closest("a");
    if (link) link.setAttribute("aria-label", `Star resin on GitHub, ${n} ${n === 1 ? "star" : "stars"}`);
  }
}
