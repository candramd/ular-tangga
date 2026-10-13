# Ular Tangga static migration and release runbook

Status: **static site and Supabase RPC cutover are live; functional checks pass, while operational release checks remain open.** The runtime is a Next.js static export on GitHub Pages, with browser requests sent to Supabase PostgREST RPC. The prior Go service is stopped; do not restart it alongside the Supabase writer.

## Verification checkpoint — 2026-10-13

Completed evidence:

- The frontend unit suite passed 56/56, the static export built with `/` and `/admin/` entries, and the export scanner found no server-only credential/config markers. The six protected graphics and motion files still match the recorded checksum baseline.
- Go tests pass, including a regression for migrating legacy NUL-delimited local-student roster keys. The migrated snapshot passed a read-only PostgreSQL JSONB cast against the local QA fixture.
- Supabase migrations 002–006 and the board seed are installed. Migration 006 was applied under an advisory transaction lock and a row lock, with snapshot version and state digest checked unchanged across the DDL transaction. Existing browser identity, room, and cumulative ranks were restored through the local bridge before the Go bridge was stopped. Later live play has legitimately changed room/game state; no claim is made that the current digest matches the pre-cutover backup.
- The isolated SQL fixture covers admin and game RPC flows, privacy, replay behavior, and event sequencing.
- After Go stopped and released its writer lock, the browser-facing PostgREST RPC smoke passed with one temporary QA guest, local student, question, room, and game. It verified private answer fields, wrong-turn and locked-dice rejection, ten parallel state/sync reads, correct-answer idempotency and exactly-once score, a dice result in range, ascending event sequences, and an empty poll after the cursor was drained. Existing leaderboard identities remained present and scores did not decrease.
- The earlier bounded RPC smoke and the completed C42A teacher/local-player dogfood trial removed only their exact captured identities and associated keys. A separate older trial identity was preserved because a person may have reused it; it was not part of cleanup. No unrelated public-user rows were targeted.
- The first published deployment completed successfully in [GitHub Actions run 38424248365](https://github.com/candramd/ular-tangga/actions/runs/38424248365). The site at https://candramd.github.io/ular-tangga/ returned HTTP 200 for `/`, `/admin/`, and fragment-based room/game URLs. All referenced JavaScript/CSS chunks returned 200, and all 52 font URLs resolved relative to the deployed stylesheet returned 200.
- The dependency-patched deployment completed successfully in [GitHub Actions run 38425344400](https://github.com/candramd/ular-tangga/actions/runs/38425344400); the final dependency audit reported zero vulnerabilities.
- Desktop browser review of the published game confirmed the original WebGL board, snakes, and dice render. A fresh reload of a room invite fragment opened the expected login modal. Browser dogfood at 360×640 and 390×844 confirmed the board remains visible while quiz content scrolls inside its panel, with no horizontal overflow. Home, reload/resume, and logout flows were exercised. These are browser viewport checks; physical-phone rendering and performance have not been verified.
- The teacher/local-player dogfood flow verified a classroom controller outside the player roster, 2 child players, renaming the same guest identity, game continuation, logout, and child cumulative scores (the two captured values were 1 and 0). The captured trial data was then removed by exact captured keys; no unrelated user data was included.

Still pending:

- Snapshot restore/release rollback rehearsal and quota/latency/load assessment remain open; a passing export or schema check is not evidence of these release gates.

## Hosting configuration

The Pages workflow in `.github/workflows/pages.yml` builds `out/` and deploys it with the official GitHub Pages actions. Set repository variable `NEXT_PUBLIC_SUPABASE_URL` to the project HTTPS URL and repository secret `NEXT_PUBLIC_SUPABASE_ANON_KEY` to its publishable/anon key. That key is public by design and is embedded in the static bundle; never put a database password, service-role key, admin secret, or other privileged credential in a `NEXT_PUBLIC_*` value. Enable GitHub Pages with GitHub Actions as the build and deployment source. The workflow sets `NEXT_PUBLIC_BASE_PATH` from the repository name for project-site URLs.

Build locally after setting those two public values and the repository base path:

```sh
NEXT_PUBLIC_BASE_PATH=/ular-tangga \
NEXT_PUBLIC_SUPABASE_URL=https://PROJECT.supabase.co \
NEXT_PUBLIC_SUPABASE_ANON_KEY=PUBLIC_PUBLISHABLE_KEY \
npm run build
node scripts/static-preview.mjs out
```

Open the local preview at `http://127.0.0.1:4173`. Room and game navigation use URL fragments (`/#/room/CODE` and `/#/game/ID`) so GitHub Pages does not need server rewrites. Admin remains a static `/admin/` page under the configured base path. The preview server binds to loopback only.

After building, run `node scripts/check-static-export.mjs out` to confirm both exported entry pages exist and scan generated text assets for server-only credential/config markers. The check reports whether a marker exists but never prints matched content. Run `node scripts/check-game-graphics.mjs` to compare the six board, dice, snake, and animation source files with the migration-start checksum baseline in `tests/fixtures/game-graphics.sha256`.

## Database and security cutover

1. Confirm a recoverable Supabase backup exists and record its timestamp. Before any writer transition, save `public.ular_server_state.state` to an ignored `.backups/` path with mode 0600 and save aggregate user/question/game counts plus snapshot version under ignored `.runtime/` with mode 0600. Use a PostgreSQL client compatible with the server version. Keep this private snapshot out of source control and retain it through the rollback window. Keep the old Go writer available and stop it before any new writer is enabled; never run both writers against the same game state concurrently.
2. Review and apply the checked-in Supabase migrations to the intended project. Confirm browser roles cannot select or mutate private state tables directly. All game state transitions must pass through `public.ular_api`; private answer keys, score calculation, dice generation, and session validation stay in database functions.
3. Confirm the RPC accepts only the documented path/method/body and opaque session/admin tokens, validates authorization and turn ownership on every mutation, and returns the standard envelope `{ok,status,data,meta?}` or `{ok:false,status,error:{code,message}}`. Confirm request IDs make retries idempotent. Validate the sync cursor/event ordering and timer expiry behavior before moving active rooms.
4. Migrate a verified snapshot of existing persisted state with an explicit, reviewed mapping. Preserve teacher/admin identity, room/game IDs, scores, and question bank data. Do not drop or overwrite the old snapshot until parity and restore checks pass. Test first on an isolated project or isolated schema with synthetic accounts and games.
5. Confirm the static bundle contains only the Supabase project URL and publishable/anon key. Search the generated files for known private-key markers and server-only config names without printing matched values. Check that private tables deny `anon` and `authenticated` access and that the RPC does not return answer keys before resolution.
6. Rehearse guest/admin login, invalid credentials, room creation/join/reconnect, wrong-turn rejection, duplicate request IDs, question answer, dice roll, snake/ladder event sequence, timer expiry, teacher restart/relogin, score accumulation, and admin question CRUD. Keep polling within Supabase quotas; use the agreed 1–2 second interval only while a room/game is active and stop polling when the view closes or the game ends.
7. Verify the Pages URL on desktop and mobile, including the project base path, fragment deep links, fonts, and game graphics. Compare a pre-migration graphics asset checksum against the static export copy to ensure the visual files were preserved.
8. Run the mutating admin/game integration suite only against a dedicated isolated target. It now requires `TEST_ALLOW_MUTATIONS=true` plus a test URL and admin secret (and a publishable key for Supabase) and refuses to proceed when the starting question bank is non-empty. Switch users only after all gates pass. Record migration revision, backup timestamp, URL, test results, and operator; never record credentials or tokens.

## Rollback

If a release gate fails, stop browser traffic to the new RPC-backed release and restore the previous published frontend. Restart the prior Go service as the sole writer using the preserved database snapshot and its existing server-only credentials. Do not drop migrated tables or delete snapshot rows during rollback. If any new writes reached the database, reconcile them before restoring an older snapshot so valid teacher activity is not silently lost.

## Release gates

- [x] Static export completes and includes `/index.html` and `/admin/index.html`; server-only marker scan and WOFF2 asset check pass.
- [x] GitHub Pages project path, referenced assets/fonts, and hash-navigation entry URLs return successfully from the published URL; desktop and mobile visual review also passed.
- [x] Supabase migrations 002–006 and board seed are applied; snapshot version and state digest were unchanged during the migration 006 transaction. Browser-role access checks and broad RPC coverage pass in the isolated SQL fixture.
- [x] RPC authentication, privacy, mutation authorization, idempotency, event sequence, and expiry behavior pass against isolated data; bounded live RPC smoke and exact-ID cleanup pass.
- [ ] Existing teacher data has a completed restore/rollback rehearsal. The prior browser identity and room were restored during cutover verification, but a full snapshot rollback rehearsal remains open.
- [x] Desktop browser and 360×640/390×844 viewport reviews pass for the board, graphics, room invite route, in-panel quiz scrolling, home, reload/resume, and logout. Physical phone testing remains unverified.
- [x] Teacher/local-player dogfood verifies the non-roster classroom controller, 2-player local room, rename preserving guest identity, logout, and child score persistence; cleanup was limited to the captured trial identities and keys. The score values were 1 and 0 across the two children.
- [ ] Supabase quota/latency behavior is acceptable under active polling and reconnect load.
- [ ] Rollback to the prior frontend and single Go writer has been rehearsed.
