'use strict';

const nodemailer = require('nodemailer');

/**
 * Factory for the mail notification service (feature alerts_monitoring,
 * R26-R28, design.md §6.7).
 *
 * If `smtpConfig?.host` is defined, creates a real `nodemailer` transporter
 * configured from `config.smtp`. Otherwise (SMTP not configured), returns a
 * "no-op" transporter whose `sendMail` resolves immediately without sending
 * anything — this satisfies R28 at the global level (in addition to the
 * per-rule `notify_email` check performed by `alertService`).
 *
 * @param {{ host?: string, port?: number, secure?: boolean, user?: string,
 *           password?: string, from?: string }} [smtpConfig]
 * @returns {{ sendAlertEmail: (opts: { to: string, subject: string, text: string }) => Promise<void> }}
 */
function createMailService(smtpConfig) {
  const isConfigured = Boolean(smtpConfig?.host);

  const from = smtpConfig?.from || 'Issabel Monitor <alerts@localhost>';

  let transporter;
  if (isConfigured) {
    transporter = nodemailer.createTransport({
      host: smtpConfig.host,
      port: smtpConfig.port || 587,
      secure: Boolean(smtpConfig.secure),
      auth: smtpConfig.user
        ? { user: smtpConfig.user, password: smtpConfig.password }
        : undefined,
    });
  } else {
    // No-op transporter: resolves without sending (R28 at global level).
    transporter = {
      sendMail: async () => undefined,
    };
  }

  /**
   * Send a notification e-mail describing an alert.
   *
   * @param {{ to: string, subject: string, text: string }} opts
   * @returns {Promise<void>}
   */
  async function sendAlertEmail({ to, subject, text }) {
    if (!isConfigured) return;
    try {
      await transporter.sendMail({ from, to, subject, text });
    } catch (err) {
      console.error('[mail] sendAlertEmail:', err.message);
      throw err;
    }
  }

  return { sendAlertEmail };
}

module.exports = createMailService;
