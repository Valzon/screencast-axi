# screencast-axi

Record a scripted browser workflow as a watchable clip: a synthetic cursor, burnt-in captions,
and mp4 + webm + a poster image out the other end.

Built to [AXI](https://github.com/kunchenguid/axi) conventions, so an agent can drive it as
comfortably as a person can.

> **Status: early.** This release ships the CLI shell only - the command contract, the skill and
> the release pipeline. The recorder itself is not wired up yet. See [Roadmap](#roadmap).

## Why a script, not a screen recorder

A screencast is a performance with a script, not a recording of work being done. Making one
watchable is a matter of constants - a settle before each click, an eased pointer glide, a
consistent hold on each caption - and constants only help if you can run the same thing again and
get the same thing back. A scenario file survives a product change, gets reviewed in a pull
request, and can be re-cut at a different pace without re-deciding anything.

## Install

The skill is installed from GitHub; the CLI is pulled on demand, so there is nothing global to
install:

```sh
npx skills add Valzon/screencast-axi --skill screencast-axi -g
```

Or use it directly:

```sh
npx -y screencast-axi --help
```

## Prerequisites

| Piece       | Required | How it is found                                                      |
| ----------- | -------- | -------------------------------------------------------------------- |
| Node        | >= 20    |                                                                      |
| Chromium    | Yes      | Downloaded by Playwright                                             |
| `ffmpeg`    | Yes      | `$SCREENCAST_FFMPEG`, then an installed `ffmpeg-static`, then `PATH` |
| WebP poster | Optional | ffmpeg's `libwebp` if present, else `cwebp`, else a PNG poster       |

`ffmpeg` is not bundled. It is 80MB+ per platform, and _which_ build you have matters - many
ffmpeg builds (Homebrew's among them) ship without `libwebp`, which is why the poster has a
fallback chain rather than one hard requirement. If you would rather not install it system-wide:

```sh
pnpm add -D ffmpeg-static
```

**Platform support:** macOS and Linux are tested. Windows is intended to work but is currently
**unverified** - the known risks are argument quoting in spawned ffmpeg filter strings, path
separators inside those arguments, and Chrome's lock on a persistent profile directory.

## Usage

```sh
screencast-axi                  # the state of the clip library
screencast-axi guide            # topic-sized guidance, one topic at a time
screencast-axi guide overview
screencast-axi --help
```

Guidance deliberately lives in the CLI rather than in the installed skill: a copied file goes
stale, and an agent should be able to pull one topic instead of loading a manual.

## Roadmap

1. AXI plumbing - flag parser, contextual suggestions, release automation
2. The recorder core - the action API, the cursor and caption overlay, the encode pipeline
3. Config, scenario discovery, and the manifest reader
4. The run pipeline, and failure forensics that hand back a screenshot and a source line
5. Device presets, duration targeting, and multi-page tours
6. Auth - sign in once by hand into a reusable profile, plus storage-state and basic auth
7. The full command graph

## Contributing

```sh
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm format
```

`skills/screencast-axi/SKILL.md` is generated from `src/skill.ts` - edit the generator, run
`pnpm build:skill`, and commit the result. CI fails if the two drift, and the generator throws if
the stub grows past its character cap.

## License

MIT
