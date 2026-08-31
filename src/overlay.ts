/**
 * Page overlay injected into every document of a recording session.
 *
 * Playwright videos do not contain the mouse pointer, which makes any clip of a
 * drag or a click unreadable. This draws a synthetic pointer that follows the
 * real one (Playwright's `mouse.move` dispatches genuine `mousemove` events, so
 * the overlay stays in sync for free), plus a click ripple, a drag ghost and a
 * caption bar.
 *
 * Everything lives in a shadow root so no page CSS can reach it, and the host
 * is `pointer-events: none` so it never intercepts a click.
 */

export interface OverlayApi {
  caption(text: string | null): void;
  setPointerVisible(visible: boolean): void;
  setDragging(dragging: boolean): void;
}

declare global {
  interface Window {
    __screencast?: OverlayApi;
  }
}

export interface OverlayTheme {
  /** Ripple and drag-ghost colour. Any CSS colour; hex gets alpha variants. */
  readonly accent: string;
  /** Replace the browser's own cursor with the drawn one. */
  readonly hideNativeCursor: boolean;
  /**
   * Selectors hidden for the duration of the recording.
   *
   * Development-only chrome belongs here - a framework's error badge, a
   * cookie banner, a staging ribbon - so it never lands in footage that gets
   * shown to someone.
   */
  readonly hideSelectors: readonly string[];
  readonly pointer: {
    readonly size: number;
    readonly fill: string;
    readonly stroke: string;
    readonly strokeWidth: number;
  };
  readonly ripple: {
    readonly enabled: boolean;
    readonly scale: number;
    readonly durationMs: number;
  };
  readonly dragGhost: {
    readonly enabled: boolean;
    readonly width: number;
    readonly height: number;
    readonly radius: number;
  };
  readonly caption: {
    readonly position: "top" | "bottom";
    /** Distance from that edge, in px. */
    readonly offset: number;
    readonly maxWidth: string;
    readonly background: string;
    readonly color: string;
    readonly fontSize: number;
    readonly fontFamily: string;
    readonly fontWeight: number;
    readonly radius: number;
    readonly padding: string;
    readonly fadeMs: number;
    readonly shadow: string;
  };
}

export const DEFAULT_OVERLAY_THEME: OverlayTheme = {
  accent: "#4f46e5",
  hideNativeCursor: true,
  hideSelectors: [],
  pointer: { size: 26, fill: "#111116", stroke: "#ffffff", strokeWidth: 1.6 },
  ripple: { enabled: true, scale: 2.6, durationMs: 500 },
  dragGhost: { enabled: true, width: 46, height: 30, radius: 6 },
  caption: {
    position: "bottom",
    offset: 40,
    maxWidth: "min(760px, 78vw)",
    background: "rgba(17, 17, 22, .88)",
    color: "#ffffff",
    fontSize: 17,
    fontFamily: 'ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif',
    fontWeight: 500,
    radius: 12,
    padding: "12px 20px",
    fadeMs: 220,
    shadow: "0 12px 40px rgba(0,0,0,.34)",
  },
};

/**
 * Theme with every colour already resolved to a concrete CSS string.
 *
 * The alpha variants are computed here rather than in the page so that
 * {@link installOverlay} stays a dumb interpolator: it has to survive being
 * stringified, and every helper it would otherwise call is one more thing that
 * can break in that trip.
 */
export interface ResolvedOverlayTheme extends OverlayTheme {
  readonly accentSoft: string;
  readonly accentEdge: string;
  readonly accentRipple: string;
  readonly accentRippleEdge: string;
}

function rgba(color: string, alpha: number): string {
  const hex = color.trim().replace(/^#/, "");
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((c) => c + c)
          .join("")
      : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    // Not a hex colour - use it as given and let the browser decide. A named
    // colour or an rgb() string still renders; it just cannot be made
    // translucent here.
    return color;
  }
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function resolveOverlayTheme(overrides?: DeepPartial<OverlayTheme>): ResolvedOverlayTheme {
  const t = mergeTheme(DEFAULT_OVERLAY_THEME, overrides);
  return {
    ...t,
    accentSoft: rgba(t.accent, 0.16),
    accentEdge: rgba(t.accent, 0.55),
    accentRipple: rgba(t.accent, 0.28),
    accentRippleEdge: rgba(t.accent, 0.6),
  };
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[]
    ? T[K]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

export function mergeThemes(
  base: DeepPartial<OverlayTheme> | undefined,
  over: DeepPartial<OverlayTheme> | undefined,
): DeepPartial<OverlayTheme> {
  if (!base) return over ?? {};
  if (!over) return base;
  return {
    ...base,
    ...over,
    pointer: { ...base.pointer, ...over.pointer },
    ripple: { ...base.ripple, ...over.ripple },
    dragGhost: { ...base.dragGhost, ...over.dragGhost },
    caption: { ...base.caption, ...over.caption },
  };
}

function mergeTheme(base: OverlayTheme, overrides?: DeepPartial<OverlayTheme>): OverlayTheme {
  if (!overrides) return base;
  return {
    ...base,
    ...overrides,
    pointer: { ...base.pointer, ...overrides.pointer },
    ripple: { ...base.ripple, ...overrides.ripple },
    dragGhost: { ...base.dragGhost, ...overrides.dragGhost },
    caption: { ...base.caption, ...overrides.caption },
  } as OverlayTheme;
}

/**
 * Serialised form of {@link installOverlay}, ready for `addInitScript`.
 *
 * The function is stringified rather than passed directly because this file is
 * compiled by esbuild under `keepNames` in some toolchains, which rewrites
 * every inner function as `__name(fn, "fn")`. That helper only exists in the
 * Node module scope, so the function throws `__name is not defined` the moment
 * Playwright evaluates it in the page - silently, unless a `pageerror`
 * listener is attached. Re-declaring `__name` as identity in the wrapper is
 * enough, and costs nothing if a future toolchain stops emitting it.
 *
 * The theme travels as JSON in the same wrapper, so theming does not
 * reintroduce a function reference that would have to survive the same trip.
 */
export function overlayInitScript(theme: ResolvedOverlayTheme): string {
  return `(() => { const __name = (fn) => fn; (${installOverlay.toString()})(${JSON.stringify(theme)}); })();`;
}

/** Runs inside the page via `addInitScript`. Must be fully self-contained. */
export function installOverlay(theme: ResolvedOverlayTheme): void {
  const HOST_ID = "__screencast_overlay";
  const STYLE_ID = "__screencast_hide";

  // Already installed in this realm. An init script runs once per document
  // creation, so this only fires if something injected it twice.
  if (window.__screencast) return;

  interface Refs {
    host: HTMLElement;
    pointer: SVGElement;
    ripple: HTMLElement;
    carry: HTMLElement;
    caption: HTMLElement;
  }

  let refs: Refs | null = null;
  /** Last caption text, so a re-mount can restore what was on screen. */
  let captionText: string | null = null;

  const cap = theme.caption;
  const edge = cap.position === "top" ? `top: ${cap.offset}px` : `bottom: ${cap.offset}px`;
  const rise = cap.position === "top" ? -8 : 8;

  const build = (): Refs | null => {
    if (!document.body || !document.documentElement) return null;

    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
    const root = host.attachShadow({ mode: "open" });

    root.innerHTML = `
      <style>
        :host { all: initial; }
        .pointer {
          position: fixed; top: 0; left: 0;
          width: ${theme.pointer.size}px; height: ${theme.pointer.size}px;
          transform: translate3d(-100px, -100px, 0);
          will-change: transform; opacity: 0; transition: opacity 120ms linear;
        }
        .pointer.on { opacity: 1; }
        .carry {
          position: fixed; top: 0; left: 0;
          transform: translate3d(-100px, -100px, 0);
          opacity: 0; transition: opacity 140ms linear;
        }
        .carry.on { opacity: 1; }
        .carry > i {
          display: block;
          width: ${theme.dragGhost.width}px; height: ${theme.dragGhost.height}px;
          margin: 10px 0 0 10px;
          border-radius: ${theme.dragGhost.radius}px;
          background: ${theme.accentSoft};
          border: 1px solid ${theme.accentEdge};
          box-shadow: 0 6px 18px rgba(17, 17, 22, .18);
        }
        .ripple { position: fixed; top: 0; left: 0; transform: translate3d(-100px, -100px, 0); }
        .ripple > i {
          display: block; width: 18px; height: 18px; margin: -9px 0 0 -9px;
          border-radius: 50%; background: ${theme.accentRipple};
          box-shadow: 0 0 0 2px ${theme.accentRippleEdge};
          transform: scale(.3); opacity: 0;
        }
        .ripple.go > i {
          animation: pop ${theme.ripple.durationMs}ms cubic-bezier(.2,.8,.3,1) forwards;
        }
        @keyframes pop {
          0%   { transform: scale(.3);  opacity: .95; }
          100% { transform: scale(${theme.ripple.scale}); opacity: 0; }
        }
        .caption {
          position: fixed; left: 50%; ${edge};
          transform: translateX(-50%) translateY(${rise}px);
          max-width: ${cap.maxWidth}; padding: ${cap.padding};
          border-radius: ${cap.radius}px;
          background: ${cap.background}; color: ${cap.color};
          font: ${cap.fontWeight} ${cap.fontSize}px/1.45 ${cap.fontFamily};
          letter-spacing: .01em; text-align: center;
          box-shadow: ${cap.shadow};
          opacity: 0;
          transition: opacity ${cap.fadeMs}ms ease, transform ${cap.fadeMs}ms ease;
        }
        .caption.on { opacity: 1; transform: translateX(-50%) translateY(0); }
      </style>
      <div class="ripple"><i></i></div>
      <div class="carry"><i></i></div>
      <svg class="pointer" viewBox="0 0 26 26" aria-hidden="true">
        <path d="M5 2.5 L5 20.5 L9.6 16.2 L12.6 22.6 L16 21 L13 14.8 L19.4 14.4 Z"
              fill="${theme.pointer.fill}" stroke="${theme.pointer.stroke}"
              stroke-width="${theme.pointer.strokeWidth}" stroke-linejoin="round"/>
      </svg>
      <div class="caption"></div>
    `;

    document.documentElement.appendChild(host);

    // A single fixed arrow reads better than the browser swapping between
    // arrow / text / grab cursors mid-clip, so hide the real one. Anything in
    // `hideSelectors` is page chrome the recording should not show.
    if (document.head && !document.getElementById(STYLE_ID)) {
      const rules: string[] = [];
      if (theme.hideNativeCursor) rules.push("*, *::before, *::after { cursor: none !important; }");
      for (const selector of theme.hideSelectors) {
        rules.push(`${selector} { display: none !important; }`);
      }
      if (rules.length > 0) {
        const hide = document.createElement("style");
        hide.id = STYLE_ID;
        hide.textContent = rules.join(" ");
        document.head.appendChild(hide);
      }
    }

    const next: Refs = {
      host,
      pointer: root.querySelector(".pointer") as SVGElement,
      ripple: root.querySelector(".ripple") as HTMLElement,
      carry: root.querySelector(".carry") as HTMLElement,
      caption: root.querySelector(".caption") as HTMLElement,
    };

    // A re-mount must not lose the line that was on screen: a page that
    // rewrites its document mid-take would otherwise drop the caption and the
    // clip would keep recording as if nothing were wrong.
    if (captionText !== null) {
      next.caption.textContent = captionText;
      next.caption.classList.add("on");
    }
    return next;
  };

  /**
   * The overlay, rebuilt if the page threw it away.
   *
   * A document replacement - `document.write`, Playwright's `setContent`, some
   * SPA bootstraps - detaches the host while this realm, and therefore
   * `window.__screencast`, survives. Without this the API would keep answering
   * on a detached node: captions would stop appearing and the recording would
   * carry on silently, which is the worst way for this to fail.
   */
  const ensure = (): Refs | null => {
    if (refs && refs.host.isConnected) return refs;
    refs = build();
    return refs;
  };

  const move = (x: number, y: number) => {
    const r = ensure();
    if (!r) return;
    r.pointer.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    r.carry.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    r.pointer.classList.add("on");
  };

  addEventListener("mousemove", (e) => move(e.clientX, e.clientY), {
    capture: true,
    passive: true,
  });

  if (theme.ripple.enabled) {
    addEventListener(
      "mousedown",
      (e) => {
        const r = ensure();
        if (!r) return;
        r.ripple.style.transform = `translate3d(${e.clientX}px, ${e.clientY}px, 0)`;
        r.ripple.classList.remove("go");
        void r.ripple.offsetWidth; // restart the animation
        r.ripple.classList.add("go");
      },
      { capture: true, passive: true },
    );
  }

  window.__screencast = {
    caption(text: string | null) {
      captionText = text;
      const r = ensure();
      if (!r) return;
      if (text) {
        r.caption.textContent = text;
        r.caption.classList.add("on");
      } else {
        r.caption.classList.remove("on");
      }
    },
    setPointerVisible(visible: boolean) {
      ensure()?.pointer.classList.toggle("on", visible);
    },
    // An HTML5 drag never presses the mouse button (see Director.dragHtml5),
    // so there is no ripple and nothing else on screen says "this pointer is
    // carrying something". This ghost chip does.
    setDragging(dragging: boolean) {
      if (!theme.dragGhost.enabled) return;
      ensure()?.carry.classList.toggle("on", dragging);
    },
  };

  // Listeners go on `window`, not `document`: `document.open()` - which is how
  // a page replaces itself - drops every listener registered on the document,
  // while window-level ones survive.
  //
  // These cover the ordinary path, where the document is still parsing when
  // the init script runs. They do *not* cover a document replacement: measured
  // in Chromium, a replaced document fires neither DOMContentLoaded nor load
  // on window, even though the listeners are still attached. That case is
  // handled lazily by `ensure()`, which every API call and every pointer move
  // goes through - so the overlay is back before the next thing a take does.
  addEventListener("DOMContentLoaded", () => ensure());
  addEventListener("load", () => ensure());
  ensure();
}
