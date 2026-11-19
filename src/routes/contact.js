import express, { Router } from 'express';
import { contactSchema } from '../services/contact/schema.js';
import { submitContact } from '../services/contact/submitContact.js';
import { contactLimiter } from '../middleware/rateLimits.js';
import { wantsJson, errorBody } from '../middleware/errors.js';

export function contactRoutes({ store, mailer, config }) {
  const router = Router();
  const body = [express.json({ limit: '20kb' }), express.urlencoded({ extended: false, limit: '20kb' })];

  router.post('/api/contact', contactLimiter(), ...body, async (req, res, next) => {
    try {
      const json = wantsJson(req);
      const input = req.body ?? {};

      // Honeypot: look successful, save and send nothing (TC-CON-03).
      if (typeof input.website === 'string' && input.website !== '') {
        return json ? res.json({ ok: true }) : res.redirect(303, '/?contact=sent#contact');
      }

      const parsed = contactSchema.safeParse(input);
      if (!parsed.success) {
        if (!json) return res.redirect(303, '/?contact=error#contact');
        const fields = {};
        for (const issue of parsed.error.issues) {
          const key = issue.path[0];
          if (key && !fields[key]) fields[key] = issue.message;
        }
        return res
          .status(400)
          .json(errorBody('validation_error', 'Please check the highlighted fields.', fields));
      }

      await submitContact(parsed.data, { store, mailer, config });
      return json ? res.json({ ok: true }) : res.redirect(303, '/?contact=sent#contact');
    } catch (err) {
      next(err);
    }
  });

  return router;
}
