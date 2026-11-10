# Security

Tangent talks to Linear with **your personal API key** and can **change issues** (status, priority, estimate), so please treat security reports seriously.

## How your key is handled

- The key is read from the macOS Keychain (service `linear-api-key`) and sent only to `https://api.linear.app/graphql`.
- It is never written to a file, an environment variable or a log by this app.

## Reporting a problem

Please **don't open a public issue** for a security problem (for example a way to make the app send a change you didn't confirm, leak your key, or run a command through issue text).

Report it privately with GitHub's "Report a vulnerability" button on the repository's Security tab. Include what you did, what you expected, and what happened. You'll get a reply as soon as I can manage; this is a small personal project, so please be patient.

## Staying safe while using it

- Try the screens first with `TANGENT_DRY_RUN=1`. It sends nothing at all.
- Changes are only sent when you press Enter on the confirm screen, never by a click.
- Use a Linear API key with the narrowest access that works for you, and revoke it in Linear (Settings, API) if you ever think it leaked.
