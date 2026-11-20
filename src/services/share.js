// "Share your enquiry link" card: the link, a WhatsApp share link and a QR code.
// The QR is generated here, as inline SVG, with the `qrcode` package. No external service is called.
import QRCode from 'qrcode';

/** A business's public enquiry link: BASE_URL + /b/<slug>/enquire. */
export const enquiryUrl = (config, slug) => `${config.baseUrl.replace(/\/$/, '')}/b/${slug}/enquire`;
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

/** Built once per business (the base URL and slug don't change while the app runs). */
export function makeShare(config, slug) {
  let pending;
  return () => {
    pending ??= (async () => {
      const url = enquiryUrl(config, slug);
      return { url, waLink: waShareLink(url), qrSvg: await qrSvg(url) };
    })();
    return pending;
  };
}
