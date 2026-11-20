// F12: WhatsApp click-to-chat link. No API, no cost; the owner always sends.
import { ValidationError } from '../../errors.js';

/** https://wa.me/<digits>?text=<encoded>. `phone` is digits (a leading + is tolerated). */
export function buildWaLink(phone, text) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (!/^\d{8,15}$/.test(digits)) throw new ValidationError('That phone number cannot be used for WhatsApp.');
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}
