# Deploying Kisan Direct

This version is a static browser-based demo. It does not use a server, SQL
database, or Vercel Functions. The Vercel build copies `front/index.html` into
`public/` and publishes that directory.

## Deploy to Vercel

1. Import `LalithyaMR/Market`, using the repository root as the project root.
2. Select **Other** as the Framework Preset. The included `vercel.json` sets the
   build command to `npm run build` and output directory to `public`.
3. Deploy. No environment variables or database integration are required.

## Browser-only storage

Accounts, passwords (hashed in the browser), delivery addresses, listings,
product photos, and purchases are stored in IndexedDB in the visitor's browser.
Data is private to that browser on that device: it is not synchronized to other
visitors, farmers, or devices. Clearing the browser's site data removes it.
This is suitable for a demonstration, not a shared production marketplace.

Product photos are resized and compressed in the browser before storage.
