# Calm — a design direction for Cascade

Claude's quiet structure — paper, ink and space — with Cascade's own identity.
The prototype (`calm-direction-prototype.html`, open it in a browser) shows the
web app, landing page, docs and the token sheet. This note records the rules
the web app now follows.

## Principles

- **Quiet by default.** Flat paper (light) or midnight (dark, the CLI's default
  theme name). No glows, blur or gradient fills on ordinary controls.
- **Colour means tier.** The brand ramp from `cloud/web/src/lib/brand.ts` —
  azure `#4C8DFF` → sky `#38B0DE` → teal `#2DD4BF` — is the only accent family.
  It marks T1 / T2 / T3, and live work.
- **Money is a number.** Tiers, models, costs and savings are set in mono, as a
  receipt.

## What changed in `cloud/web`

| Area | Change |
|---|---|
| Tokens | `index.css`: paper / midnight neutral ramps, azure accent, tier inks, teal "saved". Same token names, so every component restyles at once. |
| Type | Self-hosted via `@fontsource-variable` (no third-party requests): Geist (interface), Source Serif 4 (answers, headings), Geist Mono (receipts, code). |
| Surfaces | `.glass` / `.glass-strong` are now solid cards with a hairline edge; the app shell is a flush sidebar and a flat main area. |
| Replies | Answers are set in the serif. The header row is gone; a **receipt line** under each reply (`T1 · model · $cost · saved $x`) is the /why toggle, and /why now draws Cascade vs. all-T1 on one scale. |
| Live runs | A thin **spine** of the brand ramp flows beside the status and the agent tree — the one bold element. The tree is compact rows with tier dots. |
| Colour fixes | Tier badges and the tier mix used hard-coded green / amber / violet; they now use the `t1/t2/t3` tokens. |
| Landing, /docs | Serif headlines, the three-arc mark everywhere (it replaces the old three-bar mark), solid azure primary buttons. /docs follows the OS theme. |
| Shell | The prototype's structure: a 260px sidebar (New chat, Search, Files, Skills, Recents) with an account menu that holds the usage gauges and every account action; a title menu (Rename, Files, Continue on another device, Delete); the chat's total saving at the top right, from its replies' stored /why reports, opening what the whole chat spent against all-T1. |
| Composer | Text on top, controls below: `+` (attach, skill), tools (Web search, Browser, connectors), and the routing menu (Auto / Quality / Fast, tier, Fast answer for the next message). Whatever is switched on shows as a chip with its own ×. |
| Run detail | Replaces Simple / Advanced view. On, a live run shows its plan line and agent tree; a finished orchestrated reply folds its tree above the answer ("1 manager · 3 workers"). |

Nothing the app could do before is gone: each control that moved has a new
home in a menu, and the routing controls — which Simple view used to hide —
are now always a menu away.

## Tokens (for other surfaces)

```css
:root {                         /* light: paper */
  --paper: #F7F6F2; --side: #EFEDE7; --card: #FFFFFF; --sunk: #EAE8E1;
  --ink: #15171C; --ink-2: #555A63; --ink-3: #868B94;
  --accent: #2F6FE4; --t1: #2F6FE4; --t2: #1C8FBE; --t3: #0E9B89; --save: #0E8A7A;
}
[data-theme="dark"] {           /* midnight */
  --paper: #0E1117; --side: #0A0D12; --card: #161A22; --sunk: #1B2029;
  --ink: #E9EBF0; --ink-2: #A2A8B4; --ink-3: #6E7583;
  --accent: #6FA3FF; --t1: #6FA3FF; --t2: #4CC3EC; --t3: #3EDFC9; --save: #3EDFC9;
}
```

The desktop app (`app/`) is not changed here; these tokens are ready for it.
