"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { MediaType } from "@/lib/types";

interface PlayerProps {
  url: string;
  type: MediaType;
  poster?: string;
  title?: string;
  pageUrl?: string;
}

type LoadState = "loading" | "ready" | "error";

export function VideoPlayer({ url, type, poster, title, pageUrl }: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [errMsg, setErrMsg] = useState("");

  // Resolve the playable URL through our proxy/playlist endpoints.
  const playable = (() => {
    const page = pageUrl ? `&page=${encodeURIComponent(pageUrl)}` : "";
    if (type === "m3u8") return `/api/playlist?url=${encodeURIComponent(url)}${page}`;
    if (type === "mpd") return `/api/playlist?url=${encodeURIComponent(url)}${page}`;
    return `/api/proxy?url=${encodeURIComponent(url)}${page}`;
  })();

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    setState("loading");
    setErrMsg("");
    let hls: import("hls.js").default | null = null;
    let dashPlayer: import("dashjs").MediaPlayerClass | null = null;
    let cancelled = false;

    const onReady = () => {
      if (!cancelled) setState("ready");
    };
    const onErr = (e: string) => {
      if (!cancelled) {
        setState("error");
        setErrMsg(e);
      }
    };

    if (type === "m3u8") {
      // Native HLS (Safari)
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = playable;
        video.addEventListener("loadedmetadata", onReady, { once: true });
        video.addEventListener("error", () => onErr("Could not load this stream"), { once: true });
      } else {
        import("hls.js")
          .then(({ default: Hls }) => {
            if (cancelled) return;
            if (Hls.isSupported()) {
              hls = new Hls({
                enableWorker: true,
                lowLatencyMode: false,
                backBufferLength: 90,
                xhrSetup: (xhr) => {
                  xhr.withCredentials = false;
                },
              });
              hls.loadSource(playable);
              hls.attachMedia(video);
              hls.on(Hls.Events.MANIFEST_PARSED, onReady);
              hls.on(Hls.Events.ERROR, (_evt, data) => {
                if (data.fatal) {
                  onErr(`Stream error: ${data.details || data.type}`);
                }
              });
            } else {
              onErr("HLS not supported in this browser");
            }
          })
          .catch(() => onErr("Could not load player module"));
      }
    } else if (type === "mpd") {
      import("dashjs")
        .then(({ default: dashjs }) => {
          if (cancelled) return;
          dashPlayer = dashjs.MediaPlayer().create();
          dashPlayer.initialize(video, playable, false);
          dashPlayer.on("streamInitialized", onReady);
          dashPlayer.on("error", () => onErr("Could not load this stream"));
        })
        .catch(() => onErr("Could not load player module"));
    } else {
      // Direct file via proxy.
      video.src = playable;
      video.addEventListener("loadedmetadata", onReady, { once: true });
      video.addEventListener("error", () => onErr("Could not load this file"), { once: true });
    }

    return () => {
      cancelled = true;
      if (hls) {
        hls.destroy();
      }
      if (dashPlayer) {
        try {
          dashPlayer.reset();
        } catch {
          // ignore
        }
      }
    };
  }, [url, type]);

  return (
    <div className="relative w-full overflow-hidden rounded-md bg-black">
      <div className="aspect-video w-full">
        <video
          ref={videoRef}
          controls
          playsInline
          poster={poster}
          className="h-full w-full bg-black"
          preload="metadata"
          title={title}
        />
      </div>
      {state === "loading" && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/40">
          <div className="flex items-center gap-2 text-white/90 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Loading stream…</span>
          </div>
        </div>
      )}
      {state === "error" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/70 p-4 text-center">
          <p className="text-sm text-white/90">Could not play this source.</p>
          <p className="text-xs text-white/50">{errMsg}</p>
          <p className="text-xs text-white/40">Try another quality or the download option.</p>
        </div>
      )}
    </div>
  );
}
