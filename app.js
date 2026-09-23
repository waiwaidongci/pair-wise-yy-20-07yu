/* 锣鼓经排练网格 —— 规则层 / 存储层 / 界面层 各自独立 */

const storageKey = "wxyy-4-luogujing-grid";
const instruments = [
  { name: "大锣", token: "仓", freq: 180 },
  { name: "鼓", token: "冬", freq: 120 },
  { name: "钹", token: "才", freq: 360 },
  { name: "小锣", token: "台", freq: 520 }
];
const steps = 16;
const beatsPerMeasure = 4;
const measures = steps / beatsPerMeasure;

/* ================= 规则层：力度分层与声部平衡（纯函数） ================= */

const dynamicLevels = [
  { id: "f", label: "强", gain: 0.16 },
  { id: "m", label: "中", gain: 0.08 },
  { id: "p", label: "弱", gain: 0.03 }
];
const defaultDynamicId = "m"; // 未标注的口令按中音播放

function dynamicById(id) {
  return dynamicLevels.find((level) => level.id === id) || null;
}

function dynamicLabel(id) {
  return (dynamicById(id) || dynamicById(defaultDynamicId)).label;
}

function playbackGain(id) {
  return (dynamicById(id) || dynamicById(defaultDynamicId)).gain;
}

// 角标循环：未标注 → 强 → 中 → 弱 → 未标注
function nextDynamic(id) {
  if (id === null) return "f";
  if (id === "f") return "m";
  if (id === "m") return "p";
  return null;
}

// 只给已填口令保留合法力度，空格一律清空
function normalizeDynamics(pattern, source) {
  return instruments.map((_, row) => Array.from({ length: steps }, (_, step) => {
    if (!pattern[row] || !pattern[row][step]) return null;
    const value = source && source[row] ? source[row][step] : null;
    return dynamicById(value) ? value : null;
  }));
}

// 谱面身份：只由口令与力度决定（改名、调速、加批注不影响）
function scoreSignature(pattern, dynamicGrid) {
  return JSON.stringify({ p: pattern, d: dynamicGrid });
}

// 声部平衡校验：返回全部冲突，不改动原谱
function findConflicts(pattern, dynamicGrid) {
  const result = [];

  // 规则一：同一小节的已填口令不能全部标弱（空小节不判定）
  for (let measure = 0; measure < measures; measure += 1) {
    const cells = [];
    const start = measure * beatsPerMeasure;
    for (let step = start; step < start + beatsPerMeasure; step += 1) {
      for (let row = 0; row < instruments.length; row += 1) {
        if (pattern[row][step]) cells.push({ row, step, mark: dynamicGrid[row][step] });
      }
    }
    if (cells.length && cells.every((cell) => cell.mark === "p")) {
      result.push({ type: "allWeak", measure: measure + 1, cells });
    }
  }

  // 规则二：同拍两件（含以上）击乐同时标强 —— 保留原谱，指出小节与乐器
  for (let step = 0; step < steps; step += 1) {
    const strong = [];
    instruments.forEach((instrument, row) => {
      if (pattern[row][step] && dynamicGrid[row][step] === "f") {
        strong.push({ row, step, name: instrument.name });
      }
    });
    if (strong.length >= 2) {
      result.push({
        type: "doubleStrong",
        measure: Math.floor(step / beatsPerMeasure) + 1,
        beat: (step % beatsPerMeasure) + 1,
        instruments: strong.map((item) => item.name),
        cells: strong
      });
    }
  }

  return result;
}

/* ================= 存储层：持久化、失效留档、重复保存去重 ================= */

function defaultPattern() {
  return instruments.map((instrument) =>
    Array.from({ length: steps }, (_, index) => (index % 4 === 0 ? instrument.token : ""))
  );
}

function createState() {
  const pattern = defaultPattern();
  return {
    pieceName: "出场锣鼓-慢起",
    bpm: 96,
    loop: "",
    notes: [],
    pattern,
    dynamics: normalizeDynamics(pattern, null),
    saved: []
  };
}

function nowIso() {
  return new Date().toISOString();
}

function normalizePlan(record) {
  const pattern = Array.isArray(record.pattern)
    ? record.pattern.map((row) => [...row])
    : defaultPattern();
  const dynamicGrid = normalizeDynamics(pattern, record.dynamics);
  return {
    id: record.id || crypto.randomUUID(),
    name: record.name || "未命名片段",
    bpm: Number.isFinite(Number(record.bpm)) ? Number(record.bpm) : 96,
    loop: record.loop ?? "",
    notes: Array.isArray(record.notes) ? [...record.notes] : [],
    pattern,
    dynamics: dynamicGrid,
    signature: scoreSignature(pattern, dynamicGrid),
    createdAt: record.createdAt || nowIso(),
    status: record.status === "archived" ? "archived" : "active",
    archivedAt: record.archivedAt || null,
    archiveReason: record.archiveReason || null
  };
}

function normalizeState(raw) {
  const base = raw && typeof raw === "object" ? raw : {};
  const state = {
    pieceName: base.pieceName ?? "出场锣鼓-慢起",
    bpm: Number.isFinite(Number(base.bpm)) ? Number(base.bpm) : 96,
    loop: base.loop ?? "",
    notes: Array.isArray(base.notes) ? [...base.notes] : [],
    pattern: Array.isArray(base.pattern) ? base.pattern.map((row) => [...row]) : defaultPattern(),
    dynamics: null,
    saved: Array.isArray(base.saved) ? base.saved.map(normalizePlan) : []
  };
  state.dynamics = normalizeDynamics(state.pattern, base.dynamics);
  return state;
}

// 与当前谱面对不上的活动方案一律留档（编辑后调用，刷新载入时也调用以保证一致）
function archiveStalePlans(target, reason) {
  const current = scoreSignature(target.pattern, target.dynamics);
  const stampedAt = nowIso();
  let count = 0;
  target.saved.forEach((record) => {
    if (record.status === "active" && record.signature !== current) {
      record.status = "archived";
      record.archivedAt = stampedAt;
      record.archiveReason = reason;
      count += 1;
    }
  });
  return count;
}

function loadState() {
  let raw = null;
  try {
    raw = JSON.parse(localStorage.getItem(storageKey) || "null");
  } catch {
    raw = null;
  }
  const state = normalizeState(raw);
  archiveStalePlans(state, "谱面已变更");
  try {
    localStorage.setItem(storageKey, JSON.stringify(state));
  } catch {
    // 存储不可用时仅内存内保持一致
  }
  return state;
}

function persist() {
  localStorage.setItem(storageKey, JSON.stringify(state));
}

// 力度调整 / 口令增删 后统一收口：清理空格力度、失效留档、落盘
function applyScoreChange(reason, mutate) {
  mutate();
  state.dynamics = normalizeDynamics(state.pattern, state.dynamics);
  const archived = archiveStalePlans(state, reason);
  persist();
  return archived;
}

// 保存方案：同一谱面（口令+力度）永远沿用首次保存结果
function saveCurrentPlan() {
  const signature = scoreSignature(state.pattern, state.dynamics);
  let match = null;
  state.saved.forEach((record) => {
    if (record.signature === signature && (!match || record.createdAt < match.createdAt)) {
      match = record;
    }
  });

  if (match) {
    if (match.status !== "active") {
      match.status = "active";
      match.archivedAt = null;
      match.archiveReason = null;
    }
    persist();
    return { record: match, reused: true };
  }

  const record = normalizePlan({
    id: crypto.randomUUID(),
    name: state.pieceName || "未命名片段",
    bpm: state.bpm,
    loop: state.loop,
    notes: state.notes,
    pattern: state.pattern.map((row) => [...row]),
    dynamics: state.dynamics.map((row) => [...row]),
    createdAt: nowIso()
  });
  state.saved.unshift(record);
  persist();
  return { record, reused: false };
}

/* ================= 界面层：渲染、交互、播放 ================= */

const state = loadState();

let timer = null;
let playhead = 0;
let audioContext = null;

const grid = document.querySelector("#grid");
const savedList = document.querySelector("#savedList");
const archiveList = document.querySelector("#archiveList");
const structure = document.querySelector("#structure");
const notesList = document.querySelector("#notesList");
const conflictPanel = document.querySelector("#conflictPanel");
const statusMsg = document.querySelector("#statusMsg");
const pieceName = document.querySelector("#pieceName");
const bpmInput = document.querySelector("#bpmInput");
const loopSelect = document.querySelector("#loopSelect");
const noteInput = document.querySelector("#noteInput");

function setStatus(text) {
  statusMsg.textContent = text || "";
}

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

function formatTime(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return iso;
  }
}

function dynamicTally(pattern, dynamicGrid) {
  const tally = { f: 0, m: 0, p: 0 };
  pattern.forEach((row, rowIndex) => row.forEach((value, step) => {
    if (!value) return;
    const mark = dynamicGrid[rowIndex][step];
    tally[mark === "f" || mark === "p" ? mark : "m"] += 1;
  }));
  return tally;
}

function conflictCellSet() {
  const set = new Set();
  findConflicts(state.pattern, state.dynamics).forEach((conflict) => {
    conflict.cells.forEach((cell) => set.add(`${cell.row}-${cell.step}`));
  });
  return set;
}

function renderGrid() {
  const conflictCells = conflictCellSet();
  const header = ['<div class="label-cell">乐器</div>'];
  for (let i = 0; i < steps; i += 1) {
    header.push(`<div class="beat-cell">${beatLabel(i)}</div>`);
  }

  const rows = instruments.flatMap((instrument, rowIndex) => {
    const row = [`<div class="label-cell">${instrument.name}</div>`];
    for (let step = 0; step < steps; step += 1) {
      const value = state.pattern[rowIndex][step];
      const mark = state.dynamics[rowIndex][step];
      const classes = [
        "cell",
        value ? "filled" : "",
        value ? (mark ? `dyn-${mark}` : "dyn-none") : "",
        conflictCells.has(`${rowIndex}-${step}`) ? "conflict" : ""
      ].filter(Boolean).join(" ");
      const badge = value
        ? `<button class="dyn-badge ${mark ? `badge-${mark}` : "badge-none"}" type="button"
             data-dyn="${rowIndex}:${step}" aria-label="切换力度"
             title="点击循环：未标注（按中音）→ 强 → 中 → 弱">${dynamicLabel(mark)}</button>`
        : "";
      row.push(`<div class="${classes}" role="button" tabindex="0"
        aria-label="${instrument.name}${beatLabel(step)}${value ? `，力度${dynamicLabel(mark)}` : "，空"}"
        data-row="${rowIndex}" data-step="${step}"><span class="token">${value}</span>${badge}</div>`);
    }
    return row;
  });

  grid.innerHTML = [...header, ...rows].join("");
}

function renderConflicts() {
  const conflicts = findConflicts(state.pattern, state.dynamics);
  if (!conflicts.length) {
    conflictPanel.innerHTML = `<p class="conflict-ok">力度规则校验通过：无整小节全弱，无同拍双强。</p>`;
    return;
  }
  conflictPanel.innerHTML = conflicts.map((conflict) => {
    if (conflict.type === "allWeak") {
      return `<div class="conflict-item conflict-weak">
        <strong>整小节偏弱</strong>：第${conflict.measure}小节已填口令全部标弱，
        需至少保留一个中或强。</div>`;
    }
    return `<div class="conflict-item conflict-strong">
      <strong>同拍双强</strong>：第${conflict.measure}小节第${conflict.beat}拍
      ${conflict.instruments.join("、")}同时标强，声部失衡，保留原谱，请调整其中一件。</div>`;
  }).join("");
}

function renderSidebars() {
  const weakMeasures = new Set(
    findConflicts(state.pattern, state.dynamics)
      .filter((item) => item.type === "allWeak")
      .map((item) => item.measure)
  );

  structure.innerHTML = Array.from({ length: measures }, (_, measure) => {
    const start = measure * beatsPerMeasure;
    const slicePattern = state.pattern.map((row) => row.slice(start, start + beatsPerMeasure));
    const sliceDynamics = state.dynamics.map((row) => row.slice(start, start + beatsPerMeasure));
    const tally = dynamicTally(slicePattern, sliceDynamics);
    const total = tally.f + tally.m + tally.p;
    const warning = weakMeasures.has(measure + 1) ? `<em class="warn">全弱</em>` : "";
    return `<div class="structure-row">
      <span>第${measure + 1}小节 ${warning}<small>${total}个口令</small></span>
      <span class="dynam-tally">
        <b class="t-f">强${tally.f}</b><b class="t-m">中${tally.m}</b><b class="t-p">弱${tally.p}</b>
      </span></div>`;
  }).join("");

  notesList.innerHTML = state.notes.length ? state.notes.map((note) => `
    <article class="note"><p>${note}</p></article>
  `).join("") : "<p>暂无批注。</p>";

  const active = state.saved.filter((item) => item.status !== "archived");
  const archived = state.saved.filter((item) => item.status === "archived");

  savedList.innerHTML = active.length ? active.map((item) => {
    const tally = dynamicTally(item.pattern, item.dynamics);
    return `<button class="saved-item" type="button" data-load="${item.id}">
      <span class="saved-head"><strong>${item.name}</strong><i class="tag tag-active">当前谱面</i></span>
      <span class="saved-meta">${item.bpm}BPM · ${item.notes.length}条批注 ·
        强${tally.f}/中${tally.m}/弱${tally.p}</span>
    </button>`;
  }).join("") : "<p>还没有有效方案，调整好谱面后点“保存方案”。</p>";

  archiveList.innerHTML = archived.length ? archived.map((item) => `
    <div class="archived-item" title="已失效留档，仅供查阅">
      <span class="saved-head"><strong>${item.name}</strong><i class="tag tag-archived">已失效</i></span>
      <span class="saved-meta">${item.archiveReason || "谱面已变更"} · ${formatTime(item.archivedAt || item.createdAt)}</span>
    </div>`).join("") : "<p>暂无失效留档。</p>";
}

function render() {
  syncFields();
  renderGrid();
  renderConflicts();
  renderSidebars();
}

/* ---------- 播放 ---------- */

function playSound(instrument, mark) {
  audioContext ||= new AudioContext();
  const osc = audioContext.createOscillator();
  const gain = audioContext.createGain();
  osc.frequency.value = instrument.freq;
  osc.type = instrument.name === "鼓" ? "sine" : "square";
  const peak = playbackGain(mark); // 未标注取中音
  gain.gain.setValueAtTime(peak, audioContext.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.08);
  osc.connect(gain).connect(audioContext.destination);
  osc.start();
  osc.stop(audioContext.currentTime + 0.09);
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

/* ---------- 网格交互：左键增删口令，角标切力度 ---------- */

grid.addEventListener("click", (event) => {
  const badge = event.target.closest("[data-dyn]");
  if (badge) {
    const [row, step] = badge.dataset.dyn.split(":").map(Number);
    const archived = applyScoreChange("力度调整", () => {
      state.dynamics[row][step] = nextDynamic(state.dynamics[row][step]);
    });
    render();
    setStatus(archived ? `力度已调整，${archived}个关联方案失效并留档。` : "力度已调整，未标注按中音播放。");
    return;
  }

  const cell = event.target.closest(".cell");
  if (!cell) return;
  const row = Number(cell.dataset.row);
  const step = Number(cell.dataset.step);
  const archived = applyScoreChange("口令增删", () => {
    state.pattern[row][step] = state.pattern[row][step] ? "" : instruments[row].token;
  });
  render();
  setStatus(archived ? `口令已变更，${archived}个关联方案失效并留档。` : "口令已变更。");
});

grid.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const cell = event.target.closest(".cell");
  if (!cell || event.target.closest("[data-dyn]")) return;
  event.preventDefault();
  cell.click();
});

/* ---------- 其余控件：不触发方案失效 ---------- */

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
  renderSidebars();
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

/* ---------- 保存 / 载入 ---------- */

document.querySelector("#saveBtn").addEventListener("click", () => {
  const { record, reused } = saveCurrentPlan();
  renderSidebars();
  setStatus(reused
    ? `「${record.name}」此前已保存，沿用首次保存结果（${formatTime(record.createdAt)}）。`
    : `已保存方案：${record.name}`);
});

savedList.addEventListener("click", (event) => {
  const id = event.target.closest("[data-load]")?.dataset.load;
  const item = state.saved.find((entry) => entry.id === id && entry.status !== "archived");
  if (!item) return;
  state.pieceName = item.name;
  state.bpm = item.bpm;
  state.loop = item.loop;
  state.notes = [...item.notes];
  state.pattern = item.pattern.map((row) => [...row]);
  state.dynamics = item.dynamics.map((row) => [...row]);
  archiveStalePlans(state, "载入其他方案");
  persist();
  render();
  setStatus(`已载入方案：${item.name}`);
});

render();
