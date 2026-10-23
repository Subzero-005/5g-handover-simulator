import { TECH, TTT_VALUES, HO_TIMING, UE_KINDS, SCENARIOS } from '../sim/index.js';
import { LineChart, drawUeChart } from './charts.js';
import { RAMP, SCALES } from '../render/heatmap.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const LOG_LIMIT = 80;
const CAUSE_LABEL = {
  'too-late': 'too late',
  'too-early': 'too early',
  'wrong-cell': 'wrong cell',
  'coverage-hole': 'coverage hole',
  'cell-outage': 'cell outage',
};
const STATE_LABEL = { idle: 'Searching', connected: 'Connected', executing: 'Handover', reestablishing: 'Re-establishing' };

const fmtClock = (ms) => {
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const ss = (s % 60).toFixed(1).padStart(4, '0');
  return h ? `${h}:${String(m % 60).padStart(2, '0')}:${ss}` : `${String(m).padStart(2, '0')}:${ss}`;
};
const fmtRate = (mbps) => (mbps >= 1000 ? `${(mbps / 1000).toFixed(2)}<small>Gbps</small>` : `${mbps.toFixed(mbps < 10 ? 1 : 0)}<small>Mbps</small>`);
const getPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
const patchFor = (path, value) => {
  const [a, b] = path.split('.');
  return b ? { [a]: { [b]: value } } : { [a]: value };
};

// Wires the DOM controls, analytics panel and inspectors to the simulation.
export class UI {
  constructor(sim, world) {
    this.sim = sim;
    this.world = world;
    this.running = true;
    this.speed = 1;
    this.logQueue = [];
    this.logFilter = 'all';
    this.keys = new Set();
    this.driving = null;
    this.lastKpi = null;
    this.rejectSeen = new Map();
    this.timers = { fast: 0, slow: 0 };

    this.buildScenarioSelect();
    this.buildFields();
    this.bindTopbar();
    this.bindPanels();
    this.bindDisplay();
    this.bindToolbar();
    this.bindKeyboard();
    this.bindSimEvents();

    this.hoChart = new LineChart($('#chart-ho'), [
      { key: 'hoPerMin', color: '--primary', fill: true },
      { key: 'failPerMin', color: '--error' },
    ]);
    this.thrChart = new LineChart($('#chart-thr'), [{ key: 'avgThroughput', color: '--tertiary', fill: true }], { minMax: 10 });

    world.onSelect = (sel) => this.showSelection(sel);
    world.onPlaced = (t) => this.toast('add_location_alt', `${TECH[t.tech].label} site ${t.name} placed${t.hostBuilding >= 0 ? ' on a rooftop' : ''}`);
    this.onReset();
  }

  // ------------------------------------------------------------- top bar

  buildScenarioSelect() {
    const sel = $('#scenario');
    for (const sc of Object.values(SCENARIOS)) {
      const o = document.createElement('option');
      o.value = sc.id;
      o.textContent = sc.name;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => {
      this.stopDriving();
      this.sim.load(sel.value);
      this.toast('map', `${this.sim.scenario.name}: ${this.sim.scenario.description}`);
    });
  }

  bindTopbar() {
    $('#btn-play').addEventListener('click', () => this.setRunning(!this.running));
    $('#btn-step').addEventListener('click', () => {
      this.setRunning(false);
      this.sim.tick();
    });
    $$('#speed button').forEach((b) => b.addEventListener('click', () => this.setSpeed(Number(b.dataset.speed))));
    $('#btn-reset').addEventListener('click', () => {
      this.stopDriving();
      this.sim.reset();
      this.toast('restart_alt', 'Scenario restarted');
    });
    $('#btn-camera').addEventListener('click', () => this.world.resetCamera());
    $('#btn-help').addEventListener('click', () => $('#help').showModal());
    $('#help').addEventListener('click', (e) => e.target.id === 'help' && $('#help').close());
  }

  setRunning(on) {
    this.running = on;
    const btn = $('#btn-play');
    btn.innerHTML = `<span class="ms">${on ? 'pause' : 'play_arrow'}</span>`;
    btn.title = on ? 'Pause (Space)' : 'Play (Space)';
  }

  setSpeed(s) {
    this.speed = s;
    $$('#speed button').forEach((b) => b.classList.toggle('active', Number(b.dataset.speed) === s));
  }

  // -------------------------------------------------------------- fields

  buildFields() {
    for (const el of $$('.field')) {
      const kind = el.dataset.kind;
      const id = `f-${el.dataset.param ?? kind}`.replace('.', '-');
      el.innerHTML = `<div class="field-head"><label for="${id}">${el.dataset.label}</label><output></output></div><input type="range" id="${id}" />`;
      const input = $('input', el);
      const out = $('output', el);
      if (kind === 'ttt') {
        input.min = 0;
        input.max = TTT_VALUES.length - 1;
        input.step = 1;
      } else {
        input.min = el.dataset.min;
        input.max = el.dataset.max;
        input.step = el.dataset.step;
      }
      const paint = () => {
        const pct = ((input.value - input.min) / (input.max - input.min)) * 100;
        input.style.setProperty('--pct', `${pct}%`);
        if (kind === 'ttt') out.textContent = `${TTT_VALUES[input.value]} ms`;
        else out.textContent = `${Number(input.value).toFixed(input.step < 1 ? 1 : 0)}${el.dataset.unit ? ' ' + el.dataset.unit : ''}`;
      };
      input.addEventListener('input', () => {
        paint();
        if (kind === 'ttt') this.sim.setParams({ tttMs: TTT_VALUES[input.value] });
        else if (kind === 'ues') this.sim.setUeCount(Number(input.value));
        else this.sim.setParams(patchFor(el.dataset.param, Number(input.value)));
      });
      el._sync = () => {
        if (kind === 'ttt') {
          const idx = TTT_VALUES.indexOf(this.sim.params.tttMs);
          input.value = idx >= 0 ? idx : TTT_VALUES.indexOf(320);
        } else if (kind === 'ues') input.value = this.sim.ues.size;
        else input.value = getPath(this.sim.params, el.dataset.param);
        paint();
      };
    }
    $('#mlb').addEventListener('change', (e) => {
      this.sim.setParams({ mlbEnabled: e.target.checked });
      this.toast('balance', e.target.checked ? 'Load balancing on: busy cells now repel new handovers' : 'Load balancing off');
    });
    $('#ext-int').addEventListener('change', (e) => this.sim.setParams({ externalInterference: e.target.checked }));
  }

  syncFields() {
    $$('.field').forEach((el) => el._sync?.());
    $('#mlb').checked = this.sim.params.mlbEnabled;
    $('#ext-int').checked = this.sim.params.externalInterference;
  }

  // -------------------------------------------------------------- panels

  bindPanels() {
    const left = $('#panel-left');
    const right = $('#panel-right');
    const small = () => window.matchMedia('(max-width: 1020px)').matches;
    const apply = () => {
      if (small()) {
        left.classList.add('collapsed');
        right.classList.add('collapsed');
      } else {
        left.classList.remove('collapsed');
        right.classList.remove('collapsed');
      }
    };
    apply();
    window.matchMedia('(max-width: 1020px)').addEventListener('change', apply);
    $('#toggle-left').addEventListener('click', () => {
      left.classList.toggle('collapsed');
      right.classList.add('collapsed');
    });
    $('#toggle-right').addEventListener('click', () => {
      right.classList.toggle('collapsed');
      left.classList.add('collapsed');
    });
    $$('#log-filter button').forEach((b) =>
      b.addEventListener('click', () => {
        this.logFilter = b.dataset.filter;
        $$('#log-filter button').forEach((x) => x.classList.toggle('active', x === b));
        $$('#log li').forEach((li) => (li.hidden = this.logFilter === 'fail' && li.classList.contains('ok')));
      }),
    );
    $('#log').addEventListener('click', (e) => {
      const li = e.target.closest('li[data-ue]');
      if (li && this.sim.ues.has(li.dataset.ue)) this.selectAndFocus({ kind: 'ue', id: li.dataset.ue });
    });
    $('#cell-list').addEventListener('click', (e) => {
      const row = e.target.closest('[data-tower]');
      if (row) this.selectAndFocus({ kind: 'tower', id: row.dataset.tower });
    });
  }

  bindDisplay() {
    $$('[data-display]').forEach((input) => input.addEventListener('change', () => this.world.setDisplay(input.dataset.display, input.checked)));
    $$('#heatmap-mode button').forEach((b) => b.addEventListener('click', () => this.setHeatmap(b.dataset.mode)));
  }

  setHeatmap(mode) {
    this.world.heatmap.setMode(mode);
    $$('#heatmap-mode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    const scale = SCALES[mode];
    $('#legend-scale').hidden = !scale;
    if (scale) {
      $('#scale-bar').style.background = `linear-gradient(90deg, ${RAMP.join(',')})`;
      $('#scale-min').textContent = `${scale.min} ${scale.unit}`;
      $('#scale-max').textContent = `${scale.max} ${scale.unit}`;
      $('#scale-title').textContent = scale.title;
    }
  }

  bindToolbar() {
    $$('#toolbar button').forEach((b) => b.addEventListener('click', () => this.setTool(b.dataset.tool)));
  }

  setTool(tool) {
    this.world.setTool(tool);
    $$('#toolbar button').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
    const hint = $('#hint');
    if (tool === 'select') hint.hidden = true;
    else {
      const t = TECH[tool];
      hint.innerHTML = `<span class="ms" style="color:${t.color}">add_location_alt</span>Click the map to place a <b style="color:${t.color}">${t.label}</b> ${t.node}. Drop it on a building for a rooftop site. <kbd>Esc</kbd> to finish.`;
      hint.hidden = false;
    }
  }

  // ------------------------------------------------------------ keyboard

  bindKeyboard() {
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof Element && e.target.closest('input, select, textarea') && e.key !== 'Escape') return;
      const k = e.key.toLowerCase();
      if (this.driving && ['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift'].includes(k)) {
        this.keys.add(k);
        e.preventDefault();
        return;
      }
      if (k === ' ') {
        e.preventDefault();
        this.setRunning(!this.running);
      } else if (['1', '2', '3', '4'].includes(k)) this.setSpeed([1, 5, 20, 60][Number(k) - 1]);
      else if (k === 'm') {
        const modes = ['off', 'server', 'sinr', 'rsrp'];
        this.setHeatmap(modes[(modes.indexOf(this.world.heatmap.mode) + 1) % modes.length]);
      } else if (k === 'f' && this.world.selected?.kind === 'ue') this.toggleFollow();
      else if (k === 'v') this.setTool('select');
      else if (k === 'escape') {
        if (this.world.tool !== 'select') this.setTool('select');
        else if (this.driving) this.stopDriving();
        else this.world.select(null);
      } else if ((k === 'delete' || k === 'backspace') && this.world.selected?.kind === 'tower') {
        this.sim.removeTower(this.world.selected.id);
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());
  }

  // ---------------------------------------------------------- sim events

  bindSimEvents() {
    const sim = this.sim;
    sim.on('reset', () => this.onReset());
    sim.on('handover-complete', ({ ue, from, to, type, time, pingPong }) => {
      if (pingPong) this.log('warn', 'sync_problem', `<b>${ue.id}</b> ping-pong ${to.name} ⇄ ${from?.name}`, time, ue.id);
      else this.log('ok', 'swap_horiz', `<b>${ue.id}</b> ${from?.name ?? '—'} → ${to.name} <em>${HO_TIMING[type].label}</em>`, time, ue.id);
    });
    sim.on('handover-failed', ({ ue, to, time, sinr }) =>
      this.log('bad', 'error', `<b>${ue.id}</b> HO failure → ${to?.name ?? '—'} <em>target SINR ${sinr.toFixed(1)} dB</em>`, time, ue.id),
    );
    sim.on('rlf', ({ ue, cell, cause, time }) =>
      this.log('bad', 'signal_cellular_nodata', `<b>${ue.id}</b> radio link failure on ${cell?.name ?? '—'} <em>${CAUSE_LABEL[cause]}</em>`, time, ue.id),
    );
    sim.on('handover-rejected', ({ ue, to, time }) => {
      const key = `${ue.id}>${to.id}`;
      if (time - (this.rejectSeen.get(key) ?? -1e9) < 10_000) return;
      this.rejectSeen.set(key, time);
      this.log('warn', 'block', `<b>${ue.id}</b> admission rejected by ${to.name} <em>cell full</em>`, time, ue.id);
    });
    sim.on('reestablished', ({ ue, tower, time }) => this.log('info', 'restart_alt', `<b>${ue.id}</b> re-established on ${tower.name}`, time, ue.id));
    sim.on('tower-added', (t) => {
      this.log('info', 'add_location_alt', `${t.name} (${TECH[t.tech].label}) commissioned`, sim.time);
      this.buildCellList();
    });
    sim.on('tower-removed', (t) => {
      this.log('bad', 'wrong_location', `${t.name} decommissioned`, sim.time);
      this.buildCellList();
    });
    sim.on('tower-changed', (t) => this.cellRows?.get(t.id)?.row.classList.toggle('off', !t.enabled));
    sim.on('sample', () => {
      this.hoChart.draw(sim.metrics.series);
      this.thrChart.draw(sim.metrics.series);
    });
  }

  onReset() {
    $('#scenario').value = this.sim.scenario.id;
    this.syncFields();
    this.buildCellList();
    $('#log').innerHTML = '';
    this.logQueue = [];
    this.rejectSeen.clear();
    this.lastKpi = null;
    this.hoChart.draw([]);
    this.thrChart.draw([]);
    this.showSelection(this.world.selected);
  }

  log(cls, icon, html, time, ueId) {
    this.logQueue.push({ cls, icon, html, time, ueId });
    if (this.logQueue.length > LOG_LIMIT) this.logQueue.shift();
  }

  flushLog() {
    if (!this.logQueue.length) return;
    const list = $('#log');
    const frag = document.createDocumentFragment();
    for (const e of this.logQueue.reverse()) {
      const li = document.createElement('li');
      li.className = e.cls;
      if (e.ueId) li.dataset.ue = e.ueId;
      li.innerHTML = `<span class="ms">${e.icon}</span><span>${e.html}</span><time>${fmtClock(e.time)}</time>`;
      li.hidden = this.logFilter === 'fail' && e.cls === 'ok';
      frag.appendChild(li);
    }
    this.logQueue = [];
    list.prepend(frag);
    while (list.children.length > LOG_LIMIT) list.lastChild.remove();
  }

  toast(icon, text) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `<span class="ms">${icon}</span>${text}`;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 3300);
  }

  // ----------------------------------------------------------- analytics

  buildCellList() {
    const list = $('#cell-list');
    list.innerHTML = '';
    this.cellRows = new Map();
    const order = { LTE: 0, NR: 1, MMW: 2 };
    const towers = [...this.sim.towers.values()].sort((a, b) => order[a.tech] - order[b.tech] || a.id.localeCompare(b.id, undefined, { numeric: true }));
    for (const t of towers) {
      const row = document.createElement('div');
      row.className = `cell-row tech-${t.tech}${t.enabled ? '' : ' off'}`;
      row.dataset.tower = t.id;
      row.innerHTML = `<span class="name">${t.name}</span><div class="bar"><span></span></div><span class="count"></span>`;
      list.appendChild(row);
      this.cellRows.set(t.id, { row, bar: $('.bar span', row), count: $('.count', row) });
    }
  }

  updateKpis() {
    const k = this.sim.kpis();
    const prev = this.lastKpi;
    const set = (id, html, flash, bad) => {
      const el = $(`#${id}`);
      if (el.innerHTML !== html) el.innerHTML = html;
      if (flash) {
        const card = el.closest('.kpi');
        card.classList.remove('flash', 'bad');
        void card.offsetWidth;
        card.classList.add('flash');
        if (bad) card.classList.add('bad');
      }
    };
    set('kpi-ho', k.success.toLocaleString(), prev && k.success !== prev.success);
    set('kpi-horate', `${k.hoPerMin.toFixed(1)} / min`);
    set('kpi-success', `${(k.successRate * 100).toFixed(1)}%`);
    set('kpi-fail', `${k.failures} failed · ${k.rejected} rejected`, prev && k.failures !== prev.failures, true);
    set('kpi-pp', `${(k.pingPongRate * 100).toFixed(1)}%`, prev && k.pingPong !== prev.pingPong, true);
    set('kpi-ppn', `${k.pingPong} events`);
    set('kpi-rlf', String(k.rlf), prev && k.rlf !== prev.rlf, true);
    const top = Object.entries(k.causes)
      .filter(([, v]) => v)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([c, v]) => `${v} ${CAUSE_LABEL[c]}`)
      .join(' · ');
    set('kpi-rlfc', top || 'none yet');
    set('kpi-thr', k.avgThroughput >= 1000 ? `${(k.avgThroughput / 1000).toFixed(2)}<small style="font-size:12px"> Gbps</small>` : `${k.avgThroughput.toFixed(0)}<small style="font-size:12px"> Mbps</small>`);
    set('kpi-total', `${(k.totalThroughput / 1000).toFixed(2)} Gbps total`);
    set('kpi-sinr', `${k.avgSinr.toFixed(1)}<small style="font-size:12px"> dB</small>`);
    this.lastKpi = k;

    // Layer share
    const total = k.ues || 1;
    const parts = [
      ['LTE', 'var(--lte)', '4G'],
      ['NR', 'var(--nr)', '5G'],
      ['MMW', 'var(--mmw)', 'mmWave'],
      ['none', 'var(--error)', 'No service'],
    ];
    $('#share-bar').innerHTML = parts.map(([key, c]) => `<span style="flex-grow:${k.share[key]};background:${c}"></span>`).join('');
    $('#share-legend').innerHTML = parts
      .filter(([key]) => key !== 'none' || k.share.none)
      .map(([key, c, label]) => `<span><i style="--c:${c}"></i>${label}<b>${Math.round((k.share[key] / total) * 100)}%</b></span>`)
      .join('');

    // Cell load
    for (const [id, r] of this.cellRows) {
      const t = this.sim.towers.get(id);
      if (!t) continue;
      r.bar.style.width = `${Math.min(100, t.load * 100)}%`;
      r.count.textContent = t.enabled ? `${t.users}/${TECH[t.tech].maxUsers}` : 'off';
      r.row.classList.toggle('selected', this.world.selected?.id === id);
    }
  }

  // ----------------------------------------------------------- selection

  selectAndFocus(sel) {
    this.world.select(sel);
    const obj = sel.kind === 'ue' ? this.sim.ues.get(sel.id) : this.sim.towers.get(sel.id);
    if (obj) this.world.focusOn(obj.x, obj.z, sel.kind === 'ue' ? 220 : 380);
  }

  showSelection(sel) {
    const insp = $('#inspector');
    const card = $('#tower-card');
    if (this.driving && sel?.id !== this.driving.id) this.stopDriving();
    insp.hidden = sel?.kind !== 'ue';
    card.hidden = sel?.kind !== 'tower';
    if (sel?.kind === 'ue') this.buildInspector(this.sim.ues.get(sel.id));
    if (sel?.kind === 'tower') this.buildTowerCard(this.sim.towers.get(sel.id));
  }

  buildInspector(ue) {
    const insp = $('#inspector');
    const kind = UE_KINDS[ue.kind];
    insp.innerHTML = `
      <div class="insp-head">
        <div class="insp-avatar"><span class="ms">${kind.icon}</span></div>
        <div class="insp-title">
          <h3>${ue.id} <span class="state-pill" data-f="state"></span></h3>
          <p data-f="sub"></p>
        </div>
        <div class="insp-actions">
          <button class="icon-btn" data-act="follow" title="Follow with camera (F)"><span class="ms">videocam</span></button>
          <button class="icon-btn" data-act="drive" title="Take control (W A S D)"><span class="ms">sports_esports</span></button>
          <button class="icon-btn" data-act="close" title="Close (Esc)"><span class="ms">close</span></button>
        </div>
      </div>
      <div class="insp-stats">
        <div><span>Serving cell</span><b data-f="serving">—</b></div>
        <div><span>RSRP</span><b data-f="rsrp">—</b></div>
        <div><span>SINR</span><b data-f="sinr">—</b></div>
        <div><span>Downlink</span><b data-f="thr">—</b></div>
        <div><span>Handovers</span><b data-f="hos">0</b></div>
      </div>
      <div class="insp-body">
        <div>
          <h4>Measured cells · filtered RSRP</h4>
          <div class="meas-list" data-f="meas"></div>
          <div class="meas-foot"><span><i></i>A3 entry threshold</span><span><i class="y"></i>time-to-trigger running</span></div>
        </div>
        <div>
          <h4>Last 30 seconds</h4>
          <canvas class="insp-chart" data-f="chart"></canvas>
          <div class="meas-foot"><span style="color:#8ab4f8">━ RSRP (dBm)</span><span style="color:#7ee2b8">━ SINR (dB)</span><span>┆ handover</span></div>
        </div>
      </div>
      <p class="insp-hint" data-f="hint" hidden><span class="ms">sports_esports</span>Driving: <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> or arrows · hold <kbd>Shift</kbd> for car speed · <kbd>Esc</kbd> to release</p>`;
    insp.onclick = (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'close') this.world.select(null);
      if (act === 'follow') this.toggleFollow();
      if (act === 'drive') (this.driving ? this.stopDriving() : this.startDriving(ue));
    };
    this.insp = Object.fromEntries($$('[data-f]', insp).map((el) => [el.dataset.f, el]));
    this.updateInspector();
  }

  toggleFollow() {
    this.world.follow = !this.world.follow;
    $('[data-act="follow"]')?.classList.toggle('on', this.world.follow);
    if (this.world.follow) {
      const ue = this.sim.ues.get(this.world.selected.id);
      this.world.focusOn(ue.x, ue.z, 200);
    }
  }

  startDriving(ue) {
    ue.takeControl();
    this.driving = ue;
    this.world.follow = true;
    this.world.focusOn(ue.x, ue.z, 200);
    $('[data-act="drive"]')?.classList.add('on');
    $('[data-act="follow"]')?.classList.add('on');
    if (this.insp?.hint) this.insp.hint.hidden = false;
    this.toast('sports_esports', `You are driving ${ue.id}. Walk it out of coverage and watch it hand over.`);
  }

  stopDriving() {
    if (!this.driving) return;
    this.driving.releaseControl();
    this.driving = null;
    this.keys.clear();
    $('[data-act="drive"]')?.classList.remove('on');
    if (this.insp?.hint) this.insp.hint.hidden = true;
  }

  updateDriving() {
    const ue = this.driving;
    if (!ue?.manual) return;
    const k = this.keys;
    let f = 0;
    let s = 0;
    if (k.has('w') || k.has('arrowup')) f += 1;
    if (k.has('s') || k.has('arrowdown')) f -= 1;
    if (k.has('d') || k.has('arrowright')) s += 1;
    if (k.has('a') || k.has('arrowleft')) s -= 1;
    const cam = this.world.camera;
    const dir = { x: this.world.controls.target.x - cam.position.x, z: this.world.controls.target.z - cam.position.z };
    const len = Math.hypot(dir.x, dir.z) || 1;
    dir.x /= len;
    dir.z /= len;
    const speed = k.has('shift') ? 25 : 6;
    let vx = dir.x * f - dir.z * s;
    let vz = dir.z * f + dir.x * s;
    const n = Math.hypot(vx, vz);
    if (n > 0) {
      vx = (vx / n) * speed;
      vz = (vz / n) * speed;
    }
    ue.manual.vx = vx;
    ue.manual.vz = vz;
  }

  updateInspector() {
    const sel = this.world.selected;
    if (sel?.kind !== 'ue' || !this.insp) return;
    const ue = this.sim.ues.get(sel.id);
    if (!ue) return;
    const f = this.insp;
    const p = this.sim.params;
    const serving = this.sim.towers.get(ue.state === 'executing' ? ue.ho.to : ue.serving);
    const color = serving && ue.state !== 'reestablishing' ? TECH[serving.tech].color : '#ff8a80';
    $('#inspector').style.setProperty('--c', color);

    f.state.className = `state-pill ${ue.state}`;
    f.state.textContent = ue.manual ? `${STATE_LABEL[ue.state]} · manual` : STATE_LABEL[ue.state];
    f.sub.textContent = `${UE_KINDS[ue.kind].label} · ${(ue.speed * 3.6).toFixed(0)} km/h · ${ue.failCount} failures`;
    f.serving.innerHTML =
      ue.state === 'executing'
        ? `→ ${serving?.name ?? '—'}`
        : serving
          ? `<span class="t-${serving.tech}">${serving.name}</span>`
          : '<span style="color:var(--error)">none</span>';
    const live = ue.state === 'connected';
    f.rsrp.innerHTML = live ? `${ue.rsrp.toFixed(0)}<small>dBm</small>` : '—';
    f.sinr.innerHTML = live ? `${ue.sinr.toFixed(1)}<small>dB</small>` : '—';
    f.thr.innerHTML = fmtRate(ue.throughput);
    f.hos.textContent = ue.hoCount;

    // Measurement bars with the A3 threshold for each neighbour
    const ms = ue.serving ? ue.meas.get(ue.serving)?.f : undefined;
    const servingTower = this.sim.towers.get(ue.serving);
    const rows = [...ue.meas.entries()]
      .filter(([id]) => this.sim.towers.get(id)?.enabled)
      .sort((a, b) => b[1].f - a[1].f)
      .slice(0, 6);
    const pct = (v) => Math.max(0, Math.min(100, ((v + 130) / 85) * 100));
    f.meas.innerHTML = rows
      .map(([id, m]) => {
        const t = this.sim.towers.get(id);
        const isServing = id === ue.serving;
        let marks = '';
        if (!isServing && ms !== undefined && servingTower) {
          const need = ms + this.sim.cio(servingTower) + p.a3OffsetDb + p.hysteresisDb - this.sim.cio(t);
          marks += `<span class="thr" style="left:${pct(need)}%"></span>`;
          const start = ue.ttt.get(id);
          if (start !== undefined) {
            const prog = p.tttMs ? Math.min(1, (this.sim.time - start) / p.tttMs) : 1;
            marks += `<span class="ttt" style="width:${prog * 100}%"></span>`;
          }
        }
        return `<div class="meas tech-${t.tech}${isServing ? ' serving' : ''}">
          <span class="nm">${t.name}</span>
          <div class="track"><span class="fill" style="width:${pct(m.f)}%"></span>${marks}</div>
          <span class="val">${m.f.toFixed(0)} dBm</span></div>`;
      })
      .join('');

    drawUeChart(f.chart, ue.history, { rsrp: '#8ab4f8', sinr: '#7ee2b8' });
  }

  buildTowerCard(t) {
    const card = $('#tower-card');
    const tech = TECH[t.tech];
    card.style.setProperty('--c', tech.color);
    card.innerHTML = `
      <div class="insp-head">
        <div class="insp-avatar"><span class="ms">${t.tech === 'MMW' ? 'wifi_tethering' : 'cell_tower'}</span></div>
        <div class="insp-title">
          <h3>${t.name} <span class="chip tech-${t.tech}"><i></i>${tech.label}</span></h3>
          <p>${tech.band} · ${tech.bandwidthMHz} MHz · ${tech.mimoLayers}×${tech.mimoLayers} MIMO · ${t.height.toFixed(0)} m${t.hostBuilding >= 0 ? ' rooftop' : ''}</p>
        </div>
        <div class="insp-actions"><button class="icon-btn" data-act="close" title="Close (Esc)"><span class="ms">close</span></button></div>
      </div>
      <div class="tower-meta">
        <div><span>Users</span><b data-t="users"></b></div>
        <div><span>Load</span><b data-t="load"></b></div>
        <div><span>Cell throughput</span><b data-t="thr"></b></div>
      </div>
      <div class="load-track"><span data-t="bar"></span></div>
      <div class="tower-actions">
        <label class="switch-row"><span><strong>On air</strong><small>Switch off to simulate an outage</small></span><input type="checkbox" class="switch" data-act="enabled" ${t.enabled ? 'checked' : ''}/></label>
        <button class="btn-text" data-act="focus"><span class="ms">center_focus_strong</span>Focus</button>
        <button class="btn-text danger" data-act="delete"><span class="ms">delete</span></button>
      </div>`;
    card.onclick = (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'close') this.world.select(null);
      if (act === 'focus') this.world.focusOn(t.x, t.z, 380);
      if (act === 'delete') {
        this.sim.removeTower(t.id);
        this.toast('delete', `${t.name} removed: its users are re-establishing on neighbouring cells`);
      }
    };
    $('[data-act="enabled"]', card).onchange = (e) => {
      this.sim.setTowerEnabled(t.id, e.target.checked);
      this.log(e.target.checked ? 'info' : 'bad', e.target.checked ? 'power' : 'power_off', `${t.name} ${e.target.checked ? 'back on air' : 'switched off'}`, this.sim.time);
    };
    this.tcard = Object.fromEntries($$('[data-t]', card).map((el) => [el.dataset.t, el]));
    this.updateTowerCard();
  }

  updateTowerCard() {
    const sel = this.world.selected;
    if (sel?.kind !== 'tower' || !this.tcard) return;
    const t = this.sim.towers.get(sel.id);
    if (!t) return;
    const max = TECH[t.tech].maxUsers;
    this.tcard.users.textContent = `${t.users} / ${max}`;
    this.tcard.load.textContent = `${(t.load * 100).toFixed(0)}%`;
    this.tcard.thr.innerHTML = fmtRate(t.throughput);
    this.tcard.bar.style.width = `${Math.min(100, t.load * 100)}%`;
  }

  // --------------------------------------------------------------- frame

  update(dtMs) {
    this.updateDriving();
    $('#clock').textContent = fmtClock(this.sim.time);
    this.timers.fast += dtMs;
    this.timers.slow += dtMs;
    if (this.timers.fast > 150) {
      this.timers.fast = 0;
      this.updateInspector();
      this.flushLog();
    }
    if (this.timers.slow > 500) {
      this.timers.slow = 0;
      this.updateKpis();
      this.updateTowerCard();
      const uesField = $('[data-kind="ues"]');
      if (document.activeElement !== $('input', uesField)) uesField._sync();
    }
  }
}
