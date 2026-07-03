# PPTX Render Worker

Railway service that converts `.pptx` files into per-slide PNG images.

## What it does

1. Receives a `.pptx` file via multipart upload
2. Converts to PDF using LibreOffice (`soffice`)
3. Renders each page to PNG using `pdftoppm`
4. Returns a ZIP archive of slide images

## Required Environment Variables

| Variable            | Description                                              |
|---------------------|----------------------------------------------------------|
| `PPTX_WORKER_SECRET`| Random secret string. Must match the edge function config. |
| `PORT`              | HTTP port (Railway sets this automatically)              |

## Endpoints

- `POST /render` — Upload `.pptx` as `file` field. Returns ZIP of `slide-0.png`, `slide-1.png`, etc.
  - Header: `x-worker-secret: <PPTX_WORKER_SECRET>`
- `GET /health` — Health check

## Deployment

1. Push these files to a GitHub repo
2. Connect the repo in Railway
3. Add `PPTX_WORKER_SECRET` in Railway Variables
4. Deploy
