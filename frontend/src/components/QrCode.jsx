import React, { useRef } from 'react';
import { QRCodeCanvas } from 'qrcode.react';

/**
 * The QR code for a document. It carries only pointers (content hash, chain, contract), never personal data. Print or attach it to the
 * certificate; verification re-reads the document itself and requires it to match the code, so copying the code onto a forgery fails.
 */
export default function QrCode({ payload, size = 192, filename = 'document-qr.png' }) {
  const holder = useRef(null);
  if (!payload) return null;
  const download = () => {
    const canvas = holder.current?.querySelector('canvas');
    if (!canvas) return;
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = filename;
    a.click();
  };
  return (
    <div ref={holder} className="inline-flex flex-col items-center gap-2">
      <QRCodeCanvas value={payload} size={size} includeMargin level="M" role="img" aria-label="QR code for this document" />
      <button type="button" onClick={download} className="text-sm btn-secondary px-3 py-1 rounded-lg font-semibold hover:bg-white">Download QR code</button>
    </div>
  );
}
