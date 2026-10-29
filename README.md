# Jeopardy LAN

A living-room game show with a private host desk on your phone and a blue-and-gold board on the TV. One Node/TypeScript process, two browser UIs, CSV game boards, and SQLite crash recovery. Inspired by the operating model of the neighboring Family Feud project; this is a separate application and database.

Includes Jeopardy, Double Jeopardy, Daily Doubles, Final Jeopardy, 2–6 contestants or teams, host-controlled scoring, undo, and original synthesized sound effects. No accounts, player apps, external trivia API, or internet connection required after installation.

## Run

Use Node.js 22 or newer with npm.

```bash
npm install
npm run build
npm start
```

| Screen | URL |
| --- | --- |
| TV / projector | <http://localhost:3001> |
| Private admin | <http://localhost:4001> |

On other devices on the same Wi-Fi, replace `localhost` with the server computer's LAN IP. For example, open `http://192.168.1.20:4001` on your phone and `http://192.168.1.20:3001` on the TV browser. On Linux, `hostname -I` lists addresses; on macOS, use `ipconfig getifaddr en0`. Allow the two TCP ports through your local firewall if necessary. Both servers bind to `0.0.0.0`; guest Wi-Fi/client isolation can prevent devices from reaching each other.

**Admin has no authentication. Use a trusted LAN only; do not expose either port through public tunnels or router port forwarding.** Anyone who can reach the admin port can control the game and see answers and wagers. Read-only TV sockets receive no private answer bank, future clue text, unrevealed wagers, or hidden Daily Double locations.

Click **Enable TV sound** once on the TV to satisfy browser autoplay rules. The corner button enters fullscreen. Admin is silent.

### Configuration

```bash
DISPLAY_PORT=3002 ADMIN_PORT=4002 DB_PATH=/path/to/jeopardy.db npm start
```

Defaults are ports 3001/4001 and `jeopardy.db` in the project directory, leaving Family Feud's ports 3000/4000 free. The database's parent directory must already exist and be writable. `/health` on either port returns its role and readiness once startup succeeds.

### Docker

Pull the published image, or build it locally:

```bash
docker pull ghcr.io/karpikpl/jeopardy:latest
# Alternatively:
docker build -t jeopardy-lan:latest .
```

Run the published image:

```bash
docker run -d --name jeopardy-lan \
  -p 3001:3001 -p 4001:4001 \
  -v jeopardy-data:/data \
  ghcr.io/karpikpl/jeopardy:latest
```

For a local build, replace the image name with `jeopardy-lan:latest`. GitHub Actions runs tests and validates every board before publishing to GHCR. Pushes to `main` publish `latest` and a commit-specific `sha-...` tag; version tags such as `v0.1.0` publish a matching image tag. Pull requests run checks without publishing. Registry authentication uses the workflow's `GITHUB_TOKEN`; no separate registry secret is needed.

The image includes all root-level CSV boards, their source references, and the complete `images/` and `public/` folders. No CSV or image mounts are required. The build excludes local databases, `node_modules`, and other files outside its allowlist.

The app runs as a non-root user and saves games to `/data/jeopardy.db`; the named volume preserves progress when the container is replaced. It starts with the template on a fresh volume; choose another included CSV in admin. Rebuilding an image does not replace a board already saved in the volume: explicitly reload the CSV in admin to apply question changes.

Both ports must be free on the host. For example, use `-p 3002:3001 -p 4002:4001` if a local game is already using 3001/4001. Keep the unauthenticated admin port on a trusted LAN. Included photos retain their separate licenses. The game owner confirms permission to redistribute the supplied Changing Corners photo; no general downstream reuse license is asserted.

## Board CSV

The included `boards.template.csv` is a complete playable 61-clue game with original starter questions. Copy it to ignored `boards.csv` to customize, or place other `.csv` files in the project root. In admin, expand **Game files & settings**, refresh the file list, and choose **Load / reload**.

`boards.climbing-legends.csv` adds a 61-clue climbing-history game with three photo questions, dated competition results, and explicit guessing tolerances in the clues and host answers. Its fact-check references are in `boards.climbing-legends.sources.json`. Keep `images/climbing-legends/` beside the CSV for offline play. Photo credits and licenses are in that folder's `credits.json`; these photos are **not** MIT-licensed. The game owner confirms redistribution permission for the supplied Changing Corners photo; other users must obtain their own permission for uses not covered by that authorization.

`boards.sixth-grader.csv` is a 61-clue mixed-subject school-trivia board with six visual-identification clues and quick mental math. Keep `images/sixth-grader/` beside the CSV. Image credits and licenses are in that folder's `credits.json`; research references and scope are in `boards.sixth-grader.sources.json`. Images are displayed by the game; contestants do not draw anything.

```csv
round,category,value,clue,answer,daily_double
jeopardy,SPACE,200,Our home planet is the third one from the Sun.,Earth,false
jeopardy,SPACE,600,This force keeps planets in orbit around the Sun.,Gravity,true
double_jeopardy,SCIENCE LAB,400,This chemical symbol represents oxygen.,O,false
final,GEOGRAPHY,,This ocean lies between Africa and Australia.,Indian Ocean,false
```

This excerpt illustrates the format; a valid file needs all 61 clues.

- Required headers: `round,category,value,clue,answer,daily_double` (case/outer whitespace insensitive). An optional `image` column adds an illustration.
- Rounds: `jeopardy`, `double_jeopardy`, and `final`.
- Each regular round has exactly six categories, with five cells per category. Category order follows first appearance in the CSV.
- Jeopardy values: 200, 400, 600, 800, 1000. Double Jeopardy values: 400, 800, 1200, 1600, 2000.
- Exactly one Jeopardy Daily Double and two Double Jeopardy Daily Doubles, marked `true`. All other rows use `false`.
- Exactly one Final row: category/clue/answer required, value blank, Daily Double `false`.
- Category, clue, and answer must not be empty. Duplicate category/value cells are rejected.
- Use standard CSV quotes for commas, quotes, or line breaks: `"A clue, with a comma"` and `"A ""quoted"" word"`. UTF-8 BOM is supported.
- Clue text is plain text, not HTML. Optional images are supported; audio clues and custom-sized boards are not.

Errors identify the offending record or incomplete round. An invalid file leaves the current game untouched. Loading/reloading a valid file requires confirmation and starts a new game, retaining names/count and audio settings but clearing scores, progress, and undo.

**Saved game contents take precedence over files on disk.** On a fresh database the server prefers `boards.csv`, otherwise the template. After that, disk edits take effect only through explicit admin reload.

### Text + image clues

Add an `image` column containing a path relative to the CSV file. Leave it blank for text-only clues; existing six-column CSVs still work.

```csv
round,category,value,clue,answer,daily_double,image
jeopardy,SPACE,200,Name the planet shown in this picture.,Earth,false,images/earth.png
```

For a CSV at `game-night.csv`, the example image belongs at `images/earth.png` alongside that CSV's directory, not relative to the browser or your shell's working directory. Nested folders and filenames with spaces are supported. Use forward slashes.

PNG, JPEG, GIF and WebP are supported. Paths must stay within the CSV directory: no absolute paths, parent-directory traversal (`..`), external URLs, data URLs, SVGs or symlinks escaping the directory. The server checks image files when loading/reloading a board; missing or invalid files reject the load without replacing the current game.

Clues still require text and an answer. Both admin and TV show the image with its clue, including Daily Doubles and Final Jeopardy. Wager screens do not expose the image early. If a file disappears during play, both UIs show an explicit image error.

Image paths are saved with the game, but image bytes are not stored in SQLite. Keep the image files with the CSV when moving or restoring a game. Changing an `image` field requires CSV reload; replacing an image file at the same path takes effect on the next image request. When using file mounts, include the image folders too.

## Hosting a game

Use **Show rules / Hide rules** near the top of admin to display the shared rules sheet on every connected TV. **Read the rules** opens the same copy privately in admin. Responses as questions are encouraged, never required for scoring; the host has final judgment. Regular responses are spoken; Final responses are written offline.

Rules visibility is saved like audio settings, survives reconnects/restarts and resets, and is not undoable. It only covers the TV presentation: gameplay, scores and running timer deadlines are unchanged. **Showing rules does not pause the clock.**

### Setup and regular clues

1. Set 2–6 names and click **Save contestants**, then **Start Jeopardy**. Use **Give control** to choose who picks first. Count changes require resetting to setup.
2. Players pick aloud; the host selects the category/value tile. On a phone, swipe the board horizontally to reach all six categories. Daily Double markers appear only in admin.
3. Select the responder and judge **Correct +** or **Incorrect −**. Correct adds face value and transfers board control. Incorrect subtracts face value; another contestant may try, but the same contestant cannot attempt that clue twice. Negative totals are allowed.
4. **No answer** closes the clue without an extra penalty. **Reveal answer on TV** also closes scoring, preventing attempts after the solution is public.
5. After resolution, optionally reveal the answer, then **Return to board**. Used tiles are blank on TV.
6. Advance when the board is complete, or confirm skipping remaining clues. Double Jeopardy starts with the lowest-scoring contestant; choose among ties in admin.

The optional clue timer is off until the host starts it (10-second default, configurable 1–300 seconds). Expiry signals time-up but does not automatically judge, close the clue, or deduct points.

### Daily Doubles

The TV announces the Daily Double without revealing the clue. Confirm the selecting contestant, enter the wager, and click **Lock wager & show clue**.

Wagers are whole numbers from 5 to the larger of the contestant's score or the round's highest face value (1000/2000). This permits wagers even with negative scores. Only that contestant responds: correct adds the wager; incorrect or no answer subtracts it. There is no rebound. Revealing the answer before a judgment counts as no answer and deducts the wager.

### Final Jeopardy

1. Only contestants with positive pre-Final scores participate. If nobody qualifies, Final is skipped and the existing leaders are shown.
2. TV shows the category. Privately collect wagers and save each in admin, including explicit zero wagers. Allowed range is 0 through that contestant's pre-Final score.
3. **Lock all wagers & show clue**. Read the clue, then start the 30-second timer. Contestants write responses offline.
4. After time expires, privately mark each contestant correct or incorrect/unanswered. The server never guesses correctness.
5. Optionally show the canonical answer. Reveal results one contestant at a time in ascending pre-Final score order (stable podium order for ties). A reveal publishes that contestant's wager/judgment and applies their score change once. Other outcomes stay private.
6. **Show winners** displays the eligible contestant(s) with the highest final score. Ties remain ties; no automatic tiebreaker.

### Corrections and disconnections

**Undo** reverses the most recent gameplay action, including a judgment, reveal, clue selection, or round transition. It survives server restart. Audio and rules-visibility changes are not undoable. Reversing within the same timed clue never grants extra time or revives an expired clock.

Expand a contestant's **Edit / correct** section to rename them or apply a signed score adjustment. Score edits are blocked from Final setup onward; undo back to the board to correct pre-Final scores, then enter Final again.

Disconnected admin controls are disabled; commands are not queued offline. Reconnection restores authoritative state. Command IDs, revision checks, and persisted receipts prevent retrying an acknowledged action from scoring twice. If acknowledgment times out, inspect the current state before attempting a new action: it might already have succeeded.

## Persistence and recovery

Each accepted command is saved to SQLite before broadcasting or acknowledging success. Live state, embedded board contents, undo snapshots, absolute timer deadlines, audio settings, rules visibility, and retry receipts survive restart. A database write error is shown in admin and does not publish the unsaved candidate state.

Timers expire on the server, not in a browser callback. Restarting after a deadline restores the timer as expired; switching browser tabs or reconnecting does not restart it. TV sound effects are not replayed when reconnecting.

**Reset game** clears scores/progress/undo but retains the current board, names/count, and audio settings. It does not reread the CSV.

Corrupt or unsupported saved data stops startup with an error rather than silently discarding a game. Back up the database before recovery. To deliberately start from disk again, stop the server and move `jeopardy.db` and any matching `-wal`/`-shm` files aside together, then restart. Never replace a database while the process is running.

## Development

```bash
npm run dev   # initial build, TypeScript watch and server restart
npm test      # strict compilation + Node unit/integration tests
```

No frontend build or linter is required; `public/` is served directly. Static changes appear on reload, and the dev server watches `public/` and compiled `dist/`. CSV edits are applied only by explicit reload.

Core transitions are in `src/state.ts`, CSV validation in `src/csv.ts`, timer expiry in `src/timer.ts`, public/private DTOs in `src/projection.ts`, and durable command handling in `src/server.ts`/`src/persist.ts`. The two clients render snapshots rather than owning separate state machines.

## References and licensing

GitHub references considered during planning:

- [things-with-buzzers-jeopardy](https://github.com/andygrunwald/things-with-buzzers-jeopardy): host/board and wagering flow, but requires buzzer infrastructure.
- [Potent Potables](https://github.com/potentPotables/potentPotables): phone-controller party architecture, beyond this app's host-only LAN scope.
- [denvaar/jeopardy-game](https://github.com/denvaar/jeopardy-game): custom family boards in an Electron desktop application.

This implementation does not depend on or bundle their source/assets. Source and original starter content are [MIT licensed](LICENSE). Sound effects are synthesized locally; no show music, recordings, proprietary fonts, or logos are bundled. Jeopardy and related marks belong to their respective owners; this independent game is not affiliated with or endorsed by the television show.
