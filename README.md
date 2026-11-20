# liaisa
Agentic liaison for small businesses: finds new clients and turns enquiries into approved quotes. Built with Claude and GoDaddy

## Owner login (M4)
1. `npm run hash-password` and type a password (hidden). Copy the printed hash.
2. In `.env` set `OWNER_PASSWORD_HASH='<hash>'` (keep the single quotes: the hash contains `$`) and `SESSION_SECRET` (32+ random characters, e.g. `openssl rand -base64 48`).
3. Set both or neither. With neither, `/owner/*` returns 503 "Owner area isn't set up yet."; with only one, the app refuses to start.

Data (enquiries, estimates, settings) is in memory and re-seeded with the Mehfil Kitchen demo on every start, until MySQL repos replace it. Owner sessions are in memory too.
