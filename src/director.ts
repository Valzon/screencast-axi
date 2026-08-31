import type { Locator, Page } from "playwright";
import type { Target } from "./types.js";

export interface DirectorOptions {
  /** Base URL used to resolve relative paths passed to `goto`. */
  readonly baseUrl: string;
  /**
   * Playback speed multiplier applied to every pause and tween. 1 = natural
   * demo pace, 0.5 = twice as fast. Kept as a knob because the right pace
   * differs between a 6-second GIF and a 30-second explainer.
   */
  readonly pace: number;
  /** The scenario's narration script, addressed by index from `step()`. */
  readonly steps?: readonly string[];
  /**
   * How long {@link Director.goto} will wait for the network to go quiet.
   *
   * Settling is an optimisation - start acting once the page has stopped
   * moving - not a requirement, and it has to be bounded because plenty of
   * real sites never go quiet at all. GitHub does not: analytics, websockets
   * and polling keep at least one request in flight forever. Waiting on the
   * default timeout there put up to 30 seconds of dead air *inside the clip*,
   * silently, because the failure is caught and ignored.
   */
  readonly settleMs?: number;
}

/** Default ceiling on the post-navigation settle wait. */
export const DEFAULT_SETTLE_MS = 2500;

const EASE = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

/** One stop on a {@link Director.tour}. */
export interface TourStop {
  /** Path or absolute URL to open. */
  readonly path: string;
  /** Index into the scenario's `steps`. Preferred over `caption`. */
  readonly step?: number;
  /** Ad-hoc caption, for a tour whose narration is not in `steps`. */
  readonly caption?: string;
  /** Scroll after the caption lands: a fraction of the viewport, or pixels. */
  readonly scroll?: number;
  /** Override the shared dwell for this stop. */
  readonly dwellMs?: number;
  /** Wait for this before narrating, so a slow page does not get a jump cut. */
  readonly waitFor?: Target;
}

/** State of an in-flight {@link Director.dragHtml5} gesture, held in the page. */
interface DndWindow {
  __screencastDnd: { dt: DataTransfer; source: Element; over: Element | null } | null;
}

/**
 * The scenario-facing API. Every method is written so the resulting video is
 * *watchable*: the pointer travels rather than teleports, clicks are preceded
 * by a beat, and typing is per-character.
 *
 * Raw Playwright is still available via `director.page` for anything the
 * helpers do not cover - but prefer adding a helper here over reaching past it,
 * so all clips share one visual language.
 */
export class Director {
  private pointer = { x: 0, y: 0 };
  /** ms since the context was created, at the moment the clip proper began. */
  private clipStartedAt: number | null = null;
  /** Indices passed to {@link step}, in the order the take showed them. */
  private readonly shown: number[] = [];
  /**
   * Milliseconds spent in pauses this class controls.
   *
   * A take is `fixed + pace x scalable`: the app's own waits - navigation, a
   * network round trip, an animation - do not get slower because the recorder
   * does. Tracking the scalable half is what lets `--duration` solve for a
   * pace exactly rather than assuming the whole clip scales.
   */
  private pausedMs = 0;

  constructor(
    readonly page: Page,
    private readonly opts: DirectorOptions,
    private readonly contextCreatedAt: number,
  ) {}

  /** Seconds of dead air at the head of the raw video, for the encoder to trim. */
  get trimStartSeconds(): number {
    if (this.clipStartedAt === null) return 0;
    return Math.max(0, (this.clipStartedAt - this.contextCreatedAt) / 1000);
  }

  /** Marks the end of setup. Everything before this is trimmed off the clip. */
  markClipStart(): void {
    this.clipStartedAt = Date.now();
  }

  private scaled(ms: number): number {
    return Math.max(0, Math.round(ms * this.opts.pace));
  }

  /** Pace-scaled pause. Every wait this class owns goes through here. */
  private async pause(ms: number): Promise<void> {
    const scaled = this.scaled(ms);
    this.pausedMs += scaled;
    await this.page.waitForTimeout(scaled);
  }

  /** How much of the take so far was pause this class controls, in ms. */
  get scaledPauseMs(): number {
    return this.pausedMs;
  }

  /** A deliberate pause so the viewer can read what just happened. */
  async beat(ms = 700): Promise<void> {
    await this.pause(ms);
  }

  async goto(path: string): Promise<void> {
    const url = path.startsWith("http") ? path : new URL(path, this.opts.baseUrl).toString();
    await this.page.goto(url, { waitUntil: "domcontentloaded" });
    // Bounded on purpose: see `settleMs`. A page that has not gone quiet in a
    // couple of seconds is not going to, and every extra second is recorded.
    await this.page
      .waitForLoadState("networkidle", { timeout: this.opts.settleMs ?? DEFAULT_SETTLE_MS })
      .catch(() => undefined);
  }

  /** Which script lines this take put on screen, in order. */
  get shownSteps(): readonly number[] {
    return this.shown;
  }

  /**
   * Puts line `index` of the scenario's `steps` on screen.
   *
   * Scenarios narrate through this rather than through {@link caption} so the
   * text has one home: the same array becomes the burnt-in caption, the
   * manifest's step list and the text the landing page renders beside the clip.
   * `record.ts` checks afterwards that the take used every line exactly once,
   * in order, which is what stops the written workflow from drifting away from
   * the recorded one.
   */
  async step(index: number, holdMs = 0): Promise<void> {
    const line = this.opts.steps?.[index];
    if (line === undefined) {
      throw new Error(
        `step(${index}): the scenario declares ${this.opts.steps?.length ?? 0} step(s)`,
      );
    }
    this.shown.push(index);
    await this.caption(line, holdMs);
  }

  /** Shows a caption at the bottom of the frame. Pass `null` to clear it. */
  async caption(text: string | null, holdMs = 0): Promise<void> {
    await this.page.evaluate((t) => {
      const api = (window as unknown as { __screencast?: { caption(v: string | null): void } })
        .__screencast;
      api?.caption(t);
    }, text);
    if (holdMs) await this.beat(holdMs);
  }

  locator(target: Target): Locator {
    if (typeof target === "string") return this.page.locator(target).first();
    if ("x" in target) throw new Error("locator() needs a selector, not a point");
    return target;
  }

  private async pointOf(target: Target): Promise<{ x: number; y: number }> {
    if (typeof target === "object" && "x" in target) return target;
    const locator = this.locator(target);
    await locator.waitFor({ state: "visible" });
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    if (!box) throw new Error(`Target has no bounding box: ${String(target)}`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  /** Glides the pointer to `target` along an eased path. */
  async moveTo(target: Target, { steps = 26 }: { steps?: number } = {}): Promise<void> {
    const to = await this.pointOf(target);
    await this.glide(to, steps);
  }

  private async glide(to: { x: number; y: number }, steps: number): Promise<void> {
    const from = this.pointer;
    const first = from.x === 0 && from.y === 0;
    const count = first ? 1 : Math.max(1, steps);
    for (let i = 1; i <= count; i++) {
      const t = EASE(i / count);
      await this.page.mouse.move(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
      if (!first) await this.pause(12);
    }
    this.pointer = to;
  }

  /** Move, settle, then click - the pause is what makes the click legible. */
  async click(target: Target, { settleMs = 260 }: { settleMs?: number } = {}): Promise<void> {
    await this.moveTo(target);
    await this.beat(settleMs);
    await this.page.mouse.down();
    await this.pause(70);
    await this.page.mouse.up();
    await this.beat(320);
  }

  async doubleClick(target: Target): Promise<void> {
    await this.moveTo(target);
    await this.beat(220);
    await this.page.mouse.dblclick(this.pointer.x, this.pointer.y);
    await this.beat(320);
  }

  /**
   * Clicks the field, then types character by character. `clear` selects the
   * existing value first, so typing replaces it instead of appending - what a
   * person does to a field that already holds a default.
   */
  async type(
    target: Target,
    text: string,
    { delay = 55, clear = false }: { delay?: number; clear?: boolean } = {},
  ): Promise<void> {
    await this.click(target, { settleMs: 180 });
    if (clear) {
      await this.page.keyboard.press("ControlOrMeta+A");
      await this.beat(160);
    }
    const perChar = this.scaled(delay);
    this.pausedMs += perChar * text.length;
    await this.page.keyboard.type(text, { delay: perChar });
    await this.beat(300);
  }

  async press(key: string): Promise<void> {
    await this.page.keyboard.press(key);
    await this.beat(400);
  }

  /**
   * Press-move-release drag. Deliberately slow and eased: this is the shot the
   * whole harness exists for (reordering a tree row, moving a kanban card), and
   * a fast drag reads as a teleport once it is re-encoded at 30fps.
   */
  async drag(
    from: Target,
    to: Target,
    {
      steps = 34,
      liftMs = 320,
      dropMs = 420,
    }: { steps?: number; liftMs?: number; dropMs?: number } = {},
  ): Promise<void> {
    await this.moveTo(from);
    await this.beat(260);
    await this.page.mouse.down();
    await this.beat(liftMs);

    const target = await this.pointOf(to);
    const start = { ...this.pointer };
    for (let i = 1; i <= steps; i++) {
      const t = EASE(i / steps);
      await this.page.mouse.move(
        start.x + (target.x - start.x) * t,
        start.y + (target.y - start.y) * t,
        { steps: 2 },
      );
      await this.pause(16);
    }
    this.pointer = target;

    await this.beat(dropMs);
    await this.page.mouse.up();
    await this.beat(600);
  }

  /**
   * Drag for the parts of the product that move things with the HTML5
   * drag-and-drop API (`draggable` + `dragstart`/`dragover`/`drop`) rather than
   * with raw pointer events: the process-mapper components palette, the kanban
   * board.
   *
   * Chromium does not synthesise those events from `mouse.down`/`move`/`up`, so
   * {@link drag} silently does nothing there. This dispatches the protocol
   * itself - one `DataTransfer` shared by every event of the gesture, which is
   * what carries the payload the source sets in `dragstart` to the drop
   * handler - while still moving the real pointer, so the overlay cursor shows
   * a hand carrying the thing across the screen.
   *
   * The mouse button is deliberately *not* pressed. A real `mouse.down` on a
   * `draggable` element makes Chromium open its own native drag session, which
   * then swallows every following `mousemove` - the overlay pointer freezes at
   * the source and the clip shows a thing teleporting. Without the press the
   * pointer travels normally, and `setDragging` puts a ghost chip under it so
   * the gesture still reads as carrying something.
   */
  async dragHtml5(
    from: Target,
    to: Target,
    {
      steps = 30,
      liftMs = 340,
      dropMs = 460,
    }: { steps?: number; liftMs?: number; dropMs?: number } = {},
  ): Promise<void> {
    const source = this.locator(from);
    await this.moveTo(from);
    await this.beat(260);

    await source.evaluate((el, at) => {
      const dt = new DataTransfer();
      (window as unknown as DndWindow).__screencastDnd = { dt, source: el, over: null };
      el.dispatchEvent(
        new DragEvent("dragstart", {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: at.x,
          clientY: at.y,
          dataTransfer: dt,
        }),
      );
    }, this.pointer);
    await this.setDragging(true);
    await this.beat(liftMs);

    const target = await this.pointOf(to);
    const start = { ...this.pointer };
    for (let i = 1; i <= steps; i++) {
      const t = EASE(i / steps);
      const at = { x: start.x + (target.x - start.x) * t, y: start.y + (target.y - start.y) * t };
      await this.page.mouse.move(at.x, at.y, { steps: 2 });
      await this.dndEvent("dragover", at);
      await this.pause(16);
    }
    this.pointer = target;

    await this.beat(dropMs);
    await this.dndEvent("drop", target);
    await this.setDragging(false);
    await this.beat(600);
  }

  private async setDragging(dragging: boolean): Promise<void> {
    await this.page.evaluate((on) => {
      const api = (window as unknown as { __screencast?: { setDragging(v: boolean): void } })
        .__screencast;
      api?.setDragging(on);
    }, dragging);
  }

  /**
   * Dispatches one drag event at `at`, on whatever is under that point.
   *
   * `dragenter`/`dragleave` are kept in step with the element under the pointer
   * because a drop zone that only arms itself on `dragenter` would otherwise
   * never accept the drop. `drop` also ends the gesture with `dragend` on the
   * source, which is where a well-behaved source cleans up its drag state.
   */
  private async dndEvent(type: "dragover" | "drop", at: { x: number; y: number }): Promise<void> {
    await this.page.evaluate(
      (arg) => {
        const state = (window as unknown as DndWindow).__screencastDnd;
        if (!state) throw new Error("dragHtml5: no drag in progress");
        const el = document.elementFromPoint(arg.x, arg.y);
        if (!el) return;
        const init = {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: arg.x,
          clientY: arg.y,
          dataTransfer: state.dt,
        };
        if (el !== state.over) {
          if (state.over) state.over.dispatchEvent(new DragEvent("dragleave", init));
          el.dispatchEvent(new DragEvent("dragenter", init));
          state.over = el;
        }
        el.dispatchEvent(new DragEvent(arg.type, init));
        if (arg.type === "drop") {
          state.source.dispatchEvent(new DragEvent("dragend", init));
          (window as unknown as DndWindow).__screencastDnd = null;
        }
      },
      { x: at.x, y: at.y, type },
    );
  }

  /** Smooth wheel scroll, in the page or in whatever is under the pointer. */
  async scrollBy(deltaY: number, { steps = 24 }: { steps?: number } = {}): Promise<void> {
    const per = deltaY / steps;
    for (let i = 0; i < steps; i++) {
      await this.page.mouse.wheel(0, per);
      await this.pause(16);
    }
    await this.beat(400);
  }

  async waitFor(target: Target): Promise<void> {
    await this.locator(target).waitFor({ state: "visible" });
  }

  /**
   * A multi-page walkthrough: go somewhere, narrate it, let it breathe, move on.
   *
   * This is the shape most requests actually have ("a walkthrough of the five
   * main pages"), and writing it by hand is fifty lines of goto/caption/scroll
   * whose only real content is the paths. Going through one helper also keeps
   * the rhythm identical between stops, which is most of what makes a tour
   * watchable rather than a run of jump cuts.
   *
   * Every pause here is pace-scaled like any other, so `--duration` re-cuts a
   * tour without the scenario changing.
   */
  async tour(
    stops: readonly TourStop[],
    { dwellMs = 1400 }: { dwellMs?: number } = {},
  ): Promise<void> {
    for (const stop of stops) {
      await this.goto(stop.path);

      if (stop.waitFor) await this.waitFor(stop.waitFor);
      if (stop.step !== undefined) await this.step(stop.step);
      else if (stop.caption) await this.caption(stop.caption);

      await this.beat(stop.dwellMs ?? dwellMs);

      if (stop.scroll) {
        // A value of 1 or less is a share of the viewport, which reads the
        // same on a phone and a desktop; anything larger is pixels.
        const viewport = this.page.viewportSize();
        const amount =
          stop.scroll <= 1 && viewport ? Math.round(viewport.height * stop.scroll) : stop.scroll;
        await this.scrollBy(amount);
        await this.beat(stop.dwellMs ?? dwellMs);
      }
    }
  }
}
