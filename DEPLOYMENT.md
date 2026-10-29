# Deploying to Vercel

This project exports its Express app from the repository root for Vercel to deploy
as a Node.js Function. The build copies the static frontend from `front/` into
`public/` for Vercel's CDN. The deployment configuration sets Vercel's framework
to **Other**, so it does not try to run an Angular build.

## Required services

The full portal needs:

- A remotely accessible MySQL database. Create a database named `kisan_direct_db`.
  The app creates and updates its tables when the API starts.
- A Vercel Blob store for product photos. Local uploads are stored in
  `back/uploads/`; Vercel's filesystem is temporary, so deployed uploads use Blob.

## Vercel setup

1. Import `LalithyaMR/Market` into Vercel and set the project root to the repository
   root. The included `vercel.json` selects the static output and build command.
2. Create a Vercel Blob store and connect it to the project. This provides
   `BLOB_READ_WRITE_TOKEN` to the function.
3. Add these environment variables for the Production environment (and Preview if
   you also want preview deployments to use the API):

   | Variable | Value |
   | --- | --- |
   | `DB_HOST` | Hostname of your hosted MySQL server |
   | `DB_PORT` | MySQL port, usually `3306` |
   | `DB_USER` | MySQL username |
   | `DB_PASSWORD` | MySQL password |
   | `DB_SSL` | `true` when required by your database provider |
   | `SESSION_SECRET` | A randomly generated secret with at least 32 characters |
   | `BLOB_READ_WRITE_TOKEN` | Provided by the connected Vercel Blob store |

   The database must accept connections from Vercel's serverless functions. Do not
   use `localhost` for `DB_HOST`; that would refer to the function instance.
4. Redeploy after saving the environment variables.

The app's product-photo limit is 4 MB to fit within the request-size limit for
serverless functions. Changing `SESSION_SECRET` signs users out of existing sessions.
