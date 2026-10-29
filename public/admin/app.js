/* global io, GameRules */
(() => {
  "use strict";
  const socket = io();
  const app = document.getElementById("app");
  const error = document.getElementById("error");
  const connection = document.getElementById("connection");
  const drafts = new Map();
  let state = null;
  let files = [];
  let busy = false;
  let offset = 0;
  const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const money = (n) => `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString()}`;
  const title = (s) => s.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const value = (id, fallback) => escape(drafts.has(id) ? drafts.get(id) : fallback);
  const disabled = (condition = false) => condition || busy || !socket.connected ? "disabled" : "";
  const button = (label, action, cls = "", off = false, extra = "") =>
    `<button type="button" class="${cls}" data-action="${action}" ${disabled(off)} ${extra}>${label}</button>`;
  const names = (selected, choices = state.contestants.map((_, i) => i)) => choices.map((i) =>
    `<option value="${i}" ${Number(selected) === i ? "selected" : ""}>${escape(state.contestants[i].name)}</option>`).join("");
  const input = (id, fallback, type = "text", extra = "") =>
    `<input id="${id}" type="${type}" value="${value(id, fallback)}" ${extra}>`;
  const read = (id) => document.getElementById(id).value;
  const num = (id) => Number(read(id));
  const image = (url) => url ? `<figure class="clue-media"><img class="clue-image" src="${escape(url)}" alt="Clue illustration">
    <p class="image-error" role="alert" hidden>Clue image could not be loaded. Check the image file beside the CSV.</p></figure>` : "";
  function showError(message) { error.textContent = `${message} (tap to dismiss)`; error.hidden = false; }
  error.onclick = () => { error.hidden = true; };
  function commandId() {
    if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  function send(command, clear = []) {
    if (!socket.connected || busy || !state) return;
    busy = true;
    error.hidden = true;
    const envelope = { id: commandId(), revision: state.revision, command };
    socket.timeout(7000).emit("cmd", envelope, (err, result) => {
      busy = false;
      if (err) showError("No acknowledgment. Reconnect and inspect the game before trying again; this action may have succeeded.");
      else if (!result.ok) showError(result.error);
      else {
        if (clear === "all") drafts.clear();
        else clear.forEach((key) => drafts.delete(key));
      }
      render();
    });
    render();
  }
  function render() {
    connection.textContent = socket.connected ? busy ? "Saving…" : "Connected · live" : "Disconnected · controls paused";
    connection.className = `status ${socket.connected ? "online" : ""}`;
    if (!state) return;
    const focused = document.activeElement?.id;
    const details = new Map(Array.from(app.querySelectorAll("details[id]"), (element) => [element.id, element.open]));
    const selection = document.activeElement instanceof HTMLInputElement ?
      [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
    const s = state;
    const final = s.phase.startsWith("final_");
    let html = `<section class="row between"><div><div class="eyebrow">${title(s.round)} / ${escape(s.filename)}</div>
      <h1>${title(s.phase)}</h1></div>${button("Undo", "undo", "outline", !s.canUndo)}</section>`;
    html += `<section class="panel rules-control"><div class="row between"><strong>Game rules · ${s.rulesVisible ? "on TV" : "off TV"}</strong>
      ${button(s.rulesVisible ? "Hide rules" : "Show rules", "rules", "outline", false, `aria-pressed="${!!s.rulesVisible}"`)}</div>
      <details id="rules-copy"><summary>Read the rules</summary><div class="rules-copy">${GameRules}</div></details></section>`;
    if (s.phase === "setup") {
      const count = Number(drafts.get("count") ?? s.contestants.length);
      html += `<section class="panel"><h2>Set the podiums</h2><label for="count">Contestants or teams</label>
        <select id="count">${[2, 3, 4, 5, 6].map((n) => `<option ${count === n ? "selected" : ""}>${n}</option>`).join("")}</select>
        ${Array.from({ length: count }, (_, i) => `<div class="field"><label for="name-${i}">Contestant ${i + 1}</label>${input(`name-${i}`, s.contestants[i]?.name ?? `Contestant ${i + 1}`, "text", 'maxlength="40"')}</div>`).join("")}
        <div class="row">${button("Save contestants", "configure")}${button("Start Jeopardy", "start", "primary")}</div>
        <p class="hint">Save edited names/count before starting. Players answer aloud; you judge every response.</p></section>`;
    }
    html += `<section class="contestants">${s.contestants.map((c, i) => `<article class="panel contestant ${s.control === i ? "control" : ""}">
      <div class="eyebrow">${s.control === i ? "Board control" : `Podium ${i + 1}`}</div><strong>${escape(c.name)}</strong>
      <div class="score ${c.score < 0 ? "negative" : ""}">${money(c.score)}</div>
      ${button("Give control", "control", "outline", !["board", "setup"].includes(s.phase), `data-index="${i}"`)}
      <details id="edit-${i}"><summary>Edit / correct</summary><label for="rename-${i}">Name</label><div class="row">${input(`rename-${i}`, c.name, "text", 'maxlength="40"')}${button("Rename", "rename", "", false, `data-index="${i}"`)}</div>
      <label for="delta-${i}">Score change (+ or −)</label><div class="row">${input(`delta-${i}`, 0, "number", 'step="1"')}${button("Apply", "adjust_score", "", final || s.phase === "finished", `data-index="${i}"`)}</div></details>
      </article>`).join("")}</section>`;
    if (s.phase === "board" || s.phase === "setup") {
      html += `<section class="panel"><h2>${title(s.round)}</h2><div class="board-scroll"><div class="board">${s.board.map((column) =>
        `<div class="column"><div class="category">${escape(column.category)}</div>${column.cells.map((cell) =>
          button(cell.used ? "—" : `${money(cell.value)}${s.private.dailyClues.includes(cell.id) ? "<small>DAILY DOUBLE · PRIVATE</small>" : ""}`,
            "select", `tile ${cell.used ? "used" : ""}`, cell.used || s.phase !== "board", `data-id="${escape(cell.id)}"`)).join("")}</div>`).join("")}
      </div></div>`;
      if (s.phase === "board") {
        const choices = s.contestants.map((c, i) => c.score === Math.min(...s.contestants.map((p) => p.score)) ? i : -1).filter((i) => i >= 0);
        if (s.round === "jeopardy") html += `<label for="next-control">Double Jeopardy starts with a lowest-scoring contestant</label><select id="next-control">${names(drafts.get("next-control") ?? choices[0], choices)}</select>`;
        html += `<div class="actions">${button(s.round === "jeopardy" ? "Advance to Double Jeopardy" : "Advance to Final Jeopardy", "advance", "primary")}</div>`;
      }
      html += "</section>";
    }
    if (s.active) {
      html += `<section class="panel"><div class="eyebrow">${escape(s.active.category)} · ${money(s.active.value)}</div>`;
      if (s.phase === "daily_wager") {
        const selected = Number(drafts.get("daily-player") ?? s.control);
        html += `<h2>Daily Double</h2><p>Confirm the selecting contestant and lock a wager before reading the clue.</p>
          <label for="daily-player">Contestant</label><select id="daily-player">${names(selected)}</select>
          <div class="field"><label for="daily-amount">Wager · 5–${Math.max(s.contestants[selected]?.score ?? 0, s.round === "jeopardy" ? 1000 : 2000)}</label>
          ${input("daily-amount", 5, "number", 'min="5" step="1"')}</div>${button("Lock wager & show clue", "daily_wager", "primary")}`;
      } else {
        html += `<p class="clue">${escape(s.active.clue)}</p>${image(s.active.imageUrl)}`;
        if (s.active.wager !== undefined) html += `<p>Daily Double wager: <strong>${money(s.active.wager)}</strong></p>`;
        html += `<div class="secret"><span class="eyebrow">PRIVATE ANSWER · ${s.active.answer ? "ALSO ON TV" : "NOT ON TV"}</span><strong>${escape(s.private.answer)}</strong></div>`;
        if (s.phase === "clue") {
          html += `<p class="hint">Select the responder, then judge. Incorrect contestants cannot attempt this clue again.</p><div class="row">
            ${s.contestants.map((c, i) => button(escape(c.name), "responder", s.active.responder === i ? "selected" : "",
              s.private.daily || s.private.attempted.includes(i), `data-index="${i}"`)).join("")}</div>
            ${s.private.daily ? `<p>Only ${escape(s.contestants[s.active.responder].name)} may respond.</p>` : ""}
            <div class="row actions">${button("Correct +", "correct", "good", s.active.responder === null)}
            ${button("Incorrect −", "incorrect", "bad", s.active.responder === null)}${button("No answer", "no_answer")}</div>`;
        }
        html += `<div class="row actions">${button("Reveal answer on TV", "reveal_answer", "", !!s.active.answer)}
          ${button("Return to board", "return_board", "primary", s.phase !== "resolved")}</div>`;
        if (s.phase === "clue") html += `<div class="row actions"><label for="seconds">Optional timer</label>
          ${input("seconds", 10, "number", 'min="1" max="300" step="1" aria-label="Clue timer seconds"')}
          ${button("Start timer", "start_timer", "", s.timer.endsAt !== null || s.timer.expired)}</div>`;
      }
      html += `<p class="timer" data-countdown></p></section>`;
    }
    if (final) {
      html += `<section class="panel"><div class="eyebrow">FINAL JEOPARDY</div><h2>${escape(s.final.category)}</h2>`;
      if (s.phase === "final_wagers") {
        html += `<p class="hint">Only positive-score contestants participate. Wagers remain private until each result is revealed.</p>`;
        html += s.private.finalEntries.map((entry) => `<div class="field"><label for="wager-${entry.contestant}">${escape(s.contestants[entry.contestant].name)} · 0–${entry.score}</label>
          <div class="row">${input(`wager-${entry.contestant}`, entry.wager ?? "", "number", `min="0" max="${entry.score}" step="1"`)}
          ${button(entry.wager === null ? "Save wager" : `Saved: ${money(entry.wager)}`, "final_wager", "", false, `data-index="${entry.contestant}"`)}</div></div>`).join("");
        html += button("Lock all wagers & show clue", "lock_wagers", "primary", s.private.finalEntries.some((e) => e.wager === null));
      } else {
        html += `<p class="clue">${escape(s.final.clue)}</p>${image(s.final.imageUrl)}<div class="secret"><span class="eyebrow">PRIVATE ANSWER</span><strong>${escape(s.private.answer)}</strong></div>`;
        if (s.phase === "final_clue") html += `<p>Read the clue, then start the clock.</p>${button("Start 30-second Final timer", "start_timer", "primary")}`;
        html += `<p class="timer" data-countdown></p>`;
        if (s.phase === "final_judging") {
          const next = s.private.finalEntries.find((e) => !e.revealed);
          html += `<p class="hint">Record private judgments. Results reveal in ascending pre-Final score order.</p>`;
          html += s.private.finalEntries.map((entry) => `<div class="judgment"><strong>${escape(s.contestants[entry.contestant].name)}</strong> · wager ${money(entry.wager)}
            <div class="row actions">${button("Correct", "final_correct", entry.correct === true ? "good" : "", entry.revealed, `data-index="${entry.contestant}"`)}
            ${button("Incorrect / no answer", "final_incorrect", entry.correct === false ? "bad" : "", entry.revealed, `data-index="${entry.contestant}"`)}
            ${entry.revealed ? "<span>Revealed on TV</span>" : "<span class='hint'>Private</span>"}</div></div>`).join("");
          html += `<div class="row">${button("Show canonical answer", "reveal_answer", "", !!s.final.answer)}
            ${button(next ? `Reveal ${escape(s.contestants[next.contestant].name)}` : "All results revealed", "final_reveal", "primary", !next || next.correct === null)}
            ${button("Show winners", "finish", "good", !!next)}</div>`;
        }
      }
      html += "</section>";
    }
    if (s.phase === "finished") html += `<section class="panel"><div class="eyebrow">FINAL RESULTS</div><h2>${s.winners.length > 1 ? "Tied winners" : "Winner"}: ${s.winners.map((i) => escape(s.contestants[i].name)).join(" & ")}</h2>
      ${s.final.skipped ? "<p>No positive scores: Final Jeopardy was skipped.</p>" : ""}<p class="hint">Undo to correct a Final judgment or reveal.</p></section>`;
    html += `<section class="panel"><details id="settings" ${s.phase === "setup" ? "open" : ""}><summary>Game files & settings</summary>
      <label for="csv">Full-game CSV</label><div class="row"><select id="csv">${files.map((f) =>
        `<option value="${escape(f)}" ${(drafts.get("csv") ?? s.filename) === f ? "selected" : ""}>${escape(f)}</option>`).join("")}</select>
      ${button("Refresh list", "refresh")}${button("Load / reload", "select_csv")}</div>
      <p class="hint">Loading a file starts a new game and clears scores and undo. Saved games take precedence over disk edits until reloaded.</p>
      <div class="row"><label for="muted"><input id="muted" type="checkbox" ${s.audio.muted ? "checked" : ""} ${disabled()}> Mute TV</label>
      <label for="volume">TV volume</label><input id="volume" type="range" min="0" max="100" value="${s.audio.volume * 100}" ${disabled()}></div>
      ${button("Reset game", "reset", "bad")}<p class="hint">No login. Use only on a trusted local network.</p></details></section>`;
    app.innerHTML = html;
    details.forEach((open, id) => { const element = document.getElementById(id); if (element) element.open = open; });
    if (focused) {
      const element = document.getElementById(focused);
      element?.focus({ preventScroll: true });
      if (selection && element instanceof HTMLInputElement && element.type === "text") element.setSelectionRange(...selection);
    }
    updateTimer();
  }
  app.addEventListener("error", (event) => {
    if (!(event.target instanceof HTMLImageElement) || !event.target.classList.contains("clue-image")) return;
    event.target.hidden = true;
    event.target.nextElementSibling.hidden = false;
  }, true);
  app.addEventListener("input", (event) => {
    const element = event.target;
    if (element.id && element.id !== "volume" && element.id !== "muted") drafts.set(element.id, element.value);
  });
  app.addEventListener("change", (event) => {
    if (event.target.id === "count" || event.target.id === "daily-player") render();
    if (event.target.id === "volume" || event.target.id === "muted") {
      send({ type: "audio", muted: document.getElementById("muted").checked, volume: num("volume") / 100 });
    }
  });
  app.addEventListener("click", (event) => {
    const target = event.target.closest("button[data-action]");
    if (!target || target.disabled) return;
    const action = target.dataset.action;
    const contestant = Number(target.dataset.index);
    switch (action) {
      case "configure": {
        const count = num("count");
        send({ type: "configure", names: Array.from({ length: count }, (_, i) => read(`name-${i}`)) },
          ["count", ...Array.from({ length: count }, (_, i) => `name-${i}`)]); break;
      }
      case "rename": send({ type: "rename", contestant, name: read(`rename-${contestant}`) }, [`rename-${contestant}`]); break;
      case "adjust_score": {
        const delta = num(`delta-${contestant}`);
        if (confirm(`Change ${state.contestants[contestant].name}'s score by ${delta}?`)) send({ type: action, contestant, delta }, [`delta-${contestant}`]);
        break;
      }
      case "control": case "responder": send({ type: action, contestant }); break;
      case "rules": send({ type: "rules", visible: !state.rulesVisible }); break;
      case "select": send({ type: "select", id: target.dataset.id }); break;
      case "correct": case "incorrect": send({ type: "judge", correct: action === "correct" }); break;
      case "daily_wager": send({ type: action, contestant: num("daily-player"), amount: num("daily-amount") }, ["daily-player", "daily-amount"]); break;
      case "final_wager":
        if (read(`wager-${contestant}`) === "") { showError("Enter a wager, including 0 if intended."); break; }
        send({ type: action, contestant, amount: num(`wager-${contestant}`) }, [`wager-${contestant}`]); break;
      case "final_correct": case "final_incorrect": send({ type: "final_judge", contestant, correct: action === "final_correct" }); break;
      case "start_timer": send({ type: action, ...(state.phase === "clue" ? { seconds: num("seconds") } : {}) }); break;
      case "advance": {
        const remaining = state.board.some((c) => c.cells.some((cell) => !cell.used));
        if (remaining && !confirm("Skip the remaining clues and advance to the next round?")) break;
        send({ type: action, confirmed: remaining, ...(state.round === "jeopardy" ? { contestant: num("next-control") } : {}) }, ["next-control"]); break;
      }
      case "reset": case "select_csv":
        if (confirm("Start a fresh game? All scores, progress and undo history will be cleared.")) {
          send({ type: action, confirmed: true, ...(action === "select_csv" ? { filename: read("csv") } : {}) }, "all");
        } break;
      case "refresh": socket.emit("list_csv_files"); break;
      case "lock_wagers":
        if (confirm("Lock all wagers and show the Final clue? Score changes will require undo.")) send({ type: action }); break;
      default: send({ type: action });
    }
  });
  function updateTimer() {
    if (!state) return;
    const remaining = state.timer.endsAt === null ? null : Math.max(0, Math.ceil((state.timer.endsAt - Date.now() - offset) / 1000));
    document.querySelectorAll("[data-countdown]").forEach((node) => {
      node.textContent = remaining !== null ? `${remaining}s remaining` : state.timer.expired ? "Time is up · host judges the response" : "";
    });
  }
  socket.on("connect", render);
  socket.on("disconnect", () => { busy = false; render(); });
  socket.on("connect_error", (err) => { showError(`Connection failed: ${err.message}`); render(); });
  socket.on("state", (snapshot) => {
    if (state && state.revision > snapshot.revision) return;
    state = snapshot; offset = state.serverTime - Date.now(); render();
  });
  socket.on("csv_files", (list) => { files = list; render(); });
  socket.on("error_msg", showError);
  setInterval(updateTimer, 200);
})();
