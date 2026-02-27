import React from 'react';
import { QRCodeSVG } from 'qrcode.react';

interface QRModalProps {
  open: boolean;
  onClose: () => void;
  tunnelURL: string;
  qrPayload: string;
  errorMsg: string;
}

export default function QRModal({ open, onClose, tunnelURL, qrPayload, errorMsg }: QRModalProps) {
  if (!open) return null;

  const isRateLimited = errorMsg.toLowerCase().includes('rate limit');

  return (
    <div className="qr-modal-backdrop" onClick={onClose}>
      <div className="qr-modal" onClick={(e) => e.stopPropagation()}>
        <button className="qr-modal-close" onClick={onClose}>×</button>
        <h2 className="qr-modal-title">Scan QR code with app</h2>
        <div className="qr-container">
          {!tunnelURL ? (
            isRateLimited ? (
              <div className="qr-placeholder">
                <p className="tunnel-error-msg">Cloudflare rate limit hit</p>
                <p className="tunnel-error-hint">
                  Too many tunnel requests. Please wait a few minutes and retry.
                </p>
              </div>
            ) : (
              <div className="qr-placeholder">
                <div className="spinner" />
                <p>Setting up tunnel...</p>
              </div>
            )
          ) : (
            <QRCodeSVG value={qrPayload} size={192} level="M" />
          )}
        </div>
        {tunnelURL && <p className="scan-hint">Scan with clawdaunt app to connect</p>}
        {errorMsg && !isRateLimited && <p className="error-msg">{errorMsg}</p>}
      </div>
    </div>
  );
}
