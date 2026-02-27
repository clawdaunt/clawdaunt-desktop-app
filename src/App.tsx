import React, { useState, useEffect, useRef } from 'react';
import QRModal from './QRModal';
import WorkspaceConsole from './WorkspaceConsole';

type Status = 'stopped' | 'starting' | 'running' | 'error';
type TunnelHealth = 'healthy' | 'checking' | 'down';

export default function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [status, setStatus] = useState<Status>('stopped');
  const [tunnelURL, setTunnelURL] = useState('');
  const [tunnelHealth, setTunnelHealth] = useState<TunnelHealth>('checking');
  const [clientConnected, setClientConnected] = useState(false);
  const [clientAway, setClientAway] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [qrModalOpen, setQrModalOpen] = useState(false);
  const [gatewayLog, setGatewayLog] = useState<string[]>([]);
  const prevClientConnected = useRef(false);

  useEffect(() => {
    window.api.loadConfig().then(setConfig);
    window.api.getTunnelURL().then((url) => { if (url) setTunnelURL(url); });
    window.api.getTunnelHealth().then((h) => setTunnelHealth(h as TunnelHealth));

    window.api.onStatusUpdate((s) => {
      setStatus(s as Status);
      if (s === 'stopped') setErrorMsg('');
    });
    window.api.onTunnelURL(setTunnelURL);
    window.api.onTunnelHealth((h) => setTunnelHealth(h as TunnelHealth));
    window.api.onError(setErrorMsg);

    window.api.onClientConnected(() => {
      setClientConnected(true);
      setClientAway(false);
    });
    window.api.onClientAway(() => setClientAway(true));
    window.api.onClientDisconnected(() => {
      setClientConnected(false);
      setClientAway(false);
    });

    window.api.onGatewayLog((text) => {
      if (text === '\x1b[2J') {
        setGatewayLog([]);
      } else {
        setGatewayLog((prev) => [...prev, ...text.split('\n')]);
      }
    });

    // Sync config when changed remotely (e.g. mobile switches workspace or AI source)
    window.api.onConfigChanged(setConfig);
  }, []);

  // Auto-open QR modal when tunnel is connecting or ready, and no phone connected
  useEffect(() => {
    if (!clientConnected && (tunnelHealth === 'checking' || tunnelURL)) {
      setQrModalOpen(true);
    }
  }, [tunnelURL, tunnelHealth]);

  // Auto-close QR modal when phone connects
  useEffect(() => {
    if (clientConnected && !prevClientConnected.current) {
      setQrModalOpen(false);
    }
    prevClientConnected.current = clientConnected;
  }, [clientConnected]);

  const qrPayload = tunnelURL
    ? `${tunnelURL}?password=${encodeURIComponent(config?.password ?? '')}`
    : '';

  if (!config) {
    return (
      <div className="console">
        <div className="drag-region" />
        <div className="empty-panel">
          <div className="spinner" />
        </div>
      </div>
    );
  }

  return (
    <>
      <WorkspaceConsole
        config={config}
        status={status}
        tunnelHealth={tunnelHealth}
        clientConnected={clientConnected}
        clientAway={clientAway}
        errorMsg={errorMsg}
        gatewayLog={gatewayLog}
        onConfigUpdate={setConfig}
        onShowQR={() => setQrModalOpen(true)}
      />
      <QRModal
        open={qrModalOpen}
        onClose={() => setQrModalOpen(false)}
        tunnelURL={tunnelURL}
        qrPayload={qrPayload}
        errorMsg={errorMsg}
      />
    </>
  );
}
