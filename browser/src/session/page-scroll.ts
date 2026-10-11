import fs from "node:fs";
import path from "node:path";

import { app, session } from "electron";
import type { Session, WebContents } from "electron";

const SCROLL_CHANNEL = "terminal-browser:scroll";
const SCROLL_TO_CHANNEL = "terminal-browser:scroll-to";

// the terminal draws its own overlay indicator, so the real scrollbar would only steal a column
const SCROLL_PRELOAD = `const { ipcRenderer, webFrame } = require("electron");

webFrame.insertCSS(
  "html { scrollbar-width: none } html::-webkit-scrollbar { width: 0; height: 0 }",
  { cssOrigin: "user" },
);

if (window === window.top) {
  let queued = false;
  const report = () => {
    queued = false;
    const el = document.scrollingElement || document.documentElement;
    if (el) ipcRenderer.send("${SCROLL_CHANNEL}", el.scrollTop, el.scrollHeight, el.clientHeight);
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(report);
  };
  ipcRenderer.on("${SCROLL_TO_CHANNEL}", (_event, top) => {
    const el = document.scrollingElement || document.documentElement;
    if (el) el.scrollTop = top;
  });
  addEventListener("scroll", schedule, { passive: true, capture: true });
  addEventListener("resize", schedule, { passive: true });
  addEventListener("load", schedule, { passive: true });
}
`;

let preloadFile: string | null = null;
function preloadPath(): string {
  if (!preloadFile) {
    preloadFile = path.join(app.getPath("userData"), "terminal-browser-scroll-preload.js");
    fs.writeFileSync(preloadFile, SCROLL_PRELOAD);
  }
  return preloadFile;
}

const attached = new WeakSet<Session>();

// mirrors how the engine names persistent partitions, since it does not export that helper
function partitionSession(partition: string | null): Session {
  if (!partition) return session.defaultSession;
  return session.fromPartition(
    partition.startsWith("persist:") ? partition : `persist:${partition}`,
  );
}

export function attachPageScroll(partition: string | null): void {
  const target = partitionSession(partition);
  if (attached.has(target)) return;
  attached.add(target);
  target.registerPreloadScript({ type: "frame", filePath: preloadPath() });
}

export function onPageScroll(
  contents: WebContents,
  listener: (offset: number, size: number, viewport: number) => void,
): void {
  contents.on("ipc-message", (_event, channel, offset, size, viewport) => {
    if (channel !== SCROLL_CHANNEL) return;
    listener(Number(offset), Number(size), Number(viewport));
  });
}

export function scrollPageTo(contents: WebContents, offset: number): void {
  if (contents.isDestroyed()) return;
  contents.send(SCROLL_TO_CHANNEL, Math.max(0, Math.round(offset)));
}

// ten frames of about eleven milliseconds, the same feel as fancy-cat
const SCROLL_FRAMES = 10;
const SCROLL_FRAME_MS = 11;

let scrollTimer: ReturnType<typeof setInterval> | null = null;

function stopScroll() {
  if (!scrollTimer) return;
  clearInterval(scrollTimer);
  scrollTimer = null;
}

// vim style page jumps ride an ease-out curve instead of teleporting, so you keep your place
export function scrollPageBy(
  contents: WebContents,
  pixels: number,
  at: { x: number; y: number },
): void {
  stopScroll();
  let applied = 0;
  let frame = 0;
  scrollTimer = setInterval(() => {
    frame += 1;
    const eased = 1 - (1 - frame / SCROLL_FRAMES) ** 3;
    const target = pixels * eased;
    const step = target - applied;
    applied = target;
    try {
      if (step !== 0 && !contents.isDestroyed()) {
        contents.sendInputEvent({
          type: "mouseWheel",
          x: at.x,
          y: at.y,
          deltaX: 0,
          deltaY: -step,
          wheelTicksX: 0,
          wheelTicksY: -step / 40,
          hasPreciseScrollingDeltas: true,
          canScroll: true,
          modifiers: [],
        });
      }
    } catch {
      stopScroll();
      return;
    }
    if (frame >= SCROLL_FRAMES) stopScroll();
  }, SCROLL_FRAME_MS);
}
