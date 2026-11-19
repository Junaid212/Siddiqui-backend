/**
 * downloadWindow.js - when a Digital Companion buyer's download links need renewing, and how often that is allowed.
 *
 * Each order has a download window (72 hours from purchase) and 3 downloads PER FILE (Companion Pack and Book PDF each have their own counter).
 * When the window has ended, or either file has used its 3 downloads, the buyer may ask for a fresh window: 72 hours and 3 new downloads of each
 * file. This can be done MAX_DOWNLOAD_RENEWALS times per order (recorded in orders.raw_metadata.download_renewals); after that they contact support.
 * Without this limit "request a replacement" would be a way to download without end.
 */
const MAX_DOWNLOAD_RENEWALS = 3;

const renewalsOf = (order) => (order && order.raw_metadata && typeof order.raw_metadata === "object" && Array.isArray(order.raw_metadata.download_renewals) ? order.raw_metadata.download_renewals : []);

/** True when the window is over or either file has no downloads left. */
function downloadNeedsRenewal(order, now = new Date()) {
  if (!order) return false;
  const limit = Number(order.download_limit) || 3;
  const expired = !!(order.download_expires_at && now > new Date(order.download_expires_at));
  return expired || (Number(order.download_count) || 0) >= limit || (Number(order.book_download_count) || 0) >= limit;
}

module.exports = { MAX_DOWNLOAD_RENEWALS, renewalsOf, downloadNeedsRenewal };
