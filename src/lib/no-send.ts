// Leo, Oct 6 2026: "no emails should be sent out". A hard stop in code,
// checked at the last step of every send path (the outreach mailbox via
// Gmail or SMTP, and the ops mailbox), so no button, cron or public form
// can send anything while it's on. Drafting, Gmail compose links, Copy
// and everything else keep working. Turning sending back on means
// changing this line — only with Leo's say-so.
// Guarded by `node scripts/test-no-send.mjs`.
export const EMAIL_SENDING_OFF = true

export const NO_SEND_MESSAGE =
  'Email sending is turned off — nothing is sent from the dashboard. Copy the text or use Open in Gmail and send it yourself.'

export function assertSendingAllowed(): void {
  if (EMAIL_SENDING_OFF) throw new Error(NO_SEND_MESSAGE)
}
