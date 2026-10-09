import React, { useEffect, useRef, useState } from 'react';
import { Html5Qrcode } from 'html5-qrcode';

/**
 * Reads a QR code from a photo, or live from the camera. It only reports the TEXT of the code: the server decides what it means,
 * and a QR code on its own never makes a document authentic (verification recomputes the document's own fingerprint).
 */
export default function QrScanner({ onResult, Scanner = Html5Qrcode }) {
  const elementId = useRef(`qr-reader-${Math.random().toString(36).slice(2, 9)}`);
  const live = useRef(null);
  const [message, setMessage] = useState('');
  const [scanning, setScanning] = useState(false);

  const stop = async () => {
    const s = live.current;
    live.current = null;
    setScanning(false);
    if (s) { try { await s.stop(); } catch { /* already stopped */ } try { s.clear(); } catch { /* nothing to clear */ } }
  };
  useEffect(() => () => { stop(); }, []);   // release the camera when the component goes away

  const fromPhoto = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setMessage('Reading the QR code…');
    try {
      const text = await new Scanner(elementId.current).scanFile(file, false);
      setMessage('QR code read.');
      onResult(text);
    } catch {
      setMessage('No QR code could be read from that picture. Try a closer, sharper photo of the code.');
    }
  };

  const fromCamera = async () => {
    setMessage('');
    try {
      const s = new Scanner(elementId.current);
      live.current = s;
      setScanning(true);
      await s.start({ facingMode: 'environment' }, { fps: 10, qrbox: 220 }, async (text) => { await stop(); setMessage('QR code read.'); onResult(text); }, () => {});
    } catch {
      await stop();
      setMessage('The camera could not be started. Allow camera access, or read the code from a photo instead.');
    }
  };

  return (
    <div>
      <div className="flex flex-wrap gap-2 items-center">
        <label className="text-sm bg-slate-200 text-slate-900 px-3 py-2 rounded-lg font-semibold hover:bg-white cursor-pointer">
          Read QR from a photo
          <input type="file" accept="image/*" className="sr-only" onChange={fromPhoto} />
        </label>
        {!scanning
          ? <button type="button" onClick={fromCamera} className="text-sm bg-slate-200 text-slate-900 px-3 py-2 rounded-lg font-semibold hover:bg-white">Scan with the camera</button>
          : <button type="button" onClick={stop} className="text-sm bg-red-100 text-red-900 px-3 py-2 rounded-lg font-semibold">Stop camera</button>}
      </div>
      <div id={elementId.current} data-testid="qr-reader" className="mt-2" style={{ maxWidth: 300 }} />
      {message && <p role="status" className="text-sm text-slate-600 mt-1">{message}</p>}
    </div>
  );
}
