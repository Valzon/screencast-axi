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

- `npx -y screencast-axi` for the state of the clip library
- `npx -y screencast-axi --help` for the command index
- `npx -y screencast-axi <command> --help` for per-command usage
- `npx -y screencast-axi guide` for topic-sized guidance, pulled one topic at
  a time rather than read as a manual

Two things worth knowing before the first run:

1. Iterate with `rehearse`, not `record`. It runs the scenario without
   encoding, so a stale selector surfaces in seconds instead of a minute, and
   the failure comes back with a screenshot and what each part of the selector
   actually matched.
2. When a selector needs discovering, drive the page live with a browser tool
   such as `chrome-devtools-axi`, then write the scenario.

ffmpeg must be installed. For a page behind a login, read
`guide auth`: signing in is a one-time human step (`auth login`), and the
CLI refuses rather than prompting when no person is present - relay that
command to the user instead of trying to sign in yourself.

You do not need screencast-axi installed globally - invoke it with
`npx -y screencast-axi <command>`. If its output suggests a follow-up command
starting with `screencast-axi`, run that as `npx -y screencast-axi ...`.
