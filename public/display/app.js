/* global io, GameRules */
(() => {
  "use strict";
  const socket = io();
  const screen = document.getElementById("screen");
  const rules = document.getElementById("rules");
  rules.innerHTML = GameRules;
  const podiums = document.getElementById("podiums");
  const connection = document.getElementById("connection");
  const timer = document.getElementById("timer");
  const gate = document.getElementById("audio-gate");
  const audioError = document.getElementById("audio-error");
  const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const money = (n) => `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString()}`;
  const clueBody = (clue, imageUrl) => `<div class="clue-body ${imageUrl ? "with-image" : ""}">
    <div class="clue-copy"><div class="clue-text">${escape(clue)}</div></div>
    ${imageUrl ? `<figure class="clue-media"><img class="clue-image" src="${escape(imageUrl)}" alt="Clue illustration">
      <p class="image-error" role="alert" hidden>Clue image is unavailable. Please ask the host to check the image file.</p></figure>` : ""}</div>`;
  let state = null;
  let offset = 0;
  let lastCue = null;
  let context = null;
  let visualKey = "";
  let podiumKey = "";
  function audioFailure(err) {
    audioError.textContent = `Sound unavailable: ${err.message}`;
    audioError.hidden = false;
    gate.hidden = false;
  }
  gate.onclick = async () => {
    try {
      if (!context) context = new AudioContext();
      await context.resume();
      gate.hidden = true;
      audioError.hidden = true;
    } catch (err) { audioFailure(err); }
  };
  function play(kind) {
    if (!context || context.state !== "running" || state.audio.muted || !kind) return;
    const frequencies = {
      select: [330, 440], correct: [523, 659, 784], incorrect: [146, 110],
      reveal: [440, 660], time: [660, 330, 220], daily: [262, 330, 392, 523],
    }[kind];
    try {
      frequencies.forEach((hz, i) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const start = context.currentTime + i * .12;
        oscillator.type = kind === "incorrect" ? "triangle" : "sine";
        oscillator.frequency.value = hz;
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(state.audio.volume * .16, start + .015);
        gain.gain.exponentialRampToValueAtTime(.0001, start + .3);
        oscillator.connect(gain); gain.connect(context.destination);
        oscillator.start(start); oscillator.stop(start + .32);
        oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
      });
    } catch (err) { audioFailure(err); }
  }
  function render() {
    if (!state) return;
    const s = state;
    const rulesChanged = rules.hidden === !!s.rulesVisible;
    rules.hidden = !s.rulesVisible;
    podiums.hidden = !!s.rulesVisible;
    screen.setAttribute("aria-hidden", String(!!s.rulesVisible));
    document.getElementById("round-label").textContent = s.phase.startsWith("final_") || s.phase === "finished" ?
      "FINAL JEOPARDY" : s.round === "jeopardy" ? "ROUND ONE · JEOPARDY" : "ROUND TWO · DOUBLE JEOPARDY";
    let html;
    if (s.phase === "setup") {
      html = `<div class="intro"><span class="kicker">YOUR NIGHT. YOUR KNOWLEDGE.</span>
          <h1>Game night.<br>Big questions.</h1><p>Your host is setting the board. Get ready to play.</p></div>`;
    } else if (s.phase === "board") {
      html = `<div class="board">${s.board.map((column) => `<div class="column">
          <div class="category">${escape(column.category)}</div>${column.cells.map((cell) =>
            `<div class="tile ${cell.used ? "used" : ""}">${cell.used ? "" : money(cell.value)}</div>`).join("")}</div>`).join("")}</div>`;
    } else if (s.phase === "daily_wager") {
      html = `<div class="intro"><span class="kicker">${escape(s.active.category)}</span><h1>Daily<br>Double.</h1>
          <p>${escape(s.contestants[s.active.responder].name)}, make your wager.</p></div>`;
    } else if (s.active) {
      html = `<div class="clue-card"><div class="clue-meta">${escape(s.active.category)} · ${money(s.active.wager ?? s.active.value)}
          ${s.active.dailyDouble ? " · DAILY DOUBLE" : ""}</div>${clueBody(s.active.clue, s.active.imageUrl)}
          <div class="answer">${s.active.answer ? escape(s.active.answer) : ""}</div></div>`;
    } else if (s.phase === "final_wagers") {
      html = `<div class="intro"><span class="kicker">THE FINAL CATEGORY</span><h1>${escape(s.final.category)}</h1><p>Place your wagers. Make it count.</p></div>`;
    } else if (s.phase === "finished") {
      html = `<div class="intro"><span class="kicker">${s.winners.length > 1 ? "A SHARED VICTORY" : "TONIGHT'S CHAMPION"}</span>
          <h1>${s.winners.map((i) => escape(s.contestants[i].name)).join("<br>&amp; ")}</h1>
          <p>${s.final.skipped ? "No positive scores — Final Jeopardy was skipped." : "Well played. Until the next game night."}</p></div>`;
    } else {
      html = `<div class="clue-card"><div class="clue-meta">FINAL JEOPARDY · ${escape(s.final.category)}</div>
          ${clueBody(s.final.clue, s.final.imageUrl)}
          <div class="answer">${s.final.answer ? escape(s.final.answer) : ""}</div>
          <div class="final-results">${s.final.entries.filter((e) => e.revealed).map((e) => `<div class="final-result">
            ${escape(s.contestants[e.contestant].name)} · ${e.correct ? "CORRECT" : "INCORRECT"}<br><strong>${e.correct ? "+" : "−"}${money(e.wager)}</strong></div>`).join("")}</div></div>`;
    }
    const screenChanged = html !== visualKey;
    if (screenChanged) {
      visualKey = html;
      screen.innerHTML = html;
    }
    podiums.style.setProperty("--count", s.contestants.length);
    const podiumHtml = s.contestants.map((c, i) => `<div class="podium ${s.control === i && !s.phase.startsWith("final") ? "control" : ""} ${s.winners.includes(i) ? "winner" : ""}">
      <div class="name">${escape(c.name)}</div><div class="score ${c.score < 0 ? "negative" : ""}">${money(c.score)}</div></div>`).join("");
    const podiumsChanged = podiumHtml !== podiumKey;
    if (podiumsChanged) {
      podiumKey = podiumHtml;
      podiums.innerHTML = podiumHtml;
    }
    if (screenChanged || podiumsChanged || rulesChanged) requestAnimationFrame(fitText);
    if (lastCue !== null && s.cue.sequence > lastCue) play(s.cue.kind);
    lastCue = s.cue.sequence;
    updateTimer();
  }
  screen.addEventListener("load", (event) => {
    if (event.target instanceof HTMLImageElement) fitText();
  }, true);
  screen.addEventListener("error", (event) => {
    if (!(event.target instanceof HTMLImageElement) || !event.target.classList.contains("clue-image")) return;
    event.target.hidden = true;
    event.target.nextElementSibling.hidden = false;
    fitText();
  }, true);
  function fitText() {
    for (const node of document.querySelectorAll(".score, .name, .category, .answer")) {
      node.style.fontSize = "";
      let size = parseFloat(getComputedStyle(node).fontSize);
      const minimum = node.matches(".score, .name") ? 8 : 12;
      while ((node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1) && size > minimum) {
        size -= 1; node.style.fontSize = `${size}px`;
      }
    }
    const text = document.querySelector(".clue-text");
    if (text) {
      text.style.fontSize = "";
      const container = text.parentElement;
      let size = parseFloat(getComputedStyle(text).fontSize);
      while ((container.scrollHeight > container.clientHeight + 1 || container.scrollWidth > container.clientWidth + 1) && size > 12) {
        size -= 1; text.style.fontSize = `${size}px`;
      }
    }
    const heading = document.querySelector(".intro h1");
    if (heading) {
      heading.style.fontSize = "";
      let size = parseFloat(getComputedStyle(heading).fontSize);
      while ((screen.scrollHeight > screen.clientHeight + 1 || heading.scrollWidth > screen.clientWidth) && size > 18) {
        size -= 1; heading.style.fontSize = `${size}px`;
      }
    }
  }
  function updateTimer() {
    if (!state) return;
    timer.hidden = state.timer.endsAt === null && !state.timer.expired;
    const remaining = Math.max(0, Math.ceil((state.timer.endsAt - Date.now() - offset) / 1000));
    timer.textContent = state.timer.endsAt !== null ? `${String(remaining).padStart(2, "0")} SECONDS` : "TIME IS UP";
  }
  document.getElementById("fullscreen").onclick = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch (err) {
      audioError.textContent = `Fullscreen unavailable: ${err.message}`; audioError.hidden = false;
    }
  };
  socket.on("connect", () => { lastCue = null; connection.textContent = "LIVE FROM YOUR LIVING ROOM"; });
  socket.on("disconnect", () => { connection.textContent = "CONNECTION LOST · RECONNECTING"; });
  socket.on("connect_error", () => { connection.textContent = "SERVER UNAVAILABLE · RETRYING"; });
  socket.on("state", (snapshot) => {
    if (state && snapshot.revision < state.revision) return;
    state = snapshot; offset = state.serverTime - Date.now(); render();
  });
  window.addEventListener("resize", fitText);
  setInterval(updateTimer, 200);
})();
