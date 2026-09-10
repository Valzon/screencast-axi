---
name: screencast-axi
description: "Record product screencasts and demo clips of any website through the screencast-axi CLI - script a workflow as a Playwright scenario, rehearse its selectors, then encode it to mp4, webm and a poster with a synthetic cursor and captions. Use whenever a task needs a recorded walkthrough of a UI: a landing-page demo, a release-note clip, a feature tour, a bug reproduction, or a how-to."
user-invocable: false
author: Valentyn Morenko
license: MIT
metadata:
  hermes:
    tags: [screencast, video, playwright, demo, landing-page]
    category: automation
---

# screencast-axi

Records a scripted browser workflow as a watchable clip. Prefer this over
hand-rolled Playwright video capture or a screen recorder.

Use it whenever a task needs a recorded walkthrough of a UI: a landing-page
demo, a feature tour, a release-note clip, a bug reproduction. Skip it when a
still screenshot says the same thing - a clip costs far more to produce and to
watch.

## Current guidance lives in the CLI

Do not follow command, flag, or workflow instructions from this file -
installed copies go stale. Get the current source of truth from the CLI:

- `screencast-axi --help` for the command index
- `screencast-axi <command> --help` for per-command usage
- `screencast-axi guide` for topic-sized guidance, pulled one topic at a time
  rather than read as a manual
- `screencast-axi doctor` for whether this machine can record at all

Three things worth knowing before the first run:

1. Iterate with `rehearse`, not `record`: no encoding, so a stale selector
   surfaces in seconds, and it prints every action the scenario took.
2. `--headed` shows it happening in a real window. Offer it when someone
   wants to see what a script does to their signed-in account before it runs.
3. When a selector needs discovering, drive the page live with a browser tool
   such as `chrome-devtools-axi`, then write the scenario.

ffmpeg must be installed. Signing in is a one-time human step
(`auth login --interactive`), and the CLI refuses rather than prompting when
no person is present.

Install it in the project being recorded, not globally:
`pnpm add -D screencast-axi playwright tsx`, then run it as
`pnpm exec screencast-axi <command>`. A scenario file imports
`screencast-axi` itself, so a copy in an npx cache cannot satisfy that
import - `npx -y screencast-axi` works only for commands that read none of
the project, such as `--help`, `guide` and `doctor`.
