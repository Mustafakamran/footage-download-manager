import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, MessageSquarePlus, Trash2, Check, FileDown, Loader2, AlertCircle, Clock, Lock, Unlock } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { useApp, type ReviewTarget } from "../store/app";
import { useReview, fileKey, type FileReview } from "../store/review";
import { useAccountMeta, prettyLabel } from "../store/account-meta";
import { useToasts } from "../store/toast";
import { writeBinaryFile } from "../lib/tauri/commands";
import { streamUrl, hlsMasterUrl, sourceParams, isPlayable, timecode } from "../lib/review";
import { streamMode } from "../lib/tauri/commands";
import { ReviewPlayer } from "./ReviewPlayer";
import { Button } from "./ui";

const EMPTY_REVIEW: FileReview = { status: "in_progress", comments: [] };

export function ReviewView({ accountId, target }: { accountId: string; target: ReviewTarget }) {
  const setView = useApp((s) => s.setView);
  const account = useApp((s) => s.accounts.find((a) => a.id === accountId));
  const review = useReview((s) => s.byFile[fileKey(accountId, target.path)]) ?? EMPTY_REVIEW;
  const addComment = useReview((s) => s.addComment);
  const removeComment = useReview((s) => s.removeComment);
  const setStatus = useReview((s) => s.setStatus);
  const toast = useToasts((s) => s.push);
  const displayLabel = useAccountMeta((s) => s.byId[accountId]?.label) ?? prettyLabel(account?.label ?? "");
  const email = useAccountMeta((s) => s.byId[accountId]?.email);

  const videoRef = useRef<HTMLVideoElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [hlsUrl, setHlsUrl] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [duration, setDuration] = useState(0);
  const [curTime, setCurTime] = useState(0);
  const [locked, setLocked] = useState(false);
  const [lockedTime, setLockedTime] = useState(0);
  const [noCors, setNoCors] = useState(false);
  const [diag, setDiag] = useState("");
  const [text, setText] = useState("");
  const [exporting, setExporting] = useState(false);

  const playable = isPlayable(target.name);
  const parent = target.path.includes("/") ? target.path.slice(0, target.path.lastIndexOf("/")) : "";
  const stampTime = locked ? lockedTime : curTime;

  useEffect(() => {
    if (!playable) return;
    let alive = true;
    setUrl(null);
    setHlsUrl(null);
    setErr("");
    setDiag("");
    setNoCors(false);
    // Build the direct /media URL, then ask the backend whether this clip is
    // already directly playable (H.264/AAC). If so, we DON'T transcode — the
    // player streams /media directly (instant, no ffmpeg, no load lag). Only when
    // it actually needs transcoding (ProRes/HEVC/VP9/etc.) do we hand it the HLS
    // master URL. The player still falls back to direct on any HLS failure.
    streamUrl(accountId, target)
      .then(async (u) => {
        if (!alive) return;
        setUrl(u);
        let mode: "direct" | "hls" = "hls";
        try {
          mode = await streamMode(sourceParams(accountId, target));
        } catch {
          mode = "hls";
        }
        if (!alive) return;
        if (mode === "hls") {
          setHlsUrl(await hlsMasterUrl(accountId, target));
        }
        // else leave hlsUrl null → ReviewPlayer uses the direct /media source.
        // Background-probe the direct /media URL only to capture a real error
        // message we can surface IF playback fails — never block playback on it.
        fetch(u)
          .then(async (res) => {
            if (!res.ok) {
              const body = await res.text().catch(() => "");
              if (alive) setDiag(`Stream error ${res.status}${body ? ` — ${body.slice(0, 300)}` : ""}`);
            } else {
              res.body?.cancel?.();
            }
          })
          .catch(() => {
            /* probe blocked (e.g. fetch CORS) — ignore; the video may still play */
          });
      })
      .catch((e) => alive && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [accountId, target, playable]);

  const comments = useMemo(() => [...review.comments].sort((a, b) => a.time - b.time), [review.comments]);

  function submit() {
    if (!text.trim()) return;
    const t = locked ? lockedTime : videoRef.current?.currentTime ?? curTime;
    addComment(accountId, target.path, t, text.trim());
    setText("");
  }
  function toggleLock() {
    if (locked) setLocked(false);
    else {
      setLockedTime(videoRef.current?.currentTime ?? curTime);
      setLocked(true);
    }
  }
  function seekTo(t: number) {
    const v = videoRef.current;
    if (v) {
      v.currentTime = t;
      v.play().catch(() => {});
    }
  }

  async function exportPdf() {
    setExporting(true);
    try {
      const { jsPDF } = await import("jspdf");
      const doc = new jsPDF({ unit: "pt", format: "a4" });
      const pageW = doc.internal.pageSize.getWidth();
      const pageH = doc.internal.pageSize.getHeight();
      const margin = 40;
      let y = margin;

      doc.setFont("helvetica", "bold");
      doc.setFontSize(16);
      doc.text("FDM — Review notes", margin, y);
      y += 22;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      doc.setTextColor(90);
      doc.text(target.name, margin, y);
      y += 14;
      doc.text(`${displayLabel}${email ? "  ·  " + email : ""}`, margin, y);
      y += 14;
      doc.text(
        `${review.status === "reviewed" ? "Reviewed" : "In review"}  ·  ${comments.length} comment${
          comments.length === 1 ? "" : "s"
        }  ·  ${new Date().toLocaleString()}`,
        margin,
        y,
      );
      y += 12;
      doc.setDrawColor(220);
      doc.line(margin, y, pageW - margin, y);
      y += 18;
      doc.setTextColor(20);

      const video = videoRef.current;
      const canvas = document.createElement("canvas");
      const imgW = pageW - margin * 2;

      for (let i = 0; i < comments.length; i++) {
        const c = comments[i];
        const frame = video && playable ? await grabFrame(video, canvas, c.time) : null;
        const imgH = frame ? imgW * (canvas.height / canvas.width) : 0;
        const lines = doc.splitTextToSize(c.text, imgW);
        const blockH = 18 + imgH + 8 + lines.length * 13 + 18;
        if (y + blockH > pageH - margin) {
          doc.addPage();
          y = margin;
        }
        doc.setFont("helvetica", "bold");
        doc.setFontSize(11);
        doc.text(`${i + 1}.   ${timecode(c.time)}`, margin, y);
        y += 14;
        if (frame) {
          doc.addImage(frame, "JPEG", margin, y, imgW, imgH);
          y += imgH + 8;
        }
        doc.setFont("helvetica", "normal");
        doc.setFontSize(10);
        doc.text(lines, margin, y + 4);
        y += lines.length * 13 + 18;
      }
      if (comments.length === 0) {
        doc.setFontSize(11);
        doc.text("No comments recorded.", margin, y);
      }

      const b64 = bufToBase64(doc.output("arraybuffer"));
      const fname = `${target.name.replace(/\.[^.]+$/, "")} — review.pdf`;
      const path = await save({ defaultPath: fname, filters: [{ name: "PDF", extensions: ["pdf"] }] });
      if (path) {
        await writeBinaryFile(path, b64);
        toast("Review PDF exported", "success");
      }
    } catch (e) {
      toast(`Export failed: ${e}`, "error");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-[var(--border)] px-5 py-3">
        <button
          onClick={() => setView({ kind: "browse", accountId, section: "all", path: parent })}
          className="flex items-center gap-1 text-sm text-[var(--text-2)] hover:text-[var(--text)]"
        >
          <ChevronLeft size={16} /> Back
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-[var(--text)]">{target.name}</div>
          <div className="truncate text-xs text-[var(--text-3)]">{displayLabel}{email ? ` · ${email}` : ""}</div>
        </div>
        {review.status === "reviewed" ? (
          <span className="flex items-center gap-1.5 rounded-full bg-[var(--success)]/15 px-3 py-1 text-xs font-medium text-[var(--success)]">
            <Check size={13} /> Reviewed
          </span>
        ) : (
          <Button variant="ghost" onClick={() => { setStatus(accountId, target.path, "reviewed"); toast("Marked as reviewed", "success"); }}>
            <Check size={15} /> Mark reviewed
          </Button>
        )}
        <Button variant="primary" onClick={exportPdf} disabled={exporting}>
          {exporting ? <Loader2 size={15} className="animate-spin" /> : <FileDown size={15} />} Export PDF
        </Button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Player */}
        <div className="flex min-w-0 flex-1 flex-col bg-black/30 p-4">
          {!playable ? (
            <Fallback
              title="Can't preview this format in-app"
              body={`.${target.name.split(".").pop()} (ProRes / RAW / MXF and similar pro codecs can't play in the app). Download it to review in your editor — comments here still export to PDF.`}
            />
          ) : err ? (
            <Fallback title="Couldn't load the video" body={err} />
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="relative flex min-h-0 flex-1 items-center justify-center">
                {url ? (
                  <ReviewPlayer
                    videoRef={videoRef}
                    src={url}
                    hlsSrc={hlsUrl}
                    noCors={noCors}
                    comments={comments}
                    duration={duration}
                    onDuration={setDuration}
                    onTime={setCurTime}
                    onError={() => {
                      // First failure may be the CORS handshake (needed only for PDF
                      // frame-capture) — retry without it so playback still works.
                      if (!noCors) setNoCors(true);
                      else
                        setErr(
                          diag ||
                            "The player couldn't decode this file — likely a pro codec (ProRes/RAW). Download it to review in your editor.",
                        );
                    }}
                  />
                ) : (
                  <div className="flex items-center gap-2 text-sm text-[var(--text-2)]">
                    <Loader2 size={16} className="animate-spin" /> Opening stream…
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Comments panel */}
        <div className="flex w-[340px] shrink-0 flex-col border-l border-[var(--border)]">
          <div className="border-b border-[var(--border)] px-4 py-3 text-sm font-medium text-[var(--text)]">
            Comments <span className="tnum text-[var(--text-3)]">· {comments.length}</span>
          </div>

          <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
            {comments.length === 0 ? (
              <p className="px-1 py-6 text-sm text-[var(--text-3)]">
                Play the video and type a note below — the timestamp is captured automatically.
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {comments.map((c, i) => (
                  <li key={c.id} className="group rounded-[8px] border border-[var(--border)] bg-[var(--card)] p-2.5">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => seekTo(c.time)}
                        className="tnum flex items-center gap-1 rounded-[5px] bg-[var(--hover)] px-1.5 py-0.5 text-xs font-medium text-[var(--accent)] hover:bg-[var(--accent)] hover:text-[var(--accent-ink)]"
                      >
                        <Clock size={11} /> {timecode(c.time)}
                      </button>
                      <span className="text-[11px] text-[var(--text-3)]">#{i + 1}</span>
                      <button
                        onClick={() => removeComment(accountId, target.path, c.id)}
                        aria-label="Delete comment"
                        className="ml-auto text-[var(--text-3)] opacity-0 hover:text-[var(--error)] group-hover:opacity-100"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                    <p className="mt-1.5 whitespace-pre-wrap break-words text-sm text-[var(--text)]">{c.text}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Composer */}
          <div className="border-t border-[var(--border)] p-3">
            <div className="mb-2 flex items-center gap-2 text-xs text-[var(--text-3)]">
              <MessageSquarePlus size={13} />
              <span>
                Comment at <span className="tnum font-medium text-[var(--accent)]">{timecode(stampTime)}</span>
              </span>
              <button
                onClick={toggleLock}
                title={locked ? "Pinned — click to follow the playhead" : "Following the playhead — click to pin this time"}
                className={`ml-auto flex items-center gap-1 ${locked ? "text-[var(--accent)]" : "hover:text-[var(--text)]"}`}
              >
                {locked ? <Lock size={12} /> : <Unlock size={12} />} {locked ? "Pinned" : "Live"}
              </button>
            </div>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder="Type a review note… (⌘/Ctrl+Enter to add)"
              rows={3}
              className="focus-accent w-full resize-none rounded-[8px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] placeholder:text-[var(--text-3)]"
            />
            <div className="mt-2 flex items-center justify-end">
              <Button variant="primary" onClick={submit} disabled={!text.trim()}>
                Add comment
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Fallback({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-center">
      <AlertCircle size={28} className="text-[var(--text-3)]" />
      <div className="text-sm font-medium text-[var(--text)]">{title}</div>
      <p className="max-w-md text-xs text-[var(--text-3)]">{body}</p>
    </div>
  );
}

/** Seek the video to `time` and grab the frame as a JPEG data URL (null on failure). */
function grabFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement, time: number): Promise<string | null> {
  return new Promise((resolve) => {
    const done = (val: string | null) => {
      video.removeEventListener("seeked", onSeeked);
      resolve(val);
    };
    const onSeeked = () => {
      try {
        const vw = video.videoWidth || 960;
        const vh = video.videoHeight || 540;
        const w = Math.min(960, vw);
        canvas.width = w;
        canvas.height = Math.round((vh / vw) * w);
        const ctx = canvas.getContext("2d");
        if (!ctx) return done(null);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        done(canvas.toDataURL("image/jpeg", 0.72));
      } catch {
        done(null); // tainted canvas / decode error
      }
    };
    video.addEventListener("seeked", onSeeked);
    try {
      video.currentTime = time;
    } catch {
      done(null);
    }
  });
}

function bufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
