import nodemailer from 'nodemailer';

/** Real SMTP (Titan mailbox). Only built when MAIL_ENABLED=true. */
export function createSmtpMailer({ host, port, user, pass }) {
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return { send: (message) => transporter.sendMail(message) };
}
