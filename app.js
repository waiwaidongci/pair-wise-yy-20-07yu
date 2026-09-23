const storageKey = "wxyy-4-luogujing-grid";
const instruments = [
  { name: "大锣", token: "仓", freq: 180 },
  { name: "鼓", token: "冬", freq: 120 },
  { name: "钹", token: "才", freq: 360 },
  { name: "小锣", token: "台", freq: 520 }
];
const steps = 16;
const beatsPerMeasure = 4;
const dynamicsMeta = {
  f: { label: "强", gain: 0.16, duration: 0.12 },
  m: { label: "中", gain: 0.08, duration: 0.09 },
  p: { label: "弱", gain: 0.032, duration: 0.08 }
};
const dynamicsOrder = ["f", "m", "p"];

/* ==================== 规则层：力度与声部平衡（纯函数，不改谱面） ==================== */

function normalizeDyn(value) {
  return dynamicsMeta[value] ? value : "m";
}

// 未标注("")按中音播放
function dynamicsGain(value) {
  return dynamicsMeta[normalizeDyn(value)].gain;
}

function dynamicsDuration(value) {
  return dynamicsMeta[normalizeDyn(value)].duration;
}

// 方案指纹只由谱面（口令+力度）决定；速度、剧名、批注改动不影响方案有效性
function scoreSignature(pattern, dynamics) {
  return JSON.stringify({ p: pattern, d: dynamics });
}

function measureCounts(pattern, dynamics, measure) {
  const counts = { total: 0, f: 0, m: 0, p: 0, unmarked: 0 };
  for (let step = measure * beatsPerMeasure; step < (measure + 1) * beatsPerMeasure; step += 1) {
    pattern.forEach((row, rowIndex) => {
      if (!row[step]) return;
      counts.total += 1;
      const value = dynamics[rowIndex][step];
      if (value === "f" || value === "m" || value === "p") counts[value] += 1;
      else counts.unmarked += 1;
    });
  }
  return counts;
}

// 规则一：同一小节不能全部为弱（空小节不判）
function findWeakMeasures(pattern, dynamics) {
  const result = [];
  for (let measure = 0; measure < steps / beatsPerMeasure; measure += 1) {
    const counts = measureCounts(pattern, dynamics, measure);
    if (counts.total > 0 && counts.p === counts.total) result.push(measure);
  }
  return result;
}

// 规则二：同拍两件及以上击乐同时标强——只报告、保留原谱
function findStrongClashes(pattern, dynamics) {
  const clashes = [];
  for (let step = 0; step < steps; step += 1) {
    const rows = [];
    pattern.forEach((row, rowIndex) => {
      if (row[step] && dynamics[rowIndex][step] === "f") rows.push(rowIndex);
    });
    if (rows.length >= 2) {
      clashes.push({
        step,
        measure: Math.floor(step / beatsPerMeasure),
        beat: step % beatsPerMeasure,
        rows,
        names: rows.map((rowIndex) => instruments[rowIndex].name)
      });
    }
  }
  return clashes;
}

function evaluateScore(pattern, dynamics) {
  const weakMeasures = findWeakMeasures(pattern, dynamics);
  const clashes = findStrongClashes(pattern, dynamics);
  return { weakMeasures, clashes, issueCount: weakMeasures.length + clashes.length };
}

/* ==================== 存储层：持久化、迁移、失效留档与重复保存 ==================== */

function emptyDynamics(pattern) {
  return pattern.map((row) => row.map(() => ""));
}

function loadState() {
  const parsed = JSON.parse(localStorage.getItem(storageKey) || "null") || {
    pieceName: "出场锣鼓-慢起",
    bpm: 96,
    loop: "",
    notes: [],
    pattern: instruments.map((instrument) =>
      Array.from({ length: steps }, (_, index) => index % 4 === 0 ? instrument.token : "")
    ),
    saved: []
  };
  // 旧版数据迁移：补齐力度矩阵与方案指纹
  if (!parsed.dynamics) parsed.dynamics = emptyDynamics(parsed.pattern);
  for (const entry of parsed.saved) {
    if (!entry.dynamics) entry.dynamics = emptyDynamics(entry.pattern);
    if (!entry.signature) entry.signature = scoreSignature(entry.pattern, entry.dynamics);
  }
  return parsed;
}

function persist() {
  localStorage.setItem(storageKey, JSON.stringify(state));
}

function currentSignature() {
  return scoreSignature(state.pattern, state.dynamics);
}

// 谱面一改，指纹不符的已存方案即刻失效并留档；重新吻合则恢复有效
function reconcileSaved() {
  const signature = currentSignature();
  const now = new Date().toISOString();
  for (const entry of state.saved) {
    if (entry.signature === signature) entry.archivedAt = null;
    else if (!entry.archivedAt) entry.archivedAt = now;
  }
}

// 重复保存沿用首次结果：同一谱面指纹只保留首条方案
function saveCurrentPlan() {
  const signature = currentSignature();
  const prior = state.saved.find((entry) => entry.signature === signature);
  if (prior) {
    prior.archivedAt = null;
    return { reused: true, entry: prior };
  }
  const entry = {
    id: crypto.randomUUID(),
    name: state.pieceName || "未命名片段",
    bpm: state.bpm,
    loop: state.loop,
    notes: [...state.notes],
    pattern: state.pattern.map((row) => [...row]),
    dynamics: state.dynamics.map((row) => [...row]),
    signature,
    issueCount: evaluateScore(state.pattern, state.dynamics).issueCount,
    createdAt: new Date().toISOString(),
    archivedAt: null
  };
  state.saved.unshift(entry);
  return { reused: false, entry };
}

function loadPlan(id) {
  const item = state.saved.find((entry) => entry.id === id);
  if (!item || item.archivedAt) return false; // 留档方案仅供查阅，不能载入
  state.pieceName = item.name;
  state.bpm = item.bpm;
  state.loop = item.loop;
  state.notes = [...item.notes];
  state.pattern = item.pattern.map((row) => [...row]);
  state.dynamics = item.dynamics.map((row) => [...row]);
  reconcileSaved();
  return true;
}

/* ==================== 界面层 ==================== */

const state = loadState();

let timer = null;
let playhead = 0;
let audioContext = null;

const grid = document.querySelector("#grid");
const savedList = document.querySelector("#savedList");
const structure = document.querySelector("#structure");
const notesList = document.querySelector("#notesList");
const balance = document.querySelector("#balance");
const saveHint = document.querySelector("#saveHint");
const pieceName = document.querySelector("#pieceName");
const bpmInput = document.querySelector("#bpmInput");
const loopSelect = document.querySelector("#loopSelect");
const noteInput = document.querySelector("#noteInput");

function syncFields() {
  pieceName.value = state.pieceName;
  bpmInput.value = state.bpm;
  loopSelect.value = state.loop;
}

function beatLabel(index) {
  const measure = Math.floor(index / beatsPerMeasure) + 1;
  const beat = (index % beatsPerMeasure) + 1;
  return `${measure}-${beat}`;
}

function fmtDate(iso) {
  const date = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function scoreCounts(pattern, dynamics) {
  const counts = { total: 0, f: 0, m: 0, p: 0 };
  pattern.forEach((row, rowIndex) => row.forEach((value, step) => {
    if (!value) return;
    counts.total += 1;
    if (dynamics[rowIndex][step] === "f" || dynamics[rowIndex][step] === "p") counts[dynamics[rowIndex][step]] += 1;
  }));
  counts.m = counts.total - counts.f - counts.p; // 中标含未标注
  return counts;
}

function renderGrid() {
  const result = evaluateScore(state.pattern, state.dynamics);
  const weakMeasures = new Set(result.weakMeasures);
  const clashCells = new Set();
  result.clashes.forEach((clash) => clash.rows.forEach((row) => clashCells.add(`${row}-${clash.step}`)));

  const header = ['<div class="label-cell">乐器</div>'];
  for (let i = 0; i < steps; i += 1) {
    const weak = weakMeasures.has(Math.floor(i / beatsPerMeasure)) ? " weak-measure" : "";
    header.push(`<div class="beat-cell${weak}">${beatLabel(i)}</div>`);
  }

  const rows = instruments.flatMap((instrument, rowIndex) => {
    const row = [`<div class="label-cell">${instrument.name}</div>`];
    for (let step = 0; step < steps; step += 1) {
      const value = state.pattern[rowIndex][step];
      const dyn = state.dynamics[rowIndex][step] || "none";
      if (!value) {
        row.push(`<div class="cell" data-row="${rowIndex}" data-step="${step}" role="button" title="点击填入口令（${instrument.name}）"></div>`);
        return row;
      }
      const clash = clashCells.has(`${rowIndex}-${step}`) ? " clash" : "";
      const dynButtons = dynamicsOrder.map((key) =>
        `<button class="dyn-btn ${key} ${state.dynamics[rowIndex][step] === key ? "active" : ""}" type="button" data-dyn="${key}" data-row="${rowIndex}" data-step="${step}" title="标${dynamicsMeta[key].label}">${dynamicsMeta[key].label}</button>`
      ).join("");
      row.push(`
        <div class="cell filled dyn-${dyn}${clash}" data-row="${rowIndex}" data-step="${step}">
          <button class="token-btn" type="button" data-row="${rowIndex}" data-step="${step}" title="再次点击删除口令">${value}</button>
          <span class="dyn-row">${dynButtons}</span>
        </div>`);
    }
    return row;
  });

  grid.innerHTML = [...header, ...rows].join("");
}

function renderStructure() {
  structure.innerHTML = [0, 1, 2, 3].map((measure) => {
    const counts = measureCounts(state.pattern, state.dynamics, measure);
    return `
      <div class="structure-row">
        <span>第${measure + 1}小节 <em>${counts.total}口令</em></span>
        <span class="dyn-counts">
          <b class="f">强${counts.f}</b><b class="m">中${counts.m + counts.unmarked}</b><b class="p">弱${counts.p}</b>
        </span>
      </div>`;
  }).join("");
}

function renderBalance() {
  const result = evaluateScore(state.pattern, state.dynamics);
  const items = [];
  result.weakMeasures.forEach((measure) => {
    items.push(`<div class="balance-item warn"><strong>声部失衡</strong>第${measure + 1}小节口令全部标弱，至少保留一处中强力度。</div>`);
  });
  result.clashes.forEach((clash) => {
    items.push(`<div class="balance-item conflict"><strong>强声相撞</strong>第${clash.measure + 1}小节第${clash.beat + 1}拍：${clash.names.join("、")}同时标强，已保留原谱。</div>`);
  });
  balance.innerHTML = items.join("") || "<p>力度分布平衡，暂无冲突。</p>";
}

function renderSaved() {
  const valid = [];
  const archived = [];
  state.saved.forEach((entry) => (entry.archivedAt ? archived : valid).push(entry));

  const validHtml = valid.length ? valid.map((item) => {
    const counts = scoreCounts(item.pattern, item.dynamics);
    return `
      <button class="saved-item" type="button" data-load="${item.id}">
        <span class="badge ok">有效</span><strong>${item.name}</strong><br>
        <span>${item.bpm}BPM · ${counts.total}口令（强${counts.f} 中${counts.m} 弱${counts.p}）· ${item.notes.length}条批注</span><br>
        <span class="time">保存于 ${fmtDate(item.createdAt)}${item.issueCount ? ` · 含${item.issueCount}处平衡提示` : ""}</span>
      </button>`;
  }).join("") : "<p>还没有有效方案。</p>";

  const archivedHtml = archived.length ? `
    <h3 class="archive-title">失效留档（${archived.length}）</h3>
    ${archived.map((item) => `
      <div class="saved-item archived">
        <span class="badge off">已失效·留档</span><strong>${item.name}</strong><br>
        <span class="time">保存于 ${fmtDate(item.createdAt)} · 失效于 ${fmtDate(item.archivedAt)}</span><br>
        <span>谱面口令或力度已改动，原方案留档备查。</span>
      </div>`).join("")}
  ` : "";

  savedList.innerHTML = validHtml + archivedHtml;
}

function renderNotes() {
  notesList.innerHTML = state.notes.length ? state.notes.map((note) => `
    <article class="note"><p>${note}</p></article>
  `).join("") : "<p>暂无批注。</p>";
}

function renderSidebars() {
  renderStructure();
  renderBalance();
  renderNotes();
  renderSaved();
}

function render() {
  syncFields();
  renderGrid();
  renderSidebars();
}

function flashHint(text, kind) {
  saveHint.textContent = text;
  saveHint.className = `save-hint ${kind || "ok"}`;
  saveHint.hidden = false;
}

/* ----- 谱面编辑：口令增删与力度标注，改动即触发方案失效 ----- */

function afterScoreEdit() {
  reconcileSaved();
  persist();
}

function toggleCommand(row, step) {
  if (state.pattern[row][step]) {
    state.pattern[row][step] = "";
    state.dynamics[row][step] = "";
  } else {
    state.pattern[row][step] = instruments[row].token;
  }
  afterScoreEdit();
}

function applyDynamics(row, step, dyn) {
  if (!state.pattern[row][step]) return;
  state.dynamics[row][step] = state.dynamics[row][step] === dyn ? "" : dyn; // 再点一次取消标注
  afterScoreEdit();
}

function playSound(instrument, dyn) {
  audioContext ||= new AudioContext();
  const osc = audioContext.createOscillator();
  const gain = audioContext.createGain();
  osc.frequency.value = instrument.freq;
  osc.type = instrument.name === "鼓" ? "sine" : "square";
  const level = dynamicsGain(dyn);
  gain.gain.setValueAtTime(level, audioContext.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + dynamicsDuration(dyn));
  osc.connect(gain).connect(audioContext.destination);
  osc.start();
  osc.stop(audioContext.currentTime + dynamicsDuration(dyn) + 0.01);
}

function highlight(step) {
  document.querySelectorAll(".cell.playing").forEach((cell) => cell.classList.remove("playing"));
  document.querySelectorAll(`[data-step="${step}"]`).forEach((cell) => cell.classList.add("playing"));
}

function currentRange() {
  if (state.loop === "") return [0, steps - 1];
  const start = Number(state.loop) * beatsPerMeasure;
  return [start, start + beatsPerMeasure - 1];
}

function tick() {
  const [start, end] = currentRange();
  if (playhead < start || playhead > end) playhead = start;
  highlight(playhead);
  instruments.forEach((instrument, rowIndex) => {
    if (state.pattern[rowIndex][playhead]) {
      playSound(instrument, state.dynamics[rowIndex][playhead]);
    }
  });
  playhead = playhead >= end ? start : playhead + 1;
}

grid.addEventListener("click", (event) => {
  const dynButton = event.target.closest("[data-dyn]");
  if (dynButton) {
    applyDynamics(Number(dynButton.dataset.row), Number(dynButton.dataset.step), dynButton.dataset.dyn);
    render();
    return;
  }
  const cell = event.target.closest(".cell");
  if (!cell) return;
  toggleCommand(Number(cell.dataset.row), Number(cell.dataset.step));
  render();
});

pieceName.addEventListener("input", () => {
  state.pieceName = pieceName.value;
  persist();
});

bpmInput.addEventListener("input", () => {
  state.bpm = Number(bpmInput.value || 96);
  persist();
  if (timer) {
    clearInterval(timer);
    timer = setInterval(tick, 60000 / state.bpm);
  }
});

loopSelect.addEventListener("change", () => {
  state.loop = loopSelect.value;
  playhead = currentRange()[0];
  persist();
});

noteInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || !noteInput.value.trim()) return;
  state.notes.unshift(noteInput.value.trim());
  noteInput.value = "";
  persist();
  renderNotes();
});

document.querySelector("#playBtn").addEventListener("click", () => {
  if (timer) clearInterval(timer);
  playhead = currentRange()[0];
  tick();
  timer = setInterval(tick, 60000 / state.bpm);
});

document.querySelector("#stopBtn").addEventListener("click", () => {
  clearInterval(timer);
  timer = null;
  document.querySelectorAll(".cell.playing").forEach((cell) => cell.classList.remove("playing"));
});

document.querySelector("#saveBtn").addEventListener("click", () => {
  const result = saveCurrentPlan();
  persist();
  renderSaved();
  if (result.reused) {
    flashHint(`该谱面已于 ${fmtDate(result.entry.createdAt)} 保存为《${result.entry.name}》，沿用首次结果，不重复保存。`, "info");
  } else {
    flashHint(`已保存新方案《${result.entry.name}》。`, "ok");
  }
});

savedList.addEventListener("click", (event) => {
  const id = event.target.closest("[data-load]")?.dataset.load;
  if (!id || !loadPlan(id)) return;
  persist();
  render();
  flashHint("已载入有效方案。", "ok");
});

reconcileSaved();
persist();
render();
