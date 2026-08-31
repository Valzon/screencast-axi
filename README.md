# screencast-axi

Record a scripted browser workflow as a watchable clip: a drawn cursor, burnt-in captions, and
mp4 + webm + a poster out the other end. Built to [AXI](https://github.com/kunchenguid/axi)
conventions, so an agent can drive it as comfortably as a person can.

<picture>
  <source srcset="https://raw.githubusercontent.com/Valzon/screencast-axi/main/docs/demo.anim.webp" type="image/webp">
  <img src="https://raw.githubusercontent.com/Valzon/screencast-axi/main/docs/demo.gif" alt="A scripted workflow being recorded: a cursor moves to a text field, types a task, and the app responds." width="640">
</picture>

<sup>Recorded by this tool, from [`demo/scenarios/demo.ts`](demo/scenarios/demo.ts). Re-record it
with `pnpm demo`.</sup>

> **Status: 0.x and not yet published.** The recorder works end to end; the command surface is
> still growing. See [Roadmap](#roadmap).

## Why a script, not a screen recorder

A screencast is a performance with a script, not a recording of work being done. What makes one
watchable is a set of constants - a settle before each click, an eased pointer glide, a consistent
hold on each caption - and constants only help if you can run the same thing again and get the
same thing back. A scenario file survives a product change, gets reviewed in a pull request, and
can be re-cut at a different length without re-deciding anything.

## Quick start

No config needed. Point it at any site:

```sh
npx -y screencast-axi scaffold product-tour --url https://example.com
# fill in the run() body
npx -y screencast-axi rehearse ./scenarios/product-tour.ts
npx -y screencast-axi record   ./scenarios/product-tour.ts
```

`rehearse` runs the scenario without encoding, so a stale selector surfaces in seconds rather than
a minute - and the failure comes back with the URL it reached, a screenshot, and what each part of
the selector actually matched.

A scenario is TypeScript:

```ts
import { defineScenario } from "screencast-axi";

export default defineScenario({
  id: "product-tour",
  title: "A three-stop tour",
  description: "The pages that matter, in order.",
  steps: ["Where the work lives", "How it gets organised", "And what comes out"],

  async run(d) {
    await d.tour([
      { path: "/", step: 0, scroll: 0.6 },
      { path: "/features", step: 1, scroll: 0.5 },
      { path: "/pricing", step: 2 },
    ]);
  },
});
```

Each line in `steps` goes on screen once, in order. The same array becomes the burnt-in caption
and the manifest's step list, so the written workflow cannot drift from the recorded one - a take
that skips a line fails.

## Install

The skill is installed from GitHub; the CLI is pulled on demand, so there is nothing global:

```sh
npx skills add Valzon/screencast-axi --skill screencast-axi -g
```

## Prerequisites

| Piece       | Required | How it is found                                                      |
| ----------- | -------- | -------------------------------------------------------------------- |
| Node        | >= 20    |                                                                      |
| Chromium    | yes      | Playwright downloads it                                              |
| `ffmpeg`    | yes      | `$SCREENCAST_FFMPEG`, then an installed `ffmpeg-static`, then `PATH` |
| WebP poster | optional | ffmpeg's `libwebp`, else `cwebp`, else a PNG poster                  |

ffmpeg is not bundled: it is 80MB+ per platform, and _which_ build you have matters - many builds
(Homebrew's among them) ship without `libwebp`, which is why the poster has a fallback chain
rather than one hard requirement. If you would rather not install it system-wide,
`pnpm add -D ffmpeg-static` and the cascade finds it.

**Platforms:** macOS and Linux are tested, including in CI. Windows is intended to work but is
**unverified** - the known risks are argument quoting in spawned ffmpeg filter strings, path
separators inside those arguments, and Chrome's lock on a persistent profile directory.

## Recording a page behind a login

The strategy that needs no code for the site you are recording is `profileAuth()`. A person runs
this once:

```sh
npx -y screencast-axi auth login --interactive
```

A browser opens, they sign in however that site wants - OAuth, SSO, a magic link, two-factor - and
close the window. The session lives in a persistent Chrome profile and every take reuses it. No
credential is handled by this package.

`auth login` never reads stdin, so an agent can open the window on the user's screen rather than
making them retype a command. It cannot hang: the wait is bounded, and it refuses up front where
no window could appear.

Also shipped: `storageStateAuth({ path })` for a portable session file, and
`basicAuth({ username, password })` for staging environments. Anything else is an `AuthStrategy`
object written in the config - typed and debuggable rather than a shelled-out script.

> A scenario that creates or drags something **writes to whatever it is pointed at**. Prefer
> read-only scenarios against production, or point at staging.

## Seeing what a scenario does

A scenario is arbitrary code driving a real browser, often one signed into your own account, so
"what will this actually do" deserves a better answer than "read the TypeScript". Two:

```sh
screencast-axi rehearse <id>            # prints every action it took
screencast-axi rehearse <id> --headed   # and shows you it happening
```

A rehearsal prints `performed` - every goto, click, typed value, drag and scroll, in order, with
timings - and `hosts`, the short answer to where the script went. `--headed` opens a real window
and does not change the output; the clip is identical either way.

## Output formats

Every take produces an mp4, a webm and a poster. Looping images are opt-in with `--gif` and
`--webp`, for the places a `<video>` does not render - a README, an npm page, an email.

Measured on a real 16.7s app screencast, all at 800px and 15fps:

| Format        | Size     | vs mp4 |
| ------------- | -------- | ------ |
| mp4 (h264)    | 182 KB   | 1x     |
| animated WebP | 944 KB   | 5.2x   |
| GIF           | 2,034 KB | 11.2x  |

Prefer WebP where it renders: same content, roughly half the bytes, full colour rather than a
256-entry palette. Quality is not the deciding factor for flat app UI - 192 colours plus dithering
keeps small text legible - but a GIF has no controls, no seeking, no poster frame, cannot be
paused, and ignores `prefers-reduced-motion`. It is an export, not a storage format.

## Configuration

Optional. `screencast.config.ts` at the repo root, found by walking up from the working directory:

```ts
import { defineConfig, profileAuth } from "screencast-axi";

export default defineConfig({
  baseUrl: "http://localhost:3000",
  scenarios: ["scenarios/*.ts"],
  outDir: "public/demos",
  viewport: { width: 1440, height: 900 },

  browser: { profileDir: ".screencast/profile" },
  auth: profileAuth({ signedInSelector: "[data-testid=user-menu]" }),

  overlay: {
    accent: "#4f46e5",
    // Page chrome that should not end up in the footage.
    hideSelectors: ["#cookie-banner", "nextjs-portal"],
  },
});
```

Relative paths resolve against the config file, never the shell's working directory, so a command
means the same thing from anywhere in a repo.

## Mobile, and aiming at a length

```sh
screencast-axi record tour --device "iPhone 13" --orientation portrait --duration 20s
```

Device presets come from Playwright's registry, so a phone clip is captured at its real device
pixels rather than its CSS viewport - the difference between readable UI text and a smear.

`--duration` runs one measuring pass, then solves for the pace that lands near the target. A take
is `fixed + pace x scalable`: the site's own waits do not get slower because the recorder does, so
the solve uses the measured split rather than assuming everything scales.

## Reading the manifest

Every take writes `manifest.json` beside the clips. A site can read it at build time without
pulling in Playwright or a browser:

```ts
import { readManifest, clipFilesFor } from "screencast-axi/manifest";
```

That entry point has no runtime dependencies at all.

## Roadmap

- `list`, `show`, `check`, `doctor`, `setup`, `init`
- Publishing to npm

## Contributing

```sh
pnpm install
pnpm build && pnpm test && pnpm typecheck && pnpm format
```

`skills/screencast-axi/SKILL.md` is generated from `src/skill.ts` - edit the generator, run
`pnpm build:skill`, and commit the result. CI fails if the two drift, and the generator throws if
the stub grows past its character cap.

## License

MIT
