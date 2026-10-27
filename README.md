# DMAIC Studio

A DMAIC project-management workspace based on the supplied screen references. The app includes a project portfolio, phase overview, and the Define, Measure, Analyze, Improve, and Control tabs shown in the references.

DMAIC Studio is a Rust web server (axum + SQLite) with a browser frontend. Users sign in with an account, their projects are stored in one SQLite database on the server, and a project owner can share a project with other users.

## Run with Docker

```sh
docker build -t dmaic-studio .
docker run -d --name dmaic-studio -p 8124:8124 -v dmaic-data:/data dmaic-studio
```

Open [http://localhost:8124/](http://localhost:8124/). On a new server, the first visitor sees **Set up DMAIC Studio** and creates the administrator account by choosing a username and password (entered twice to confirm). Until that is done, nobody else can sign up. New accounts start with a sample injection-molding project, which can be deleted (or turned off in **Administration → Site settings**).

The database lives in the `dmaic-data` volume at `/data/dmaic.sqlite`, so it survives container upgrades. The container runs as an unprivileged user.

## Run without Docker

Install Rust from [rustup.rs](https://rustup.rs) (on Windows this also needs the Visual Studio C++ build tools). Then, from this folder:

```sh
cargo run --release
```

The server serves the `web/` folder and creates `data/dmaic.sqlite` on first start. SQLite is compiled into the binary, so nothing else needs to be installed. For a deployment, copy the binary from `target/release/` together with the `web/` folder.

## Deploy to a server with HTTPS

The `deploy/` folder runs DMAIC Studio behind [Caddy](https://caddyserver.com), which gets and renews a free HTTPS certificate automatically. Images are built by GitHub Actions, so the server never compiles anything.

**How updates flow:** push to `main` → the **Docker image** workflow builds and publishes `ghcr.io/deg333/dmaic` (about 5 minutes; check the repository's **Actions** tab) → on the server, run `./deploy.sh`.

### One-time setup

1. **A domain name.** Create a DNS `A` record pointing your domain (for example `dmaic.yourcompany.com`) at the server's IP address. Caddy needs a name, not a bare IP, to get a trusted certificate.
2. **Open ports 80 and 443** in the server's firewall. Port 8124 no longer needs to be reachable; close it once the new setup is running.
3. **Let the server download the image.** After the first workflow run, open the `dmaic` package on GitHub (your profile → **Packages**) → **Package settings** → **Change visibility** → **Public**. Alternatively keep it private and, on the server, run `docker login ghcr.io -u deg333` with a GitHub personal access token that has the `read:packages` scope.
4. **On the server** (Linux with Docker and the Compose plugin):

   ```sh
   git clone https://github.com/deg333/DMAIC.git
   cd DMAIC/deploy
   cp .env.example .env
   nano .env                 # set DMAIC_DOMAIN
   ./deploy.sh --stop-old
   ```

   `--stop-old` is only needed the first time, if DMAIC Studio is already running from a plain `docker run` command. The script stops that container (it is kept, not deleted) and takes over the same `dmaic-data` volume, so all accounts and projects carry over.

### Updating

```sh
ssh you@your-server 'DMAIC/deploy/deploy.sh'
```

Each run updates the deploy files from GitHub, pulls the newest image, backs up the database, restarts the app and Caddy, and waits until the app reports healthy. The site is unavailable for a few seconds during the restart. Database upgrades run automatically when the new version starts.

### Backups and rolling back

Every deploy saves a copy of the database to `backups/` inside the `dmaic-data` volume and keeps the newest 10 (`KEEP_BACKUPS` in `.env`). Copy them off the server regularly, because they live on the same disk. To take one at any time:

```sh
docker compose exec app dmaic-studio backup /data/backups/manual.sqlite
```

To run an earlier version, find its `sha-…` tag under the package's versions on GitHub, set `DMAIC_IMAGE=ghcr.io/deg333/dmaic:sha-1a2b3c4` in `.env`, and run `./deploy.sh` again. If you also need the data from before an update, restore the backup taken just before it:

```sh
docker compose stop app
docker compose run --rm --no-deps --entrypoint sh app -c \
  'cp /data/backups/dmaic-20261027-041236.sqlite /data/dmaic.sqlite && rm -f /data/dmaic.sqlite-wal /data/dmaic.sqlite-shm'
docker compose start app
```

### Useful commands (run in `DMAIC/deploy`)

| Command | Purpose |
| --- | --- |
| `docker compose ps` | Show whether the app and Caddy are running and healthy |
| `docker compose logs -f app` | Follow the app log |
| `docker compose logs caddy` | See certificate or proxy problems |
| `docker compose exec app dmaic-studio reset-password <username>` | Recover an account |

## Configuration

All settings are environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DMAIC_BIND` | `0.0.0.0:8124` | Address and port to listen on. |
| `DMAIC_DB` | `data/dmaic.sqlite` | Path of the SQLite database file. The folder is created if needed. |
| `DMAIC_WEB_DIR` | `web` | Folder containing `index.html` and the frontend assets. |
| `DMAIC_ADMIN_PASSWORD` | unset | For unattended deployments: if set and no administrator exists, one is created at startup with this password and the setup screen is skipped. |
| `DMAIC_ADMIN_USERNAME` | `admin` | Username for the administrator created from `DMAIC_ADMIN_PASSWORD`. |
| `DMAIC_ALLOW_SIGNUP` | `true` | Default for whether people can create their own accounts. **Administration → Site settings** overrides it once saved. |
| `DMAIC_SIGNUP_CODE` | unset | Default sign-up code. **Administration → Site settings** overrides it once saved. |
| `DMAIC_SECURE_COOKIES` | `false` | Set to `true` when the site is served over HTTPS, so session cookies are only sent over HTTPS. |
| `DMAIC_MAX_IMPORT_MB` | `256` | Largest backup file accepted by **Import database**. |
| `DMAIC_TRUST_PROXY` | `false` | Set to `true` behind a reverse proxy, so sign-in throttling uses the visitor's address from `X-Forwarded-For`. The `deploy/` setup sets this and `DMAIC_SECURE_COOKIES`. |

## Production checklist

- **Serve over HTTPS.** Use the `deploy/` setup above, or put the server behind another reverse proxy that handles TLS and set `DMAIC_SECURE_COOKIES=true` and `DMAIC_TRUST_PROXY=true`. Passwords and session cookies must not travel over plain HTTP.
- **Finish setup right away.** Until the administrator account exists, whoever reaches the site first can create it. Open the site and set it up as soon as you deploy, keep the server private until then, or set `DMAIC_ADMIN_PASSWORD` so the account exists from the start.
- **Control who can sign up.** In **Administration → Site settings**, turn off self sign-up and add users yourself, or require a sign-up code.
- **Back up the database.** `dmaic-studio backup <file>` writes a consistent copy while the server keeps running (`deploy.sh` does this on every update). Do not copy `dmaic.sqlite` directly while the server is running: it uses WAL mode, and the copy can be incomplete.
- **Monitor health.** `GET /api/health` returns `ok` while the server is up. The Docker image's built-in health check uses it, so `docker ps` shows `healthy` or `unhealthy`.

## Administration

Administrators see an **Administration** shield icon in the sidebar. It has two tabs:

- **Users:** add users (leave the password blank to generate one, which is shown once so you can pass it on), reset a user's password to a new generated one, grant or remove administrator rights, disable or re-enable an account, and delete an account. Disabling or resetting signs the user out everywhere. Deleting an account also deletes the projects it owns. You cannot demote, disable, or delete yourself, and the last active administrator cannot be removed.
- **Site settings:** allow or block self sign-up, set a sign-up code, and choose whether new accounts get the sample project.

Passwords are stored only as one-way hashes, so nobody, administrators included, can look up a user's current password. Use **Reset password** instead.

If you are locked out, run one of these on the server (for Docker, prefix with `docker exec dmaic-studio`):

```sh
dmaic-studio reset-password admin     # prints a new random password and re-enables the account
dmaic-studio make-admin <username>    # gives an existing account administrator rights
dmaic-studio backup <file>            # writes a consistent copy of the database
```

## Accounts and sharing

- Passwords are hashed with Argon2id. Sessions use an HttpOnly, SameSite=Lax cookie that lasts 30 days. Signing out ends the session on the server.
- After 10 failed sign-ins for the same username from the same address, further attempts are blocked for 15 minutes.
- Changing the password (**Settings → Account**) signs out the user's other devices.
- A project owner can add other users by username from **Edit project → Team access**. Team members can view and edit every phase, and can leave the project. Only the owner can delete a project or manage its team.
- Profile and preferences are saved per account.

## Moving data in and out

**Export backup** downloads a `.sqlite` file containing every project you own or that has been shared with you, plus your profile and preferences.

**Import database** adds the projects from a backup to your account as new copies, so the same file can be imported more than once without conflicts. It accepts backups from this server and from the earlier browser-only version of DMAIC Studio. To move existing work to the server, open the old version, click **Export backup**, then sign in here and import that file. Profile settings from the backup are only applied where you have not already set them.

## Features

The Define phase includes editable project charters, a stakeholder bench with drag-and-drop power/interest engagement quadrants and communication plans, five-column SIPOC diagrams, segmented voice-of-customer records, draggable affinity cards with keyword grouping suggestions, hierarchical CTQ trees, scored risk logs, uploaded evidence, and a printable phase report.

The Measure **Process Map** tab uses the BPMN.js editor to create and edit BPMN 2.0 process diagrams. Diagrams autosave to the project and can be imported from or exported to `.bpmn` XML files. The BPMN.js browser assets and license are included under `web/vendor/bpmn-js`.

Open **Settings** from the gear icon at the bottom of the left sidebar, or from your avatar in the top bar. Profile, Account, and Preferences are available. Preferences includes date format, sidebar startup behavior, and customizable accent colors for each DMAIC phase. Organization, AI Usage, Security, API Keys, Integrations, and Danger Zone are shown as coming soon.

Evidence files can be up to 10 MB each. Images (PNG, JPEG, GIF, WebP) and PDFs preview in the browser. Other file types are always downloaded rather than opened, so an uploaded file cannot run code in the app.

## Project layout

| Path | Contents |
| --- | --- |
| `src/main.rs` | Configuration, routes, security headers, CSRF check, static file serving |
| `src/auth.rs` | Accounts, password hashing, sessions, sign-in throttling |
| `src/admin.rs` | Administration: users, site settings, admin bootstrap, recovery commands |
| `src/api.rs` | Projects, sharing, phase work items, notes, process maps, Define records, evidence, settings |
| `src/transfer.rs` | Backup export and import |
| `src/db.rs` | Schema and database helpers |
| `src/seed.rs` | Sample project for new accounts |
| `web/` | Frontend (HTML, CSS, JavaScript, BPMN.js) |
| `deploy/` | Docker Compose, Caddy, and `deploy.sh` for running on a server with HTTPS |
| `.github/workflows/docker.yml` | Builds and publishes the Docker image to ghcr.io on every push to `main` |

The API lives under `/api`. Every request that changes data must send the header `X-DMAIC: 1`. Browsers cannot add custom headers to cross-site form posts, so this check blocks cross-site request forgery alongside the SameSite cookie.
