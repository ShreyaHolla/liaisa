// "Share your enquiry link" card: the link, a WhatsApp share link and a QR code.
// The QR is generated here, as inline SVG, with the `qrcode` package. No external service is called.
import QRCode from 'qrcode';

export const enquiryUrl = (config) => `${config.baseUrl.replace(/\/$/, '')}/enquire`;
export const waShareLink = (url) => `https://wa.me/?text=${encodeURIComponent(`Tell us about your event and get a quote: ${url}`)}`;

/** SVG markup for the QR, or null if the link is too long to encode. Plum-black on white, quiet zone of 2 modules. */
export async function qrSvg(url) {
  try {
    return await QRCode.toString(url, { type: 'svg', margin: 2, errorCorrectionLevel: 'M', color: { dark: '#1e1a24', light: '#ffffff' } });
  } catch {
    return null;
  }
}

/** A standalone file for printing: the same SVG with a size. */
export const downloadSvg = (svg) => svg.replace('<svg ', '<svg width="512" height="512" ');

/** Built once per app (the base URL doesn't change while it runs). */
export function makeShare(config) {
  let pending;
  return () => {
    pending ??= (async () => {
      const url = enquiryUrl(config);
      return { url, waLink: waShareLink(url), qrSvg: await qrSvg(url) };
    })();
    return pending;
  };
}
