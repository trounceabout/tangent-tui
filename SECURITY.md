# Security

Tangent logs in to Linear as **you** and can **change issues** (status, priority, estimate), so please treat security reports seriously.

## How your login is handled

- **Browser login (OAuth with PKCE).** `tangent login` sends you to Linear to approve Tangent. There is no client secret anywhere in Tangent or its code: PKCE, a one-time secret made fresh for each login, takes its place.
- **Where it is kept.** The access and refresh tokens are stored in the macOS Keychain (item `tangent-oauth`) and sent only to `https://api.linear.app`. They are never written to a file, an environment variable or a log by this app.
- **What it can do.** Tangent asks for two permissions: `read` and `issues:create` (Linear's name for creating and updating issues). It does not ask for admin access or the broader `write` permission. Tangent itself only changes an issue's status, priority or estimate.
- **How long it lasts.** An access token lasts about 24 hours and renews itself in the background; the refresh token behind it lasts 30 days. Only one Tangent window refreshes at a time (a lock, which holds no secrets), because each refresh replaces the refresh token.
- **Ending it.** `tangent logout` ends the login at Linear and removes it from your Keychain. You can also remove Tangent yourself in Linear (Settings, Security & access, Authorized applications) at any time.
- **The local redirect.** While `tangent login` runs, Tangent listens on `127.0.0.1` (this computer only) on port 8976, 8977 or 8978. It accepts one answer carrying a one-time `state` value, ignores any other request, and shows a fixed page that repeats nothing from the request. It stops listening as soon as the login finishes.
- **API key (fallback).** If you use a personal API key instead (saved in the Keychain as `linear-api-key`, or in `LINEAR_API_KEY`), Tangent reads it the same way, sends it only to Linear, and never writes it. An environment variable is less safe than the Keychain: other programs you run can read it. A browser login is used first when there is one.

## Reporting a problem

Please **don't open a public issue** for a security problem (for example a way to make the app send a change you didn't confirm, leak your key, or run a command through issue text).

Report it privately with GitHub's "Report a vulnerability" button on the repository's Security tab. Include what you did, what you expected, and what happened. You'll get a reply as soon as I can manage; this is a small personal project, so please be patient.

## Staying safe while using it

- Try the screens first with `TANGENT_DRY_RUN=1`. It sends nothing at all.
- Changes are only sent when you press Enter on the confirm screen, never by a click.
- Prefer `tangent login`: it asks only for the access Tangent needs and can be ended with `tangent logout`. If you use a personal API key instead, use one with the narrowest access that works for you.
- If you ever think a login or key leaked, run `tangent logout` and remove Tangent under Authorized applications in Linear, or revoke the API key in Linear (Settings, API).
