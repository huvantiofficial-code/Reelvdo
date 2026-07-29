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
  /** When true, the URL is an embeddable iframe (YouTube /embed/, FB
   *  /plugins/video.php, IG /reel/{id}/embed/, Telegram ?embed=1, VK
   *  video_ext.php, Twitter platform.twitter.com/embed). Render via
   *  `<iframe>` instead of `<video>`. */
  embeddable?: boolean;
}

type LoadState = "loading" | "ready" | "error";

export function VideoPlayer({ url, type, poster, title, pageUrl, embeddable }: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [errMsg, setErrMsg] = useState("");

  // For embeddable iframes, render an `<iframe>` directly. The URL is the
  // official embed endpoint (YouTube /embed/, FB /plugins/video.php, etc.)
  // which serves an HTML player. We don't proxy it — the iframe loads the
  // embed URL directly from the host (which sets its own cookies/CORS).
  const isEmbeddableIframe = embeddable === true && type === "iframe";

  // Resolve the playable URL through our proxy/playlist endpoints.
  // Pass an explicit `kind` hint so the backend treats URLs without the
  // standard .m3u8/.mpd extension as playlists (e.g. playmate.to uses
  // .txt for HLS master/variant playlists).
  // NOTE: Only computed when NOT an embeddable iframe (the iframe path
  // doesn't need a proxy URL).
  const playable = isEmbeddableIframe
    ? ""
    : (() => {
        const page = pageUrl ? `&page=${encodeURIComponent(pageUrl)}` : "";
        if (type === "m3u8") return `/api/playlist?url=${encodeURIComponent(url)}${page}&kind=m3u8`;
        if (type === "mpd") return `/api/playlist?url=${encodeURIComponent(url)}${page}&kind=mpd`;
        return `/api/proxy?url=${encodeURIComponent(url)}${page}`;
      })();

  useEffect(() => {
    // Skip the video-element effect for embeddable iframes — they render
    // via `<iframe>` and don't need hls.js/dash.js/proxy setup.
    if (isEmbeddableIframe) return;
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
  }, [url, type, isEmbeddableIframe, playable]);

  // Embeddable iframe render path.
  if (isEmbeddableIframe) {
    return (
      <div className="relative w-full overflow-hidden rounded-md bg-black">
        <div className="aspect-video w-full">
          <iframe
            ref={iframeRef}
            src={url}
            title={title || "Embedded player"}
            className="h-full w-full border-0 bg-black"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
            onLoad={() => setState("ready")}
          />
        </div>
        {state === "loading" && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/40">
            <div className="flex items-center gap-2 text-white/90 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Loading embed…</span>
            </div>
          </div>
        )}
      </div>
    );
  }

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
