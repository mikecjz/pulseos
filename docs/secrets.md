# Team secrets (Infisical)

PulseOS keeps internal-only team secrets (proxy login, API keys) in the [Infisical](https://infisical.com) project **`pulseos`**, environment **Development** (`dev`). They are never committed: the local copy is a git-ignored `.env` at the repository root, or you inject them per command with `infisical run`.

The secrets are internal to the team. Do not paste their values into issues, PRs, chat, logs or screenshots, and do not share them outside the team.

## What is in it

| Variable | Used for |
| --- | --- |
| `HTTPS_PROXY` | HTTPS proxy (with login) to reach model APIs such as DeepSeek. When it is set, `scripts/dsh.mjs` starts DSH with `NODE_USE_ENV_PROXY=1`, so Node's `fetch` and `node:http(s)` go through the proxy; `localhost`, `127.0.0.1` and `::1` bypass it unless you set `NO_PROXY` yourself. |

`.env.example` lists the variable names without values.

## One-time setup

1. **Get access.** Ask Junzhou (Mike) to invite your email to the Infisical organization and add you to the `pulseos` project. Accept the email invite and create your Infisical account (US cloud, `app.infisical.com`).
2. **Install the CLI** (a recent version reads the committed `.infisical.yaml`):
   - macOS: `brew install infisical/get-cli/infisical`
   - Debian/Ubuntu (e.g. Recon3): `curl -1sLf 'https://artifacts-cli.infisical.com/setup.deb.sh' | sudo -E bash && sudo apt-get update && sudo apt-get install -y infisical`
   - Other platforms, or no sudo: see the [CLI install docs](https://infisical.com/docs/cli/overview).
3. **Log in:** `infisical login`, choose Infisical Cloud (US). On a headless server such as Recon3 the CLI prints a URL to open in your laptop's browser; or use `infisical login --interactive` to log in with email and password in the terminal.
4. **Check access** from the repository root (the project is already linked by the committed `.infisical.yaml`, so no `infisical init` is needed):

   ```sh
   infisical secrets
   ```

   You should see `HTTPS_PROXY` with a masked value.

## Using the secrets

Either pull a `.env` once and run as usual:

```sh
pnpm run secrets:pull   # writes ./.env from the dev environment (git-ignored)
pnpm run web
```

or inject them for a single command, without a file on disk:

```sh
infisical run -- pnpm run web
```

Values from your shell win over `.env`, so you can override one variable for a run, e.g. `HTTPS_PROXY= pnpm run web` to run without the proxy. Run `pnpm run secrets:pull` again after a secret changes.

To check the proxy works without starting PulseOS:

```sh
infisical run -- env NODE_USE_ENV_PROXY=1 node -e "fetch('https://api.deepseek.com/models').then(r => console.log(r.status))"
```

`401` means DeepSeek answered through the proxy (no API key sent); a network error means the proxy or your access is the problem.

## Adding or changing a secret

Use the Infisical web UI (project `pulseos`, environment Development), or from the repository root:

```sh
infisical secrets set NAME=value    # creates or updates in dev
```

Then add the name, without its value, to `.env.example` and the table above. Typing a value on the command line leaves it in your shell history; the web UI avoids that.
