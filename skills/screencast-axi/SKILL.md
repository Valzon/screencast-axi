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

**This release is an early one and cannot record yet** - it ships the command
shell only. Check what you have with `npx -y screencast-axi guide overview`
before planning any recording work, and tell the user plainly if the feature
they asked for is not in the installed version rather than guessing at a
command.

You do not need screencast-axi installed globally - invoke it with
`npx -y screencast-axi <command>`. If its output suggests a follow-up command
starting with `screencast-axi`, run that as `npx -y screencast-axi ...`.
