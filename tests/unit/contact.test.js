import test from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { cleanName } from '../../src/services/contact/schema.js';
import { buildContactEmail } from '../../src/services/contact/buildEmail.js';

const opts = { from: '"Liaisa" <hello@liaisa.co.in>', to: 'owner@example.test' };

test('TC-CON-06 CR/LF stripped from the name', () => {
  const name = cleanName('Asha\r\nBcc: x@y.com');
  assert.doesNotMatch(name, /[\r\n]/);
});

test('TC-CON-06 injected name adds no header to the built email', async () => {
  const msg = buildContactEmail(
    { name: 'Asha\r\nBcc: x@y.com', email: 'asha@example.test', message: 'Hello' },
    opts,
  );
  assert.doesNotMatch(msg.subject, /[\r\n]/);

  // Compose the real MIME message with nodemailer and inspect only the header block.
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const { message } = await transport.sendMail(msg);
  const headers = message.toString().split('\r\n\r\n')[0];
  assert.doesNotMatch(headers, /^Bcc:/im);
  assert.match(headers, /^Reply-To: .*asha@example\.test/im);
  assert.match(headers, /^To: .*owner@example\.test/im);
});

test('contact email: subject and Reply-To follow DESIGN §7', () => {
  const msg = buildContactEmail({ name: 'Asha', email: 'asha@example.test', message: 'Hi' }, opts);
  assert.equal(msg.subject, 'Website message from Asha');
  assert.equal(msg.replyTo, 'asha@example.test');
  assert.match(msg.text, /Hi/);
});
