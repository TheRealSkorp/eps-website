# European Puck Series website

A small Node.js site (no dependencies to install) with a public page and an admin page.

## Run it on your own computer

Needs Node.js (nodejs.org, LTS). In this folder:

    node server.js

Open http://localhost:3000 (site) or http://localhost:3000/admin (admin).
Opening `index.html` directly does not work: the data comes from the server.

Locally, the admin password is read from `ADMIN_PASSWORD` or from the file `.admin-password`
(a random one is created on first start).

## Admin

Tabs: Teams, Matches, Players, Staff, Gallery, News, Bracket. Press **Save changes** after editing, or nothing is published.

- **Matches** are grouped into rounds. Add a round, then add matches inside it.
- **News** posts can be pinned and can also show in the slim bar at the very top of the site.
- **Bracket** is the playoff tree (see "Playoff bracket" below).

## Files

| File | What it is |
|---|---|
| `index.html` | The public website |
| `admin.html` | The admin page |
| `server.js` | Serves the site, stores data, handles login and uploads |
| `standings.js` | Standings and bracket calculations, shared by the site and the admin page |
| `data.json` | All content: teams, rounds, matches, players, staff, gallery, news, bracket |
| `uploads/` | Uploaded team logos, staff photos and gallery photos |
| `logo.png` | The EPS logo |
| `hash-password.js` | Makes a hashed admin password for hosting |
| `package.json`, `Dockerfile` | Let hosting services build and start the site |
| `robots.txt` | Keeps /admin and /api out of search engines |
| `.admin-password` | Local admin password. Never put this on GitHub (see `.gitignore`) |

## Standings rules

A match is a series of up to 3 games. First to 2 game wins takes the series.
2-0 win: winner 3 points, loser 0. 2-1 win: winner 2 points, loser 1.
Equal points are split by games won, then head-to-head, then series won, then goal difference.

## Playoff bracket

An 8-team knockout tree: 1v8, 5v4, 3v6, 7v2, then the winners meet, then the final.

1. In the admin open **Bracket** and press **Create the 3 rounds** (Quarterfinals, Semifinals, Final).
2. Enter the playoff matches in the **Matches** tab inside those rounds, like any other match
   (team on the left first, game scores as usual). Winners move forward by themselves.
3. **Seeds 1 to 8 follow the standings table** and update as regular-season results come in.
   Tick **Freeze the seeding** when the regular season ends so they stop moving.
4. Matches in the three playoff rounds never count in the standings table.
5. **Draft until published:** until you tick **Publish**, the bracket, its matches and its round names are
   removed from the data sent to visitors, so only logged-in admins can see them (on the site and in the admin).
   Publishing makes everything public.

If a result belongs to a pairing that no longer exists (for example because the seeds moved after
you entered it), the Bracket tab and the draft page show a warning instead of silently dropping it.

---

# Putting it online

## What the host must offer

1. Run Node.js 18 or newer with `node server.js` (or `npm start`).
2. A **persistent disk / volume**. The site saves content in `data.json` and `uploads/`.
   On hosts without a persistent disk, every restart or redeploy erases your teams, results and photos.
3. HTTPS (every common host gives this automatically).

## Settings (environment variables)

| Name | Value |
|---|---|
| `NODE_ENV` | `production` (the server then refuses to start without a password) |
| `ADMIN_PASSWORD_HASH` | the line printed by `node hash-password.js` (see below) |
| `DATA_DIR` | the folder where the persistent disk is mounted, e.g. `/data` |
| `TRUST_PROXY` | `1` (so login lockouts work per visitor behind the host's proxy) |
| `PORT` | usually set by the host automatically; do not set it unless told to |

`ADMIN_PASSWORD` (plain text) also works, but the hash is safer.

## 1. Make the hashed password (on your computer)

    node hash-password.js

Type a long password (at least 10 characters, a long random one is best). Copy the printed line
that starts with `scrypt$` into the `ADMIN_PASSWORD_HASH` setting. The password itself is never stored.
Save the password in a password manager: it cannot be recovered from the hash.

## 2. Put the code on GitHub (private repository)

Upload this whole folder. `.admin-password` is ignored automatically.
`data.json` and `uploads/` are included on purpose: on first start the server copies them onto the
persistent disk, so the site goes live with your current content.

## 3. Create the service

Railway, Render and similar services: create a new web service from the GitHub repository.

- Build command: none (nothing to install)
- Start command: `node server.js`
- Add a persistent disk/volume and mount it at `/data`
- Add the settings from the table above (`DATA_DIR=/data`)

Fly.io, a VPS or any Docker host: use the included `Dockerfile` and mount a volume at `/data`.

When it is live, check these:
- `https://YOUR-ADDRESS/healthz` shows `ok`
- the site shows your teams and logos
- `https://YOUR-ADDRESS/admin` lets you log in with your password

## 4. Your own domain (optional)

Buy a domain, add it in the host's "custom domain" settings, and create the DNS record the host shows you.

## Updating the live site

- **Content** (teams, results, photos): use `/admin` on the live site. It is saved on the persistent disk.
- **Design or code changes**: push the new files to GitHub. The host redeploys, and the disk keeps your content.
  The bundled `data.json` is only used the very first time (when the disk is empty), so redeploying never overwrites live content.

## Backups

All content lives in `DATA_DIR`: `data.json` and the `uploads/` folder. Download a copy now and then
(most hosts let you open a shell or download the volume). Locally, copy those two items.

## Security notes

- Only the admin can change data or upload; uploads are checked to be real images.
- 5 wrong passwords lock the login for 5 minutes (per visitor).
- Sessions last 12 hours. Restarting the server logs everyone out.
- The page sends a Content-Security-Policy, HSTS (over HTTPS) and other standard security headers.
