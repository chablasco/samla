# samla: the f*ck facebook event app

Created by Cha Blasco.

A small, design-focused alternative to Facebook events.

1. Create an event with a picture, date, time, place and details.
2. Send the invite link to the people you want there.
3. Guests open the link, write their name and tap **Going** or **Can't go**. No account needed.
4. You follow the replies on your private host page, which refreshes by itself.

Also included: light and dark mode (follows the device, with a switch in the header), a "How it works" page at `/about` for hosts and guests, edit and delete, "Add to calendar" (.ics), link previews with the event picture
(in Messages, WhatsApp, Slack and so on), a fallback poster when there is no picture, dark mode,
and a "Your events" list on the start page (saved in that browser).

## Updating the app

Replace the app folder with the new version and start it again. Events are stored in
`~/samla-data`, outside the app folder, so they are kept. Events saved by older versions
(in a `data` folder inside a `samla...` folder next to the app) are copied over automatically
on start.

## Put it online with Cloudflare (recommended)

This gives the app a public address, like `https://samla.YOUR-NAME.workers.dev`, that works on
every phone. It runs on Cloudflare's free Workers plan; events, replies and pictures are kept in a
Cloudflare D1 database that is created for you. There is no server to look after.

You need: Node 18 or newer (see below) and a free Cloudflare account (https://dash.cloudflare.com/sign-up).

1. Open a terminal in the `samla` folder.
2. Sign in to Cloudflare (a browser window opens; click Allow):
   ```
   npx wrangler login
   ```
3. Put it online:
   ```
   npx wrangler deploy
   ```
   The first time, Cloudflare may ask you to pick a `workers.dev` name for your account.
   Wrangler also creates the `samla` database. When it finishes it prints your address,
   for example `https://samla.cha.workers.dev`. Open it on any phone.
4. To update later, download the new version and run `npx wrangler deploy` again in its folder.
   Your events stay in the database.

Optional:
- **Your own address** such as `events.chablasco.com`: in the Cloudflare dashboard open
  Workers & Pages, then samla, then Settings, then Domains & Routes, and add a custom domain.
  The domain's DNS must be managed by Cloudflare for this.
- **Change the name or credit line:** uncomment the `[vars]` lines in `wrangler.toml` and deploy again.
- **Try it locally the Cloudflare way:** `npx wrangler dev`.

Free plan limits that matter here: 100,000 requests a day, and a 500 MB database (pictures are
resized to well under 2 MB each before upload). For a group of friends that is far more than enough.

## Let others use it

There are two ways:

- **Share your copy:** once it is online (see Cloudflare above), anyone can open the address and create their own events.
  The "How it works" page (`/about`) explains it to both hosts and guests.
- **Give them their own copy:** they download it from https://github.com/chablasco/samla
  (green Code button, then Download ZIP). They follow "Run it locally" below, and can
  change the name with `SITE_NAME` and `SITE_CREDIT`.

The font Inter is included under the SIL Open Font License (`public/fonts/OFL.txt`).

## Do people need to download the zip?

No. Hosts and guests only use a web browser and the address of a copy that is online.
The zip is only for someone who wants to run their own copy.

## Install Node (version 18 or newer)

Check first: open a terminal and run `node --version`. If it shows v18 or higher, you're set.

- **Mac:** download the LTS installer (.pkg) from https://nodejs.org and run it.
  With Homebrew you can also run `brew install node`.
- **Windows:** download the LTS installer (.msi) from https://nodejs.org and run it,
  then open a new PowerShell or Terminal window.
- **Linux:** the version in your package manager may be older than 18. Check with
  `node --version` after installing; if it is too old, follow the instructions for your
  distribution on https://nodejs.org.

## Run it locally

No packages to install.

```
node server.js
```

Open http://127.0.0.1:3000

Settings (environment variables):

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `HOST` | `127.0.0.1` | Interface to listen on |
| `BASE_URL` | from request | Public address, e.g. `https://events.chablasco.com` (used in invite links and previews) |
| `DATA_DIR` | `~/samla-data` | Where events and pictures are stored. Kept outside the app folder so updating the app never loses events |
| `SITE_NAME` | `samla: the f*ck facebook event app` | Name in page titles. Text before `: ` is shown big in the header, text after it as a tagline |
| `DOWNLOAD_URL` | `https://github.com/chablasco/samla` | An https link to the app's files (for example a GitHub page). Shown on the How it works page |
| `SITE_CREDIT` | `created by Cha Blasco` | Small line next to the name (set empty to hide) |
| `SITE_CREDIT_LINK` | `Cha Blasco` | The part of the credit line that becomes a link |
| `SITE_CREDIT_URL` | `https://chablasco.com` | Where that link goes |
| `SITE_CREDIT_URL` | `https://chablasco.com` | The name after "by " links here (set empty for no link) |

## Or run it on your own server (Ubuntu + nginx)

```
# copy the folder to the server, then:
sudo mkdir -p /opt/samla && sudo cp -r . /opt/samla && sudo chown -R www-data /opt/samla
```

`/etc/systemd/system/samla.service`:

```
[Unit]
Description=samla event app
After=network.target

[Service]
WorkingDirectory=/opt/samla
ExecStart=/usr/bin/node server.js
Environment=PORT=3000
Environment=BASE_URL=https://events.example.com
User=www-data
Restart=always

[Install]
WantedBy=multi-user.target
```

```
sudo systemctl enable --now samla
```

nginx site:

```
server {
  server_name events.example.com;
  client_max_body_size 15m;
  access_log off;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Then add HTTPS with `sudo certbot --nginx -d events.example.com`.
Back up the data folder (`~/samla-data` for the user running the app, or what you set in `DATA_DIR`); it holds every event and picture.

With systemd, set `Environment=DATA_DIR=/var/lib/samla` and create that folder owned by `www-data`.

## What the app stores

The app does not collect anything about people: no accounts, no email or phone numbers, no cookies,
no tracking, no analytics, no ads. Fonts and code are served from your own server, so no other
company is contacted when someone opens a page.

It only saves what people type in: event details and picture, and for each reply the name, the
choice and the time. Deleting an event removes its picture and replies. Browsers remember the
visitor's own name and hosted events locally (localStorage).

The app itself writes no request logs. nginx does by default; to keep the promise fully, turn
them off for this site with `access_log off;` in the nginx `server` block.

## How privacy works

- Events are unlisted and their addresses are random, so only people with the link can find them.
  Anyone who gets the link (for example if a guest forwards it) can see the event and reply.
- The host page has a long secret key in its address. Anyone with it can edit the event, so keep it private.
- Guests can change their own reply later from the same browser.

## Known limits of this first version

- No notifications: the host checks the host page to see new replies.
- No accounts, so a host who loses the host link loses edit access (the start page remembers it in that browser).
- No rate limiting. Fine among friends; add it (for example with nginx `limit_req`) before opening it widely.
- Storage is simple files, good for hundreds of events. Move to a database if it grows a lot.
