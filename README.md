# MintPlayer Cast Receiver

Static Google Cast Custom Web Receiver for MintPlayer. This repository contains only public receiver code; local user media is streamed directly from MintPlayer over the user's LAN.

The receiver bundles SoundTouchJS for pitch shifting. Its LGPL-2.1 license is included in the deployed site as `SOUNDTOUCH-LICENSE.txt`.

## Local build

```powershell
npm install
npm run build
npm run dev
```

Google Cast production receivers must be served from HTTPS. Register the deployed Pages URL as a Custom Receiver in the Google Cast SDK Developer Console, then configure the resulting public App ID in MintPlayer.

## GitHub Pages

Create a separate **public** GitHub repository for these files, push the `main` branch, then open **Settings → Pages** and select **GitHub Actions** as the publishing source. The workflow in `.github/workflows/deploy-pages.yml` builds and deploys the static site on each push to `main`.

The Pages URL is normally `https://<owner>.github.io/<repository>/`. Register that exact URL with Google Cast. The App ID is public configuration, not a secret.

## Network and media

The Receiver page is downloaded from GitHub Pages over HTTPS. Audio, video, cover, and lyric assets are not uploaded to Pages: the desktop app serves only explicitly authorized session files over a temporary, token-protected LAN HTTP endpoint. The Chromecast and PC must be able to reach one another on the same network.
