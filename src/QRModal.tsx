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
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>×</button>
        <h2 className="modal-title">Connect your device</h2>
        <div className="qr-modal-content">
          <div className="qr-container">
            {!tunnelURL ? (
              isRateLimited ? (
                <div className="qr-placeholder">
                  <p className="qr-error-title">Rate limit reached</p>
                  <p className="qr-error-hint">
                    Too many tunnel requests. Please wait a few minutes and try again.
                  </p>
                </div>
              ) : (
                <div className="qr-placeholder">
                  <div className="spinner" />
                  <p>Setting up connection...</p>
                </div>
              )
            ) : (
              <QRCodeSVG value={qrPayload} size={192} level="M" />
            )}
          </div>
          {tunnelURL && <p className="qr-hint">Scan with the Clawdaunt app to connect</p>}
          {errorMsg && !isRateLimited && <div className="error-banner">{errorMsg}</div>}
        </div>
      </div>
    </div>
  );
}
