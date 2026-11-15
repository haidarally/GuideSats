// Scan the traveller's QR with the phone camera, where the browser has BarcodeDetector
// (Chrome on Android). Elsewhere the guide pastes or types the code.
import { useEffect, useRef, useState } from "preact/hooks";

type Detector = { detect(src: HTMLVideoElement): Promise<{ rawValue: string }[]> };
const Ctor = (globalThis as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
export const canScan = typeof Ctor === "function" && !!navigator.mediaDevices?.getUserMedia;

export function Scan({ onCode, label }: { onCode: (code: string) => void; label: string }) {
  const [on, setOn] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (!on || !Ctor) return;
    let stop = false;
    let stream: MediaStream | null = null;
    const det = new Ctor({ formats: ["qr_code"] });
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment" } })
      .then(async (s) => {
        stream = s;
        if (!video.current) return;
        video.current.srcObject = s;
        await video.current.play();
        while (!stop) {
          const hit = (await det.detect(video.current).catch(() => [])).find((r) => /^[0-9a-f]{64}$/i.test(r.rawValue.trim()));
          if (hit) {
            onCode(hit.rawValue.trim().toLowerCase());
            setOn(false);
            break;
          }
          await new Promise((r) => setTimeout(r, 300));
        }
      })
      .catch(() => setOn(false));
    return () => {
      stop = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [on]);
  if (!canScan) return null;
  return on ? (
    <video ref={video} class="scan" muted playsInline onClick={() => setOn(false)} />
  ) : (
    <button type="button" class="ghost" onClick={() => setOn(true)}>
      {label}
    </button>
  );
}
