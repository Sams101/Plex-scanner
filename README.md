# Plex DB Explorer

Static browser app for exploring a Plex SQLite export.

## What it does

- Uploads a Plex `.db`, `.sqlite`, or `.sqlite3` file in the browser
- Opens and queries the database locally with no backend
- Browses movies, TV shows, artists, albums, tracks, and duplicate music albums
- Supports search, genre/year/library filters, sorting, pagination, and export
- Persists the uploaded database in IndexedDB so the session survives refreshes

## Project Structure

- `frontend/` React/Vite app

## Local setup

```bash
cd frontend
npm install
npm run dev
```

## Production build

```bash
cd frontend
npm run build
```

The Vite build is configured with a relative base path so the generated site can be deployed to GitHub Pages or any other static host.

## Notes

- The app does not contact any server after the page loads.
- Uploading the database is required for each browser profile unless the IndexedDB session is still present.
- Large databases are loaded into browser memory, so performance depends on the size of the Plex export and the browser’s available RAM.
