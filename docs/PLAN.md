# Plan: Race Chrome Dino vs Jev

## Goal

Ship a Chrome offline dinosaur–style endless runner on Cloudflare Workers where a human races an AI opponent controlled by **Jev** (`typesafe/jev` via Workers AI). Games last at most **60 seconds**, accelerate aggressively, and become nearly unwinnable for humans by the end so Jev (or death) usually wins.

---

## What Jev is (and is not)

From [LangChain’s harness post](https://www.langchain.com/blog/building-a-harness-with-jev) and [Cloudflare Workers AI docs](https://developers.cloudflare.com/ai/models/typesafe/jev/):

- Jev is TypeSafe AI’s **System One** model: it does **not** generate text.
- You send a **state** (context) plus typed **questions**; it returns calibrated structured answers with probabilities.
- Question types:
  - **noul** — yes/no probability (`0–1`)
  - **choice** — pick one option + probabilities + confidence
  - **score** — ordered scale + continuous score
- Multiple questions evaluate **in parallel** in one request (cheap to fan out).
- Typical latency ~**70–500ms** (orders of magnitude faster than chat LLMs, but still far slower than a 16ms game frame).

**Implication for the race:** Jev cannot drive every physics tick. It must be a **periodic decision agent**: the client (or Worker) sends a compact game state, Jev answers “jump / duck / hold”, and the game applies that action until the next decision.

---

## Inspiration: open-source dino clones

Prefer look-and-feel fidelity to Chromium’s offline game (monochrome T-Rex, cactus/pterodactyl, parallax ground, duck, day/night).

| Repo | Why it matters |
|------|----------------|
| [wayou/t-rex-runner](https://github.com/wayou/t-rex-runner) | Extracted Chromium T-Rex runner; closest classic look; BSD-3-Clause; canvas + sprites |
| [Chromium `offline.js`](https://chromium.googlesource.com/chromium/src.git/+/master/components/neterror/resources/offline.js) | Canonical source (`Runner`, `Trex`, `Horizon`, obstacles) |
| [yei08/t-rex-runner-game](https://github.com/yei08/t-rex-runner-game) | Newer ES6 extraction; easier to import into modern apps |
| [chrisdothtml/chrome-dino](https://github.com/chrisdothtml/chrome-dino) | Clean MIT dependency-free remake; good for learning collision/hit boxes |
| [KarthikNedunchezhiyan/google-chrome-dino](https://github.com/KarthikNedunchezhiyan/google-chrome-dino) | Faithful monochrome recreation; solid feature checklist |

**Approach:** Port/adapt Chromium-style mechanics and sprites (attribute Chromium / BSD where required). Do **not** invent a generic platformer that only vaguely resembles dino. Dual runners share the same obstacle stream so the race is fair.

---

## UI vibes (from [jev-3s](https://github.com/aninibread/jev-3s), not a clone)

Reference the recent **3s** demo for shell polish only — same family of Jev demos, different product. Do **not** copy its food/gallery layout, mode tabs, verdict cards, or emoji floats.

Steal the feel:

- **Sparse chrome.** Brand left, one quiet nav action (e.g. Rules), credits/attribution in a thin footer. No dashboard clutter.
- **One centered composition.** Content sits in a calm column with generous whitespace; the thing that matters (here: the race canvas) is the hero, not a card grid of secondary widgets.
- **Quiet hierarchy.** Big tight headline + one short supporting line. Muted secondary text. Near-black primary actions; ghost/outline secondaries.
- **Soft paper/ink restraint.** Light warm-neutral field, hairline borders, very light shadows — calm enough that Chromium’s monochrome dino still reads as the visual star.
- **Honest status, not spectacle.** Thinking/deciding states are a small spinner + muted copy (“Jev is deciding…”), not loading theater.
- **Rules & credits as dialogs.** Keep the main surface empty until play starts.
- **Short playful copy.** Argue lightly (“Race Jev. Don’t blink.”) without over-explaining.
- **Motion with restraint.** A couple of short functional transitions; respect `prefers-reduced-motion`.

What this means for dino specifically:

| Surface | Direction |
|---------|-----------|
| Start | Brand + one headline + one line + **Race Jev** CTA; canvas idle/waiting under it |
| In race | Full-bleed-feeling canvas; tiny HUD (timer, YOU/JEV status) — no stat strips or promo chips |
| End | Simple winner line + scores + **Race again**; optional collapsed “Jev’s last calls” disclosure, not a probability dashboard by default |
| Debug | Probability bars / latency behind a toggle — 3s-style thin ink bars if shown |

The **game itself** stays Chrome-dino faithful (sprites, gray desert, hitboxes). The **page shell** should feel like the same minimal Jev-demo family as 3s, not a marketing landing page and not a carbon copy of 3s.

---

## Product shape

### Race fantasy

- Two dinos on the **same horizontal track / shared obstacle timeline**:
  - **You** — keyboard (Space / ↑ jump, ↓ duck) + touch
  - **Jev** — actions from `typesafe/jev`
- Shared scroll speed and obstacle schedule (deterministic seed optional for replays).
- First to crash loses that “life”; race ends when either dino dies **or** the 60s timer hits.
- Win conditions (priority order to implement):
  1. Opponent crashes first → you win
  2. You crash first → Jev wins
  3. Both survive to 60s → higher distance/score wins (tie-break: who last jumped successfully / shared score)
- UI shell follows the vibes section above; in-canvas labels stay minimal (“YOU” / “JEV”), with live timer and optional debug for Jev’s last decision.

### Difficulty / speed curve (critical)

Target: **very fast by the end; humans should usually lose**.

Suggested curve (tune in playtesting):

| Time | Approx speed multiplier |
|------|-------------------------|
| 0s | 1.0× (Chrome-like start) |
| 10s | ~1.8× |
| 20s | ~2.6× |
| 30s | ~3.5× |
| 45s | ~5.0× |
| 55–60s | ~6–8× (near-impossible reaction window) |

- Cap game length at **60s** hard stop.
- Increase obstacle density and reduce gaps as speed rises.
- Keep early seconds playable so the race feels real, not instantly unfair.

---

## Architecture (fits this repo)

Existing stack: **React Router Framework mode** + **Vite** + **Cloudflare Workers** (`workers/app.ts`, `wrangler.jsonc`). Package name is already `dino`.

```
Browser (canvas game loop)
  ├─ Player input → local physics
  ├─ Shared world tick (obstacles, speed, timer)
  └─ Jev decision loop (~4–10 Hz, not 60 Hz)
        └─ POST /api/jev-decide  →  Worker  →  env.AI.run("typesafe/jev", …)
```

### Why a Worker API for Jev

- Workers AI binding (`AI`) stays server-side; no client API tokens.
- One place to shape prompts, rate-limit, and log.
- React Router `action` or a dedicated resource route is fine; prefer a small JSON endpoint for low overhead from `fetch` in `requestAnimationFrame`-adjacent timers.

### wrangler

Add AI binding, e.g.:

```jsonc
"ai": {
  "binding": "AI"
}
```

Update `Env` via `wrangler types`.

---

## Jev decision design

### State sent each call (keep tiny)

Compact JSON only — tokens cost money and add latency:

```ts
{
  t: number,              // seconds elapsed
  speed: number,          // current run speed
  dino: { y: number, vy: number, ducking: boolean, grounded: boolean },
  upcoming: Array<{       // next 1–3 obstacles only
    type: "cactus-small" | "cactus-large" | "bird",
    dx: number,           // distance ahead in world units
    width: number,
    height: number,
    y: number             // for birds
  }>
}
```

### Questions (single fan-out)

Prefer one **choice** for mutually exclusive actions:

```ts
action: {
  type: "choice",
  instructions: "What should the dinosaur do right now to avoid the next obstacle?",
  criteria: {
    run: "Stay running; no jump or duck needed yet",
    jump: "Jump to clear a cactus or low hazard",
    duck: "Duck to avoid a high bird"
  }
}
```

Optional secondary **noul**s for confidence gating (same request):

- `obstacle_imminent` — should act within ~200ms?
- `safe_to_hold` — is holding run still safe?

**Client policy:**

1. Call Jev on an interval (e.g. every 120–250ms) **and** when the nearest obstacle crosses a “decision horizon”.
2. While waiting for a response, hold the last committed action (or `run`).
3. If latency spikes, fall back to a tiny local heuristic so Jev’s dino doesn’t freeze mid-race (label as “Jev offline / heuristic” if used).
4. Never block the player’s frame loop on network I/O.

### Expected call volume

- ~4–8 decisions/sec × ≤60s ≈ **240–480** inferences max per race.
- Batch questions in one call; keep state short.
- Consider caching last answer for identical obstacle geometry within a few frames.

---

## Game implementation plan

### Phase 0 — Plan (this doc) ✅

Commit and review before coding.

### Phase 1 — Single-player Chromium-faithful core

- Canvas runner: ground, clouds, cacti, birds, jump, duck, collision, score/distance, day/night optional.
- Sprite sheet from Chromium resources (respect license / attribution in README).
- Tune aggressive speed ramp + 60s hard end.
- Reference: `wayou/t-rex-runner` / Chromium `offline.js` structure (`Runner`, `Trex`, `Horizon`, `Obstacle`).

### Phase 2 — Dual-dino race scaffolding

- Two Trex instances; one shared Horizon/obstacle generator.
- Independent collision per dino; visually distinguish (tint, label, or slight vertical lane offset without breaking hitboxes unfairly).
- HUD: timer, both scores/status, winner banner.

### Phase 3 — Jev opponent wiring

- `POST /api/jev-decide` resource route → `env.AI.run("typesafe/jev", { state, questions })`.
- Map `choice` → jump/duck/run input for Jev’s Trex.
- Latency-tolerant input queue; show last Jev action + optional probabilities in a debug toggle.
- Graceful error / timeout path.

### Phase 4 — Polish & deploy

- Mobile touch controls for the human.
- Minimal shell à la 3s vibes: sparse header/footer, start CTA, rules dialog, quiet end state.
- README: how to run, AI binding, attribution for dino assets.
- `npm run deploy` via Wrangler; verify Workers AI access in the target account.

---

## File / module sketch (proposed)

```
app/
  routes/
    home.tsx              # game shell / landing
    api.jev-decide.ts     # Workers AI proxy
  game/
    Runner.ts             # shared world + tick
    Trex.ts
    Horizon.ts
    Obstacle.ts
    sprites.ts
    speedCurve.ts         # aggressive 0–60s ramp
    jevController.ts      # client decision loop + fetch
    RaceGame.tsx          # React ↔ canvas bridge
workers/
  app.ts                  # existing RR request handler
wrangler.jsonc            # add AI binding
docs/
  PLAN.md                 # this document
```

Exact filenames may shift once we inspect the chosen clone’s structure; keep physics outside React where possible.

---

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Jev latency too high for late-game speeds | Decision horizon earlier; speculative jump; local heuristic fallback |
| Jev too weak / too strong | Threshold on probabilities; inject slight reaction delay; tune criteria text |
| Dual collision unfairness | Shared obstacle stream + identical hitboxes |
| License / sprites | Use Chromium-extracted assets with proper attribution; prefer BSD-compatible sources |
| Workers AI availability | Feature-flag heuristic-only opponent for local UI work without AI |
| Cost / abuse | Rate-limit decide endpoint per IP; cap race length; reject oversized state payloads |

---

## Success criteria

1. Looks and feels like Chrome dino (sprites, jump/duck, cactus/birds, escalating scroll).
2. Human and Jev race the **same** obstacle sequence.
3. Speed ramps hard; games end by **60s**; late game is extremely difficult for humans.
4. Jev actions come from Workers AI `typesafe/jev` (not a fake script pretending to be AI), with a documented fallback.
5. Page shell feels like the same minimal Jev-demo family as [jev-3s](https://github.com/aninibread/jev-3s) (sparse chrome, quiet copy) without cloning that UI.
6. Deployable with `wrangler` from this React Router + Workers template.

---

## Out of scope (v1)

- Multiplayer human-vs-human
- Accounts / leaderboards (can add later with D1/KV)
- LLM-generated commentary (Jev cannot generate text; use static/copy or a separate model later)
- Pixel-perfect Chromium arcade mode parity beyond core feel
- Copying jev-3s layouts (gallery, mode tabs, verdict cards, floating emojis)

---

## Implementation order (next session)

1. Add AI binding + stub `/api/jev-decide`.
2. Build single-player core from Chromium-style clone.
3. Wire speed curve + 60s cap.
4. Duplicate dino + shared obstacles.
5. Connect Jev controller and tune until the race is fun and Jev visibly “plays.”
6. Apply minimal shell polish (3s vibes), then deploy and smoke-test.

Do not start Phase 1 until this plan is reviewed/accepted (or explicitly greenlit to proceed).

---

## References

- Prior UI vibe reference (minimal Jev demo, do not clone): https://github.com/aninibread/jev-3s
- LangChain on building with Jev: https://www.langchain.com/blog/building-a-harness-with-jev
- Jev on Workers AI: https://developers.cloudflare.com/ai/models/typesafe/jev/
- Chromium T-Rex extraction: https://github.com/wayou/t-rex-runner
