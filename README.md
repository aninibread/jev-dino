# Dino — Race Jev

Race the Chrome offline dinosaur against [Jev](https://developers.cloudflare.com/ai/models/typesafe/jev/) on Cloudflare Workers AI. Shared obstacles, aggressive 60-second speed ramp.

## Run locally

```bash
npm install
npm run dev
```

Requires a Cloudflare account with Workers AI access for live Jev decisions. If AI is unavailable, the Worker falls back to a local heuristic so the race still runs.

## Deploy

```bash
npm run deploy
```

## Credits

Dinosaur sprites adapted from Chromium’s offline T-Rex runner via [wayou/t-rex-runner](https://github.com/wayou/t-rex-runner) (BSD-3-Clause).

See [docs/PLAN.md](./docs/PLAN.md) for the full product plan.
