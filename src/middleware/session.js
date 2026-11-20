import session from 'express-session';

/**
 * One session middleware (and one MemoryStore) shared by /owner and /signup. MemoryStore on purpose: one demo
 * process, and the demo data is in memory too, so a restart resets both. Passing the store explicitly also
 * stops express-session printing its generic production warning; config.notes says it once.
 * The session holds `ownerId` and `businessId` (set at login or signup) and the CSRF token. Nothing else.
 */
export function createSession(config) {
  return session({
    name: 'liaisa.sid',
    secret: config.sessionSecret,
    store: new session.MemoryStore(),
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: config.env === 'production', maxAge: 8 * 60 * 60 * 1000 },
  });
}
