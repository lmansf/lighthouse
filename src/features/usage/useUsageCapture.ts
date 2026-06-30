"use client";

/**
 * UI click-capture hook (renderer side).
 *
 * Mounts a single delegated, capture-phase click listener that records a coarse
 * interaction for anything the user touches — folders, files, toggles, buttons,
 * links, nav. For each click it resolves the nearest interactive ancestor and
 * derives:
 *   - a coarse `type` (folder|file|toggle|button|link|nav|other), preferring an
 *     explicit `data-log-type`, else inferred from tag/role/aria;
 *   - a stable `label`, preferring `data-log`, then aria-label/title/text — never
 *     a field value, file content, or anything sensitive (labels/names only).
 *
 * Events are buffered in memory and flushed to `/api/usage` (which appends them
 * to a local ring-buffer; they publish on the next launch). Consent is read once
 * on mount: when the user has opted out, no listener is attached at all.
 *
 * Lightweight by design: one listener, a tiny buffer, a throttled flush.
 */
import { useEffect } from "react";

type UsageEventType = "folder" | "file" | "toggle" | "button" | "link" | "nav" | "other";

interface CapturedEvent {
  at: string;
  type: UsageEventType;
  label: string;
}

const EVENT_TYPES: readonly UsageEventType[] = [
  "folder",
  "file",
  "toggle",
  "button",
  "link",
  "nav",
  "other",
];

const FLUSH_MS = 5000; // batch flush cadence
const FLUSH_AT = 25; // ...or eagerly once this many pile up
const MAX_LABEL = 80; // server clamps again; keep the wire small
const MAX_HOPS = 8; // how far up the DOM to look for an interactive target

function attr(el: Element, name: string): string | null {
  const v = el.getAttribute(name);
  return v && v.trim() ? v.trim() : null;
}

/** True when `el` is something a user meaningfully "touches". */
function isInteractive(el: Element): boolean {
  if (attr(el, "data-log") || attr(el, "data-log-type")) return true;
  const tag = el.tagName.toLowerCase();
  if (tag === "a" || tag === "button" || tag === "summary") return true;
  if (tag === "input") {
    const t = (el as HTMLInputElement).type;
    return t === "checkbox" || t === "radio" || t === "button" || t === "submit";
  }
  const role = attr(el, "role");
  return (
    role === "button" ||
    role === "switch" ||
    role === "checkbox" ||
    role === "tab" ||
    role === "menuitem" ||
    role === "link" ||
    role === "treeitem" ||
    role === "option"
  );
}

/** Coarse bucket for an interactive element. */
function classify(el: Element): UsageEventType {
  const explicit = attr(el, "data-log-type");
  if (explicit && EVENT_TYPES.includes(explicit as UsageEventType)) return explicit as UsageEventType;

  const tag = el.tagName.toLowerCase();
  const role = attr(el, "role");
  const inputType = tag === "input" ? (el as HTMLInputElement).type : "";

  if (role === "switch" || role === "checkbox" || inputType === "checkbox" || inputType === "radio") {
    return "toggle";
  }
  if (role === "tab" || el.closest("nav")) return "nav";
  if (tag === "a" || role === "link") return "link";
  if (
    tag === "button" ||
    role === "button" ||
    role === "menuitem" || // menu items are actions, not navigation
    inputType === "button" ||
    inputType === "submit"
  ) {
    return "button";
  }
  return "other";
}

/** A stable, human-readable label — names only, never values/contents. */
function labelOf(el: Element): string {
  const candidate =
    attr(el, "data-log") ||
    attr(el, "aria-label") ||
    attr(el, "title") ||
    (el.textContent || "").replace(/\s+/g, " ").trim() ||
    attr(el, "role") ||
    el.tagName.toLowerCase();
  return candidate.slice(0, MAX_LABEL);
}

/** Walk up from the click target to the nearest interactive element. */
function resolve(start: EventTarget | null): CapturedEvent | null {
  let el = start instanceof Element ? start : null;
  for (let hops = 0; el && hops < MAX_HOPS; el = el.parentElement, hops++) {
    if (isInteractive(el)) {
      const label = labelOf(el);
      if (!label) return null;
      return { at: new Date().toISOString(), type: classify(el), label };
    }
  }
  return null;
}

export function useUsageCapture(): void {
  useEffect(() => {
    let cancelled = false;
    let listening = false;
    const buffer: CapturedEvent[] = [];
    let timer: ReturnType<typeof setInterval> | null = null;

    const flush = () => {
      if (!buffer.length) return;
      const batch = buffer.splice(0, buffer.length);
      void fetch("/api/usage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "events", events: batch }),
        keepalive: true, // let an in-flight flush survive an unmount/close
      }).catch(() => {
        /* best-effort — a dropped flush just means those clicks aren't logged */
      });
    };

    const onClick = (e: MouseEvent) => {
      const ev = resolve(e.target);
      if (!ev) return;
      buffer.push(ev);
      if (buffer.length >= FLUSH_AT) flush();
    };

    const onHide = () => {
      if (document.visibilityState === "hidden") flush();
    };

    (async () => {
      // Consent gate: read once. Opted out ⇒ never attach a listener.
      try {
        const r = await fetch("/api/usage");
        const d = (await r.json()) as { optOut?: boolean };
        if (cancelled || d.optOut) return;
      } catch {
        return; // can't confirm consent ⇒ don't capture
      }
      listening = true;
      document.addEventListener("click", onClick, { capture: true });
      document.addEventListener("visibilitychange", onHide);
      timer = setInterval(flush, FLUSH_MS);
    })();

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      if (listening) {
        document.removeEventListener("click", onClick, { capture: true });
        document.removeEventListener("visibilitychange", onHide);
        flush(); // ship whatever's left
      }
    };
  }, []);
}
