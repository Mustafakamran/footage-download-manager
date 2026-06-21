import { useCallback, useEffect, useRef, useState } from "react";
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize2,
  Minimize2,
  SkipBack,
  SkipForward,
  ChevronLeft,
  ChevronRight,
  Gauge,
} from "lucide-react";
import { timecode } from "../lib/review";

interface Marker {
  id: string;
  time: number;
  text: string;
}

/** ~1 frame at 30fps — fps isn't exposed by <video>, so frame-step is approximate. */
const FRAME = 1 / 30;
const SPEEDS = [0.25, 0.5, 1, 1.5, 2];

interface Props {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  src: string;
  /** When true, drop crossOrigin (PDF frame-capture won't work, but playback will). */
  noCors: boolean;
  comments: Marker[];
  duration: number;
  onDuration: (d: number) => void;
  onTime: (t: number) => void;
  onError: () => void;
}

export function ReviewPlayer({ videoRef, src, noCors, comments, duration, onDuration, onTime, onError }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [speedOpen, setSpeedOpen] = useState(false);
  const [fs, setFs] = useState(false);
  const [show, setShow] = useState(true);
  const [hover, setHover] = useState<number | null>(null);

  const v = () => videoRef.current;

  const seek = useCallback(
    (t: number) => {
      const el = v();
      if (!el || !Number.isFinite(t)) return;
      el.currentTime = Math.max(0, Math.min(t, el.duration || t));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const togglePlay = useCallback(() => {
    const el = v();
    if (!el) return;
    if (el.paused) el.play().catch(() => {});
    else el.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flashControls = useCallback(() => {
    setShow(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (v() && !v()!.paused) setShow(false);
    }, 2500);
  }, [videoRef]);

  // Keyboard shortcuts (ignored while typing in the comment box).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || (el as HTMLElement).isContentEditable)) return;
      const vid = v();
      if (!vid) return;
      switch (e.key) {
        case " ":
        case "k":
          e.preventDefault();
          togglePlay();
          break;
        case "j":
          seek(vid.currentTime - 10);
          break;
        case "l":
          seek(vid.currentTime + 10);
          break;
        case "ArrowLeft":
          e.preventDefault();
          seek(vid.currentTime - (e.shiftKey ? 1 : 5));
          break;
        case "ArrowRight":
          e.preventDefault();
          seek(vid.currentTime + (e.shiftKey ? 1 : 5));
          break;
        case ",":
          seek(vid.currentTime - FRAME);
          break;
        case ".":
          seek(vid.currentTime + FRAME);
          break;
        case "Home":
          seek(0);
          break;
        case "End":
          seek(vid.duration);
          break;
        case "m":
          vid.muted = !vid.muted;
          break;
        case "f":
          toggleFullscreen();
          break;
        default:
          return;
      }
      flashControls();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seek, togglePlay, flashControls]);

  useEffect(() => {
    const onFs = () => setFs(document.fullscreenElement === wrapRef.current);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else wrapRef.current?.requestFullscreen().catch(() => {});
  }

  function timeFromPointer(clientX: number): number {
    const bar = barRef.current;
    if (!bar || !duration) return 0;
    const r = bar.getBoundingClientRect();
    const p = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    return p * duration;
  }

  function onScrubDown(e: React.PointerEvent) {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    seek(timeFromPointer(e.clientX));
    const move = (ev: PointerEvent) => seek(timeFromPointer(ev.clientX));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  const pct = (t: number) => (duration > 0 ? `${Math.min(100, (t / duration) * 100)}%` : "0%");

  return (
    <div
      ref={wrapRef}
      className="group relative flex max-h-full max-w-full items-center justify-center overflow-hidden rounded-[8px] bg-black"
      onPointerMove={flashControls}
      onMouseLeave={() => playing && setShow(false)}
    >
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        key={noCors ? "nocors" : "cors"}
        ref={videoRef}
        src={src}
        {...(noCors ? {} : { crossOrigin: "anonymous" as const })}
        className="max-h-full max-w-full"
        onClick={togglePlay}
        onDoubleClick={toggleFullscreen}
        onLoadedMetadata={(e) => onDuration(e.currentTarget.duration || 0)}
        onDurationChange={(e) => onDuration(e.currentTarget.duration || 0)}
        onTimeUpdate={(e) => {
          setCurrent(e.currentTarget.currentTime);
          onTime(e.currentTarget.currentTime);
        }}
        onSeeked={(e) => {
          setCurrent(e.currentTarget.currentTime);
          onTime(e.currentTarget.currentTime);
        }}
        onPlay={() => {
          setPlaying(true);
          flashControls();
        }}
        onPause={() => {
          setPlaying(false);
          setShow(true);
        }}
        onProgress={(e) => {
          const b = e.currentTarget.buffered;
          if (b.length) setBuffered(b.end(b.length - 1));
        }}
        onVolumeChange={(e) => {
          setVolume(e.currentTarget.volume);
          setMuted(e.currentTarget.muted);
        }}
        onError={onError}
      />

      {/* Center play affordance when paused */}
      {!playing && (
        <button
          onClick={togglePlay}
          aria-label="Play"
          className="absolute grid h-16 w-16 place-items-center rounded-full bg-black/45 text-white backdrop-blur-sm transition hover:bg-black/65"
        >
          <Play size={28} className="ml-1" />
        </button>
      )}

      {/* Controls */}
      <div
        className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-3 pb-2 pt-8 transition-opacity duration-200 ${
          show ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        {/* Scrubber */}
        <div
          ref={barRef}
          onPointerDown={onScrubDown}
          onMouseMove={(e) => setHover(timeFromPointer(e.clientX))}
          onMouseLeave={() => setHover(null)}
          className="group/bar relative mb-2 flex h-4 cursor-pointer items-center"
        >
          <div className="relative h-1.5 w-full rounded-full bg-white/25">
            <div className="absolute inset-y-0 left-0 rounded-full bg-white/35" style={{ width: pct(buffered) }} />
            <div className="absolute inset-y-0 left-0 rounded-full bg-[var(--accent)]" style={{ width: pct(current) }} />
            {/* playhead */}
            <div
              className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white opacity-0 shadow group-hover/bar:opacity-100"
              style={{ left: pct(current) }}
            />
            {/* comment markers */}
            {comments.map((c) => (
              <button
                key={c.id}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  seek(c.time);
                }}
                title={`${timecode(c.time)} — ${c.text}`}
                className="absolute top-1/2 h-3 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-sm bg-[var(--warning)] hover:h-4"
                style={{ left: pct(c.time) }}
              />
            ))}
          </div>
          {/* hover time tooltip */}
          {hover !== null && (
            <div
              className="tnum pointer-events-none absolute -top-7 -translate-x-1/2 rounded bg-black/80 px-1.5 py-0.5 text-[11px] text-white"
              style={{ left: pct(hover) }}
            >
              {timecode(hover)}
            </div>
          )}
        </div>

        {/* Buttons */}
        <div className="flex items-center gap-1 text-white">
          <Ctrl onClick={togglePlay} label={playing ? "Pause (k)" : "Play (k)"}>
            {playing ? <Pause size={18} /> : <Play size={18} />}
          </Ctrl>
          <Ctrl onClick={() => seek((v()?.currentTime ?? 0) - 10)} label="Back 10s (j)">
            <SkipBack size={17} />
          </Ctrl>
          <Ctrl onClick={() => seek((v()?.currentTime ?? 0) + 10)} label="Forward 10s (l)">
            <SkipForward size={17} />
          </Ctrl>
          <Ctrl onClick={() => seek((v()?.currentTime ?? 0) - FRAME)} label="Previous frame (,)">
            <ChevronLeft size={18} />
          </Ctrl>
          <Ctrl onClick={() => seek((v()?.currentTime ?? 0) + FRAME)} label="Next frame (.)">
            <ChevronRight size={18} />
          </Ctrl>

          {/* Volume */}
          <Ctrl onClick={() => v() && (v()!.muted = !v()!.muted)} label="Mute (m)">
            {muted || volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
          </Ctrl>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            onChange={(e) => {
              const el = v();
              if (el) {
                el.volume = Number(e.target.value);
                el.muted = Number(e.target.value) === 0;
              }
            }}
            aria-label="Volume"
            className="h-1 w-16 cursor-pointer accent-[var(--accent)]"
          />

          <span className="tnum ml-2 text-xs text-white/90">
            {timecode(current)} <span className="text-white/50">/ {timecode(duration)}</span>
          </span>

          <div className="ml-auto flex items-center gap-1">
            {/* Speed */}
            <div className="relative">
              <button
                onClick={() => setSpeedOpen((o) => !o)}
                className="flex items-center gap-1 rounded px-2 py-1 text-xs text-white hover:bg-white/15"
                aria-label="Playback speed"
              >
                <Gauge size={16} /> {speed}×
              </button>
              {speedOpen && (
                <div className="absolute bottom-9 right-0 overflow-hidden rounded-md bg-black/90 py-1 text-xs text-white shadow-lg">
                  {SPEEDS.map((s) => (
                    <button
                      key={s}
                      onClick={() => {
                        const el = v();
                        if (el) el.playbackRate = s;
                        setSpeed(s);
                        setSpeedOpen(false);
                      }}
                      className={`block w-20 px-3 py-1.5 text-left hover:bg-white/15 ${s === speed ? "text-[var(--accent)]" : ""}`}
                    >
                      {s}×
                    </button>
                  ))}
                </div>
              )}
            </div>
            <Ctrl onClick={toggleFullscreen} label="Fullscreen (f)">
              {fs ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
            </Ctrl>
          </div>
        </div>
      </div>
    </div>
  );
}

function Ctrl({ onClick, label, children }: { onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex h-8 w-8 items-center justify-center rounded text-white/90 hover:bg-white/15 hover:text-white"
    >
      {children}
    </button>
  );
}
