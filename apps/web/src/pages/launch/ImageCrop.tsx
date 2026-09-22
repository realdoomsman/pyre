import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button } from "../../ui/index.js";

const STAGE = 240;
const OUTPUT = 512;

interface Props {
  file: File;
  busy?: boolean;
  onCrop: (file: File) => void;
  onCancel: () => void;
}

/** Lets the enclosing form apply a crop the user never confirmed (submit with the cropper still open). */
export interface ImageCropHandle {
  crop: () => Promise<File>;
}

/**
 * Square crop: the image covers the stage at its minimum scale, the user zooms and drags,
 * and the visible square is rasterised to 512×512 for upload. Coin images are square
 * everywhere they appear (cards, PONS, explorers), so the crop is the honest preview.
 */
export const ImageCrop = forwardRef<ImageCropHandle, Props>(({ file, busy, onCrop, onCancel }, ref) => {
  const [img, setImg] = useState<{ el: HTMLImageElement; url: string } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    const el = new Image();
    el.onload = () => setImg({ el, url });
    el.src = url;
    return () => {
      URL.revokeObjectURL(url);
      setImg(null);
    };
  }, [file]);

  const render = useRef<() => Promise<File>>(() => Promise.reject(new Error("image not loaded")));
  useImperativeHandle(ref, () => ({ crop: () => render.current() }), []);

  if (!img) return <div className="animate-breathe rounded-card bg-fill-2" style={{ width: STAGE, height: STAGE }} aria-hidden />;
  const { el: image, url } = img;

  const base = STAGE / Math.min(image.naturalWidth, image.naturalHeight);
  const scale = base * zoom;
  const w = image.naturalWidth * scale;
  const h = image.naturalHeight * scale;
  const clampOffset = (o: { x: number; y: number }) => ({
    x: Math.min(0, Math.max(STAGE - w, o.x)),
    y: Math.min(0, Math.max(STAGE - h, o.y)),
  });
  const pos = clampOffset({ x: offset.x - (w - STAGE) / 2, y: offset.y - (h - STAGE) / 2 });

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    setOffset({ x: drag.current.ox + (e.clientX - drag.current.x), y: drag.current.oy + (e.clientY - drag.current.y) });
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  const rasterise = () =>
    new Promise<File>((resolve, reject) => {
      const canvas = document.createElement("canvas");
      canvas.width = OUTPUT;
      canvas.height = OUTPUT;
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("canvas unavailable"));
      const k = OUTPUT / STAGE;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(image, pos.x * k, pos.y * k, w * k, h * k);
      canvas.toBlob((blob) => {
        if (blob) resolve(new File([blob], file.name.replace(/\.[^.]+$/, "") + ".png", { type: "image/png" }));
        else reject(new Error("could not encode the crop"));
      }, "image/png");
    });
  render.current = rasterise;
  const crop = () => {
    rasterise().then(onCrop, () => undefined);
  };

  return (
    <div className="flex flex-col gap-3">
      <div
        role="img"
        aria-label="Crop area — drag to reposition"
        className="relative cursor-grab touch-none select-none overflow-hidden rounded-card border border-line-2 bg-mono-bg active:cursor-grabbing"
        style={{ width: STAGE, height: STAGE }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <img src={url} alt="" draggable={false} className="pointer-events-none absolute max-w-none" style={{ width: w, height: h, left: pos.x, top: pos.y }} />
        <div className="pointer-events-none absolute inset-0 rounded-card ring-1 ring-inset ring-white/10" aria-hidden />
      </div>
      <label className="flex items-center gap-3 text-13 text-ink-2">
        <span className="eyebrow">Zoom</span>
        <input type="range" min={1} max={3} step={0.01} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} className="w-full accent-(--color-accent)" aria-label="Zoom" />
      </label>
      <div className="flex gap-2">
        <Button size="sm" onClick={crop} loading={busy}>
          Use this crop
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          Choose another
        </Button>
      </div>
    </div>
  );
});
