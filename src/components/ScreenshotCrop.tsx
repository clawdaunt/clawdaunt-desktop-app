import React, { useRef, useState, useCallback, useEffect } from 'react';

interface ScreenshotCropProps {
  imageDataUrl: string;
  onCrop: (cropped: { dataUrl: string; base64: string }) => void;
  onCancel: () => void;
}

export default function ScreenshotCrop({ imageDataUrl, onCrop, onCancel }: ScreenshotCropProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [start, setStart] = useState({ x: 0, y: 0 });
  const [end, setEnd] = useState({ x: 0, y: 0 });
  const [imgLoaded, setImgLoaded] = useState(false);

  // Load the image
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      setImgLoaded(true);
    };
    img.src = imageDataUrl;
  }, [imageDataUrl]);

  // Draw the image + selection overlay
  useEffect(() => {
    if (!imgLoaded || !canvasRef.current || !imgRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d')!;
    const img = imgRef.current;

    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;

    // Draw image scaled to fit
    const scale = Math.min(canvas.width / img.width, canvas.height / img.height);
    const drawW = img.width * scale;
    const drawH = img.height * scale;
    const offsetX = (canvas.width - drawW) / 2;
    const offsetY = (canvas.height - drawH) / 2;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, offsetX, offsetY, drawW, drawH);

    // Dark overlay
    if (dragging || (start.x !== end.x && start.y !== end.y)) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Clear the selected region
      const sx = Math.min(start.x, end.x);
      const sy = Math.min(start.y, end.y);
      const sw = Math.abs(end.x - start.x);
      const sh = Math.abs(end.y - start.y);

      if (sw > 2 && sh > 2) {
        ctx.clearRect(sx, sy, sw, sh);
        ctx.drawImage(img, offsetX, offsetY, drawW, drawH);
        // Re-darken outside selection using clip
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, canvas.width, canvas.height);
        ctx.rect(sx, sy, sw, sh);
        ctx.clip('evenodd');
        ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.restore();

        // Selection border
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.strokeRect(sx, sy, sw, sh);
      }
    }
  }, [imgLoaded, dragging, start, end]);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const pos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    setStart(pos);
    setEnd(pos);
    setDragging(true);
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!dragging) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    setEnd({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  }, [dragging]);

  const handleMouseUp = useCallback(() => {
    setDragging(false);
  }, []);

  const handleConfirm = useCallback(() => {
    if (!imgRef.current || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const img = imgRef.current;

    const scale = Math.min(canvas.offsetWidth / img.width, canvas.offsetHeight / img.height);
    const drawW = img.width * scale;
    const drawH = img.height * scale;
    const offsetX = (canvas.offsetWidth - drawW) / 2;
    const offsetY = (canvas.offsetHeight - drawH) / 2;

    // Convert canvas coords to image coords
    const sx = Math.min(start.x, end.x);
    const sy = Math.min(start.y, end.y);
    const sw = Math.abs(end.x - start.x);
    const sh = Math.abs(end.y - start.y);

    const imgX = Math.max(0, (sx - offsetX) / scale);
    const imgY = Math.max(0, (sy - offsetY) / scale);
    const imgW = Math.min(img.width - imgX, sw / scale);
    const imgH = Math.min(img.height - imgY, sh / scale);

    if (imgW < 5 || imgH < 5) return;

    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = imgW;
    cropCanvas.height = imgH;
    cropCanvas.getContext('2d')!.drawImage(img, imgX, imgY, imgW, imgH, 0, 0, imgW, imgH);

    const dataUrl = cropCanvas.toDataURL('image/png');
    const base64 = dataUrl.split(',')[1];
    onCrop({ dataUrl, base64 });
  }, [start, end, onCrop]);

  // Escape to cancel
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter') handleConfirm();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onCancel, handleConfirm]);

  const hasSelection = Math.abs(end.x - start.x) > 5 && Math.abs(end.y - start.y) > 5 && !dragging;

  return (
    <div className="screenshot-crop-overlay">
      <div className="screenshot-crop-header">
        <span>Drag to select a region — Enter to confirm, Esc to cancel</span>
        <div className="screenshot-crop-actions">
          {hasSelection && (
            <button className="screenshot-crop-btn confirm" onClick={handleConfirm}>
              Crop & Attach
            </button>
          )}
          <button className="screenshot-crop-btn" onClick={() => {
            // Attach full screenshot
            const dataUrl = imageDataUrl;
            const base64 = dataUrl.split(',')[1];
            onCrop({ dataUrl, base64 });
          }}>
            Full Screen
          </button>
          <button className="screenshot-crop-btn cancel" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
      <canvas
        ref={canvasRef}
        className="screenshot-crop-canvas"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
      />
    </div>
  );
}
