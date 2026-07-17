/* 客服考试结果多维看板 —— 前端逻辑 */
(function () {
  "use strict";

  const STR = window.I18N;
  let lang = localStorage.getItem("exam_lang") || "zh";
  let charts = {};          // 图表实例缓存，重渲染前销毁
  let state = { reps: [], sessions: [] };
  let me = { role: "anon" };  // 当前登录用户：anon / admin / rep

  // 全局错误条：任何未捕获的前端脚本错误都会以红字显示，便于排查“页面空白”类问题
  function showGlobalError(msg) {
    let bar = document.getElementById("global-error");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "global-error";
      bar.style.cssText = "position:fixed;left:0;right:0;bottom:0;background:#c0392b;color:#fff;" +
        "padding:8px 12px;font-size:13px;z-index:99999;white-space:pre-wrap;box-shadow:0 -2px 8px rgba(0,0,0,.3)";
      document.body.appendChild(bar);
    }
    bar.textContent = "⚠ 页面脚本错误：" + msg;
  }
  window.addEventListener("error", (e) => showGlobalError((e && e.message) || String(e.error || e)));
  window.addEventListener("unhandledrejection", (e) => showGlobalError((e && e.reason && e.reason.message) || String(e && e.reason)));

  /* ---------- 密码框显示/隐藏切换（眼睛图标） ---------- */
  const EYE_OPEN = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
  function pwToggleBtn(targetId) {
    return `<button type="button" class="pw-toggle" data-target="${targetId}" aria-label="显示密码" title="显示/隐藏密码">${EYE_OPEN}</button>`;
  }
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".pw-toggle");
    if (!btn) return;
    const input = document.getElementById(btn.dataset.target);
    if (!input) return;
    const reveal = input.type === "password";
    input.type = reveal ? "text" : "password";
    btn.innerHTML = reveal ? EYE_OFF : EYE_OPEN;
    btn.setAttribute("aria-label", reveal ? "隐藏密码" : "显示密码");
  });

  /* ---------- 工具 ---------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const T = (k) => {
    // 先尝试扁平 key；再尝试点号嵌套（如 nav.overview）
    const flat = STR[lang][k];
    if (flat !== undefined) return flat;
    const nested = k.split(".").reduce(
      (o, p) => (o && o[p] !== undefined ? o[p] : undefined), STR[lang]);
    return nested !== undefined ? nested : k;
  };

  async function api(path, opts) {
    const res = await fetch(path, Object.assign({
      headers: { "Content-Type": "application/json" },
    }, opts));
    let j;
    try {
      j = await res.json();
    } catch (e) {
      // 服务端返回了非 JSON（通常是 HTML 报错页 / 404），把真实内容抛出来便于排查
      const text = await res.text().catch(() => "");
      throw new Error(`服务端未返回 JSON（HTTP ${res.status}）。可能不是本看板在响应，请检查 5000 端口是否被其他程序占用。\n响应内容前 200 字：\n${text.slice(0, 200)}`);
    }
    if (!j.ok) throw new Error(j.msg || `request failed (HTTP ${res.status})`);
    return j.data;
  }
  function destroyChart(key) {
    if (charts[key]) { charts[key].destroy(); delete charts[key]; }
  }
  function fmtSubjects(obj) {
    if (!obj || !Object.keys(obj).length) return "—";
    const ents = Object.entries(obj);
    if (ents.length <= 5) {
      return ents.map(([k, v]) => `${k}:${v}`).join(" / ");
    }
    // 题目较多时（如测验导出 50 题）只显示概览，避免表格被撑爆
    const avg = (ents.reduce((s, [, v]) => s + (Number(v) || 0), 0) / ents.length).toFixed(1);
    return `共 ${ents.length} 题 · 均分 ${avg}`;
  }
  function passTag(p) {
    return p ? `<span class="tag pass">${T("th_pass_yes")}</span>`
             : `<span class="tag fail">${T("th_pass_no")}</span>`;
  }
  // 最终「得分」展示：有得分率(在线考试)显示 得分/满分×100（两位小数，带 %）；
  // 无得分率(Excel/手动导入)退回绝对分（不带 %）。
  function hasScoreRate(it) {
    return !!it && it.score_rate != null && it.score_rate !== "" && !isNaN(parseFloat(it.score_rate));
  }
  function fmtScore(it) {
    if (!it) return "—";
    if (hasScoreRate(it)) return (parseFloat(it.score_rate) * 100).toFixed(2);
    return it.total != null ? String(it.total) : "—";
  }
  function scorePctSuffix(it) { return hasScoreRate(it) ? "%" : ""; }

  /* ---------- 语言 ---------- */
  function applyLang() {
    $$("[data-i18n]").forEach((el) => { el.textContent = T(el.dataset.i18n); });
    $("#appTitle").textContent = T("appTitle");
    $$(".lang-toggle button").forEach((b) => {
      b.classList.toggle("active", b.dataset.lang === lang);
    });
    // 重新渲染当前视图（文案刷新）
    loadSelectors();
    const active = $(".nav button.active");
    if (active) active.click();
  }
  function setLang(l) {
    lang = l; localStorage.setItem("exam_lang", l); applyLang();
  }

  /* ---------- 导航 ---------- */
  function switchView(name) {
    $$(".nav button").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
    $$(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + name));
  }

  /* ---------- 下拉填充 ---------- */
  async function loadSelectors() {
    try {
      state.reps = await api("/api/reps");
      state.sessions = await api("/api/sessions");
    } catch (e) { console.error(e); }
    // 个人视图
    const iv = $("#iv-rep");
    if (iv) {
      const cur = iv.value;
      iv.innerHTML = `<option value="">${T("iv_select")}</option>` +
        state.reps.map((r) => `<option value="${r.rep_id}">${r.rep_id} - ${r.name}</option>`).join("");
      iv.value = cur;
    }
    // 批次视图
    const bv = $("#bv-session");
    if (bv) {
      const cur = bv.value;
      bv.innerHTML = `<option value="">${T("bv_select")}</option>` +
        state.sessions.map((s) => `<option value="${s.session_id}">${s.exam_name} [${s.batch}] ${s.exam_date}</option>`).join("");
      bv.value = cur;
    }
    // 管理 - 成绩筛选
    fillSelect($("#mg-res-rep"), state.reps.map((r) => [r.rep_id, `${r.rep_id} - ${r.name}`]), T("filter_rep"));
    fillSelect($("#mg-res-session"), state.sessions.map((s) => [s.session_id, `${s.exam_name} [${s.batch}]`]), T("filter_session"));
    // 管理 - 成绩添加/编辑：批次 + 客服
    fillSelect($("#fld_session"), state.sessions.map((s) => [s.session_id, `${s.exam_name} [${s.batch}]`]), T("mg_exam_name"));
    fillSelect($("#fld_rep"), state.reps.map((r) => [r.rep_id, `${r.rep_id} - ${r.name}`]), T("mg_rep_name"));
  }
  function fillSelect(sel, pairs, placeholder) {
    if (!sel) return;
    sel.innerHTML = `<option value="">${placeholder}</option>` +
      pairs.map(([v, t]) => `<option value="${v}">${t}</option>`).join("");
  }
  fillRepNames();

  /* ---------- 总览 ---------- */
  let srBound = false;
  async function renderOverview() {
    const ov = await api("/api/overview");
    $("#ov-cards").innerHTML = `
      <div class="kpi"><div class="label">${T("ov_reps")}</div><div class="value">${ov.rep_count}</div></div>
      <div class="kpi"><div class="label">${T("ov_sessions")}</div><div class="value">${ov.session_count}</div></div>
      <div class="kpi"><div class="label">${T("ov_results")}</div><div class="value">${ov.result_count}</div></div>
      <div class="kpi"><div class="label">${T("ov_passrate")}</div><div class="value">${ov.pass_rate ?? "—"}%</div></div>
      <div class="kpi"><div class="label">${T("ov_avg")}</div><div class="value small">${ov.avg_total ?? "—"}</div></div>`;
    const sessions = await api("/api/sessions");
    const labels = sessions.map((s) => `${s.exam_name}\n${s.batch}`);
    const data = sessions.map((s) => s.stats.avg ?? 0);
    destroyChart("ov");
    charts.ov = new Chart($("#ov-chart"), {
      type: "bar",
      data: { labels, datasets: [{ label: T("ov_session_avg"), data, backgroundColor: "#4361ee" }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } },
    });
    // 得分率面板
    const srSel = $("#sr-session");
    srSel.innerHTML = sessions.map((s) =>
      `<option value="${s.session_id}">${escapeHtml(s.exam_name)} [${escapeHtml(s.batch || "")}] ${escapeHtml(s.exam_date || "")}</option>`).join("");
    $("#sr-line").textContent =
      `${T("sr_pass_line")}：${(ov.pass_line_ratio * 100).toFixed(0)}%` +
      (ov.avg_score_rate != null ? `　|　${T("sr_scope_avg")}：${(ov.avg_score_rate * 100).toFixed(1)}%` : "");
    if (!srBound) {
      srBound = true;
      $("#sr-scope").addEventListener("change", () => {
        const isSession = $("#sr-scope").value === "session";
        $("#sr-session-field").style.display = isSession ? "" : "none";
        renderScoreRateChart();
      });
      srSel.addEventListener("change", renderScoreRateChart);
      $("#sr-recompute").addEventListener("click", async () => {
        try {
          const r = await api("/api/admin/recompute-score-rates", { method: "POST" });
          toast(r.msg || "ok");
          renderScoreRateChart();
        } catch (e) { console.error(e); toast(String(e.message || e)); }
      });
    }
    await renderScoreRateChart();
  }

  async function renderScoreRateChart() {
    const scope = $("#sr-scope").value;
    const sessionId = scope === "session" ? $("#sr-session").value : null;
    let rows = [];
    try {
      rows = await api(`/api/views/rep-score-rates?scope=${scope}${sessionId ? "&session_id=" + sessionId : ""}`);
    } catch (e) { console.error("score-rate fetch failed", e); }
    destroyChart("sr");
    const box = $("#sr-chart");
    if (!rows || !rows.length) {
      const ctx = box.getContext("2d");
      ctx.clearRect(0, 0, box.width, box.height);
      $("#sr-line").textContent = T("sr_no_data");
      return;
    }
    const labels = rows.map((r) => `${r.name}\n(${r.rep_id})`);
    const data = rows.map((r) => (r.avg_rate != null ? Math.round(r.avg_rate * 1000) / 10 : 0));
    const colors = rows.map((r) => (r.meets ? "#2a9d8f" : "#e76f51"));
    charts.sr = new Chart(box, {
      type: "bar",
      data: { labels, datasets: [{ label: T("sr_title"), data, backgroundColor: colors }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: {
            label: (c) => {
              const r = rows[c.dataIndex];
              const status = r.meets ? T("sr_meets") : T("sr_below");
              return `${c.parsed.y}%　${status}（${r.passed_cnt}/${r.cnt}）`;
            },
          } },
        },
        scales: { y: { beginAtZero: true, max: 100, ticks: { callback: (v) => v + "%" } } },
      },
    });
  }

  /* ---------- 个人视图 ---------- */
  async function renderIndividual() {
    const repId = $("#iv-rep").value;
    if (!repId) {
      $("#iv-body").innerHTML = `<div class="empty">${T("iv_please")}</div>`;
      const box = $("#iv-exam-scope"); if (box) box.style.display = "none";
      return;
    }
    const d = await api("/api/views/individual?rep_id=" + encodeURIComponent(repId));
    const s = d.summary;
    $("#iv-body").innerHTML = `
      <div class="kpi-grid">
        <div class="kpi"><div class="label">${T("iv_first")}</div><div class="value small">${s.first_exam ?? "—"}</div></div>
        <div class="kpi"><div class="label">${T("iv_latest")}</div><div class="value small">${s.latest_exam ?? "—"}</div></div>
        <div class="kpi"><div class="label">${T("iv_exams")}</div><div class="value">${s.exam_count}</div></div>
        <div class="kpi"><div class="label">${T("iv_delta")}</div><div class="value">${s.delta ?? "—"}</div></div>
        <div class="kpi"><div class="label">${T("iv_pass")}</div><div class="value">${s.pass_count}/${s.exam_count}</div></div>
      </div>
      <div class="panel"><h3>${T("iv_trend")}</h3><div class="chart-wrap"><canvas id="iv-chart"></canvas></div></div>
      <div class="panel"><h3>${T("iv_records")}</h3>${recordsTable(d.records)}</div>
      <div id="iv-weak"></div>`;
    destroyChart("iv");
    try {
      charts.iv = new Chart($("#iv-chart"), {
        type: "line",
        data: {
          labels: d.trend.map((t) => `${t.exam_date}\n${t.exam_name}`),
          datasets: [{ label: T("th_total"), data: d.trend.map((t) => t.total),
            borderColor: "#2a9d8f", backgroundColor: "rgba(42,157,143,.15)", tension: .3, fill: true }],
        },
        options: { responsive: true, maintainAspectRatio: false },
      });
    } catch (e) { console.error("Chart render failed:", e); }
    const viewRep = repId || (me.role === "rep" ? me.rep_id : null);
    buildExamScope(d.records, viewRep);
  }
  // 根据客服参加的考试记录，构建「考试范围」控件：
  //   · 默认下拉单选，进来即显示最近一场（点哪一场看哪一场）
  //   · 勾「多场综合对比」后切换为多选复选框，做多场合并统计
  function buildExamScope(records, repId) {
    const box = $("#iv-exam-scope");
    const list = $("#iv-exam-list");
    const pick = $("#iv-exam-pick");
    if (!box || !list || !pick) { if (repId) renderWeakness(repId, []); return; }
    if (!records || !records.length) { box.style.display = "none"; return; }
    box.style.display = "";
    const sorted = [...records].sort((a, b) => (b.exam_date || "").localeCompare(a.exam_date || ""));
    // 单选下拉：每一场 + 「综合全部」
    const optLabel = (r) => `${r.exam_name}  [${r.batch || ""}] ${r.exam_date || ""}`.trim();
    pick.innerHTML =
      sorted.map((r) => `<option value="${r.session_id}">${escapeHtml(optLabel(r))}</option>`).join("") +
      `<option value="__all__">${T("la_all")}（${sorted.length} ${T("la_exams")}）</option>`;
    // 多选复选框（默认隐藏，勾"多场综合对比"后显示）
    list.innerHTML = sorted.map((r) =>
      `<label class="chk"><input type="checkbox" class="iv-exam" value="${r.session_id}"> ` +
      `${escapeHtml(r.exam_name)} <span class="muted">[${escapeHtml(r.batch || "")}] ${escapeHtml(r.exam_date || "")}</span></label>`).join("");
    list.querySelectorAll(".iv-exam").forEach((cb) => cb.addEventListener("change", refreshWeaknessScope));
    // 默认：最近一场单场视图
    pick.value = sorted[0].session_id;
    const multi = $("#iv-multi-toggle");
    if (multi) multi.checked = false;
    list.style.display = "none";
    const selAll = $("#iv-sel-all"), selNone = $("#iv-sel-none");
    if (selAll) selAll.style.display = "none";
    if (selNone) selNone.style.display = "none";
    pick.style.display = "";
    renderWeakness(repId, [sorted[0].session_id]);
  }
  // 单选下拉切换：某一场 / 综合全部
  function refreshWeaknessPick() {
    const repId = $("#iv-rep").value;
    const v = $("#iv-exam-pick").value;
    renderWeakness(repId, v === "__all__" ? [] : [v]);
  }
  // 多选模式：勾选的多场综合（全不勾=综合全部）
  function refreshWeaknessScope() {
    const repId = $("#iv-rep").value;
    const ids = [...document.querySelectorAll("#iv-exam-list .iv-exam:checked")].map((c) => c.value);
    renderWeakness(repId, ids);
  }
  // 切换 单场下拉 / 多场综合 两种模式
  function toggleScopeMode() {
    const on = $("#iv-multi-toggle") && $("#iv-multi-toggle").checked;
    const pick = $("#iv-exam-pick"), list = $("#iv-exam-list");
    const selAll = $("#iv-sel-all"), selNone = $("#iv-sel-none");
    if (pick) pick.style.display = on ? "none" : "";
    if (list) list.style.display = on ? "" : "none";
    if (selAll) selAll.style.display = on ? "" : "none";
    if (selNone) selNone.style.display = on ? "" : "none";
    if (on) refreshWeaknessScope(); else refreshWeaknessPick();
  }
  function recordsTable(rows) {
    if (!rows.length) return `<div class="empty">${T("iv_no_data")}</div>`;
    return `<table><thead><tr>
      <th>${T("th_exam")}</th><th>${T("th_batch")}</th><th>${T("th_date")}</th>
      <th>${T("th_qcount")}</th><th>${T("th_score")}</th><th>${T("th_full")}</th><th>${T("th_rate")}</th><th>${T("th_pass")}</th>
      </tr></thead><tbody>${rows.map((r) => `<tr>
        <td>${r.exam_name}</td><td>${r.batch}</td><td>${r.exam_date}</td>
        <td>${r.subjects ? Object.keys(r.subjects).length + " 题" : "—"}</td>
        <td>${r.total != null ? r.total : "—"}</td>
        <td>${r.full_score != null ? r.full_score : "—"}</td>
        <td>${fmtScore(r)}${scorePctSuffix(r)}</td>
        <td>${passTag(r.passed)}</td>
      </tr>`).join("")}</tbody></table>`;
  }

  /* ---------- 批次视图 ---------- */
  async function renderBatch() {
    const sid = $("#bv-session").value;
    if (!sid) { $("#bv-body").innerHTML = `<div class="empty">${T("bv_please")}</div>`; return; }
    const d = await api("/api/views/batch?session_id=" + sid);
    const s = d.stats;
    const sess = d.session || {};
    const passLine = sess.pass_score != null ? sess.pass_score + "%" : "—";
    const noShow = (d.no_shows && d.no_shows.length)
      ? `<div class="panel noshow"><h3>${T("bv_noshow")}</h3>
           <div class="noshow-list">${d.no_shows.map((n) => `<span class="tag">${escapeHtml(n.rep_id)}${n.name ? " · " + escapeHtml(n.name) : ""}</span>`).join("")}</div>
           <div class="muted">${T("bv_noshow_hint")}</div></div>`
      : "";
    $("#bv-body").innerHTML = `
      <div class="bv-head">
        <div class="bv-title">${escapeHtml(sess.exam_name || "—")} <span class="muted">[${escapeHtml(sess.batch || "—")}] ${escapeHtml(sess.exam_date || "—")}</span></div>
        <div class="bv-pass">${T("bv_passline")}: ${passLine}</div>
      </div>
      <div class="kpi-grid">
        <div class="kpi"><div class="label">${T("bv_count")}</div><div class="value">${s.count}</div></div>
        <div class="kpi"><div class="label">${T("bv_avg")}</div><div class="value">${s.avg ?? "—"}</div></div>
        <div class="kpi"><div class="label">${T("bv_min")}</div><div class="value">${s.min ?? "—"}</div></div>
        <div class="kpi"><div class="label">${T("bv_max")}</div><div class="value">${s.max ?? "—"}</div></div>
        <div class="kpi"><div class="label">${T("bv_passrate")}</div><div class="value">${s.pass_rate ?? "—"}%</div></div>
      </div>
      <div class="panel"><h3>${T("bv_dist")}</h3><div class="chart-wrap sm"><canvas id="bv-chart"></canvas></div></div>
      ${noShow}
      <div class="panel"><h3>${T("bv_records")}</h3>${recordsTable(d.records)}</div>`;
    destroyChart("bv");
    charts.bv = new Chart($("#bv-chart"), {
      type: "bar",
      data: {
        labels: Object.keys(d.distribution),
        datasets: [{ label: T("bv_dist_label"), data: Object.values(d.distribution), backgroundColor: "#4361ee" }],
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } },
    });
  }

  /* ---------- 时间段视图 ---------- */
  async function renderPeriod() {
    const start = $("#pk-start").value, end = $("#pk-end").value;
    if (!start || !end) { $("#pk-body").innerHTML = `<div class="empty">${T("pk_please")}</div>`; return; }
    const d = await api(`/api/views/period?start=${start}&end=${end}`);
    if (!d.series.length) { $("#pk-body").innerHTML = `<div class="empty">${T("pk_please")}</div>`; return; }
    $("#pk-body").innerHTML = `
      <div class="kpi"><div class="label">${T("pk_total")}</div><div class="value">${d.total_records}</div></div>
      <div class="panel"><h3>${T("pk_trend")}</h3><div class="chart-wrap"><canvas id="pk-chart"></canvas></div></div>
      <div class="panel"><h3>${T("pk_series")}</h3>${seriesTable(d.series)}</div>`;
    destroyChart("pk");
    charts.pk = new Chart($("#pk-chart"), {
      type: "line",
      data: {
        labels: d.series.map((x) => `${x.exam_date}\n${x.exam_name}`),
        datasets: [
          { label: T("th_total"), data: d.series.map((x) => x.avg_total), yAxisID: "y",
            borderColor: "#4361ee", backgroundColor: "rgba(67,97,238,.1)", tension: .3, fill: true },
          { label: T("ov_passrate"), data: d.series.map((x) => x.pass_rate), yAxisID: "y1",
            borderColor: "#e76f51", tension: .3 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: { y: { position: "left", title: { display: true, text: T("th_total") } },
                  y1: { position: "right", min: 0, max: 100, grid: { drawOnChartArea: false },
                        title: { display: true, text: "%" } } },
      },
    });
  }
  function seriesTable(rows) {
    return `<table><thead><tr>
      <th>${T("th_exam")}</th><th>${T("th_batch")}</th><th>${T("th_date")}</th>
      <th>${T("th_total")}</th><th>${T("ov_passrate")}</th><th>${T("bv_count")}</th>
      </tr></thead><tbody>${rows.map((r) => `<tr>
        <td>${r.exam_name}</td><td>${r.batch}</td><td>${r.exam_date}</td>
        <td>${r.avg_total}</td><td>${r.pass_rate}%</td><td>${r.count}</td>
      </tr>`).join("")}</tbody></table>`;
  }

  /* ---------- 管理：客服 ---------- */
  async function renderManageReps() {
    const reps = await api("/api/reps");
    const statusOpts = `<option value="">${T("filter_all")}</option><option value="active">${T("mg_status_active")}</option><option value="left">${T("mg_status_left")}</option>`;
    const posOpts = `<option value="">${T("filter_all")}</option>` + POSITIONS.map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join("");
    const chOpts = `<option value="">${T("filter_all")}</option>` + CHANNELS.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
    const host = $("#mg-reps-body");
    host.innerHTML = `<div class="rep-filter" style="margin-bottom:10px">
        <label>${T("mg_filter")}:</label>
        <select id="mg-rep-f-status" title="${T("ex_filter_status")}">${statusOpts}</select>
        <select id="mg-rep-f-position" title="${T("ex_filter_position")}">${posOpts}</select>
        <select id="mg-rep-f-channel" title="${T("ex_filter_channel")}">${chOpts}</select>
        <span id="mg-rep-count" style="font-weight:600;color:#1d4ed8;margin-left:8px;"></span>
      </div>
      <table><thead><tr>
        <th><input type="checkbox" id="mg-reps-checkall" title="${T("mg_batch_del")}"></th>
        <th>${T("mg_rep_id")}</th><th>${T("mg_rep_name")}</th><th>${T("mg_rep_position")}</th><th>${T("mg_rep_channel")}</th><th>${T("mg_rep_status")}</th><th>${T("mg_rep_hire")}</th><th>${T("th_actions")}</th>
      </tr></thead><tbody id="mg-reps-tbody"></tbody></table>`;
    const delBtn = $("#mg-batch-del-reps-btn");
    const stBtn = $("#mg-batch-status-btn");
    const stSel = $("#mg-batch-status-sel");
    const renderRows = (list) => {
      $("#mg-reps-tbody").innerHTML = list.map((r) => `<tr>
        <td><input type="checkbox" class="mg-rep-chk" value="${escapeHtml(r.rep_id)}"></td>
        <td>${r.rep_id}</td><td>${escapeHtml(r.name)}</td>
        <td>${escapeHtml(r.position || "—")}</td>
        <td>${escapeHtml(r.channel || "—")}</td>
        <td><span class="tag ${r.status === "left" ? "fail" : "pass"}">${r.status === "left" ? T("mg_status_left") : T("mg_status_active")}</span></td>
        <td>${r.hire_date ?? "—"}</td>
        <td>
          <button class="btn small" onclick="App.editRep('${r.rep_id}')">${T("mg_edit")}</button>
          <button class="btn small danger" onclick="App.delRep('${r.rep_id}')">${T("mg_delete")}</button>
          <button class="btn small" onclick="App.resetRepPw('${r.rep_id}')">${T("mg_reset_pw")}</button>
        </td></tr>`).join("");
      const syncDelBtn = () => {
        const n = $$("#mg-reps-body .mg-rep-chk:checked").length;
        if (delBtn) delBtn.style.display = n > 0 ? "" : "none";
        if (stBtn) stBtn.style.display = n > 0 ? "" : "none";
        if (stSel) stSel.style.display = n > 0 ? "" : "none";
      };
      $$("#mg-reps-body .mg-rep-chk").forEach((c) => c.addEventListener("change", syncDelBtn));
      const ca = $("#mg-reps-checkall");
      if (ca) ca.onclick = () => {
        $$("#mg-reps-body .mg-rep-chk").forEach((c) => (c.checked = ca.checked));
        syncDelBtn();
      };
      syncDelBtn();
    };
    const applyFilter = () => {
      const fSt = $("#mg-rep-f-status").value, fPos = $("#mg-rep-f-position").value, fCh = $("#mg-rep-f-channel").value;
      const list = reps.filter((r) =>
        (!fSt || (r.status || "active") === fSt) &&
        (!fPos || (r.position || "") === fPos) &&
        (!fCh || (r.channel || "") === fCh));
      renderRows(list);
      $("#mg-rep-count").textContent = T("mg_rep_count").replace("%d", list.length).replace("%d", reps.length);
    };
    ["#mg-rep-f-status", "#mg-rep-f-position", "#mg-rep-f-channel"].forEach((s) =>
      $(s).addEventListener("change", applyFilter));
    applyFilter();
  }
  window.App = {
    async editRep(id) {
      const r = state.reps.find((x) => x.rep_id === id);
      openForm(T("mg_edit"), [
        { name: "rep_id", label: T("mg_rep_id"), value: r.rep_id, disabled: true },
        { name: "name", label: T("mg_rep_name"), value: r.name },
        { name: "hire_date", label: T("mg_rep_hire"), value: r.hire_date || "" },
        { name: "position", label: T("mg_rep_position"), value: r.position || "", type: "select", options: POSITIONS },
        { name: "channel", label: T("mg_rep_channel"), value: r.channel || "", type: "select", options: CHANNELS },
        { name: "status", label: T("mg_rep_status"), value: r.status || "active", type: "select", options: [["active", T("mg_status_active")], ["left", T("mg_status_left")]] },
      ], async (vals) => {
        await api("/api/reps/" + id, { method: "PUT", body: JSON.stringify(vals) });
        await renderManageReps(); await loadSelectors(); toast(T("mg_saved"));
      });
    },
    async delRep(id) {
      if (!confirm(T("mg_del_confirm"))) return;
      await api("/api/reps/" + id, { method: "DELETE" });
      await renderManageReps(); await loadSelectors(); toast(T("mg_deleted"));
    },
    async resetRepPw(id) {
      if (!confirm(T("mg_reset_pw_confirm"))) return;
      try {
        const j = await api("/api/reps/" + id + "/reset-password", { method: "POST" });
        toast(T("mg_pw_reset_to") + j.password);
      } catch (e) { alert(e.message); }
    },
    addRep() {
      openForm(T("mg_add"), [
        { name: "rep_id", label: T("mg_rep_id") },
        { name: "name", label: T("mg_rep_name") },
        { name: "hire_date", label: T("mg_rep_hire") },
        { name: "position", label: T("mg_rep_position"), type: "select", options: POSITIONS },
        { name: "channel", label: T("mg_rep_channel"), type: "select", options: CHANNELS },
        { name: "status", label: T("mg_rep_status"), type: "select", options: [["active", T("mg_status_active")], ["left", T("mg_status_left")]] },
      ], async (vals) => {
        await api("/api/reps", { method: "POST", body: JSON.stringify(vals) });
        await renderManageReps(); await loadSelectors(); toast(T("mg_saved"));
      });
    },
    /* 考试批次 */
    async editSession(id) {
      const s = state.sessions.find((x) => String(x.session_id) === String(id));
      openForm(T("mg_edit"), [
        { name: "exam_name", label: T("mg_exam_name"), value: s.exam_name },
        { name: "batch", label: T("mg_batch"), value: s.batch },
        { name: "exam_date", label: T("mg_date"), value: s.exam_date },
        { name: "pass_score", label: T("th_pscore"), value: s.pass_score },
        { name: "note", label: T("th_note"), value: s.note || "" },
      ], async (vals) => {
        await api("/api/sessions/" + id, { method: "PUT", body: JSON.stringify(vals) });
        await renderManageSessions(); await loadSelectors(); toast(T("mg_saved"));
      });
    },
    async delSession(id) {
      if (!confirm(T("mg_del_confirm"))) return;
      try {
        await api("/api/sessions/" + id, { method: "DELETE" });
        await renderManageSessions(); await loadSelectors(); toast(T("mg_deleted"));
      } catch (e) { alert(T("mg_del_fail") + e.message); }
    },
    /* 考题 PPT 题库 */
    async delQuestionBank(examName) {
      if (!confirm(T("qbm_del_confirm").replace("%s", examName))) return;
      await api("/api/questions/banks?exam_name=" + encodeURIComponent(examName),
                { method: "DELETE" });
      await renderQuestionBanks(); toast(T("mg_deleted"));
    },
    refreshQuestionBanks() { renderQuestionBanks(); },
    addSession() {
      openForm(T("mg_add"), [
        { name: "exam_name", label: T("mg_exam_name") },
        { name: "batch", label: T("mg_batch") },
        { name: "exam_date", label: T("mg_date") },
        { name: "pass_score", label: T("th_pscore"), value: 60 },
        { name: "note", label: T("th_note") },
      ], async (vals) => {
        await api("/api/sessions", { method: "POST", body: JSON.stringify(vals) });
        await renderManageSessions(); await loadSelectors(); toast(T("mg_saved"));
      });
    },
    /* 成绩 */
    async queryResults() {
      const p = new URLSearchParams();
      const rep = $("#mg-res-rep").value, ses = $("#mg-res-session").value;
      const st = $("#mg-res-start").value, en = $("#mg-res-end").value;
      const ps = $("#mg-res-pass").value;
      if (rep) p.set("rep_id", rep);
      if (ses) p.set("session_id", ses);
      if (st) p.set("start_date", st);
      if (en) p.set("end_date", en);
      if (ps) p.set("passed", ps);
      const rows = await api("/api/results?" + p.toString());
      $("#mg-res-body").innerHTML = `<table><thead><tr>
        <th><input type="checkbox" id="mg-res-checkall" title="${T("mg_batch_del")}"></th>
        <th>${T("th_rep")}</th><th>${T("th_name")}</th><th>${T("th_exam")}</th>
        <th>${T("th_batch")}</th><th>${T("th_date")}</th><th>${T("th_subjects")}</th>
        <th>${T("th_total")}</th><th>${T("th_pass")}</th><th>${T("th_actions")}</th>
        </tr></thead><tbody>${rows.map((r) => `<tr>
          <td><input type="checkbox" class="mg-res-chk" value="${r.result_id}"></td>
          <td>${r.rep_id}</td><td>${r.name}</td><td>${r.exam_name}</td>
          <td>${r.batch}</td><td>${r.exam_date}</td>          <td>${fmtSubjects(r.subjects)}</td>
          <td>${fmtScore(r)}${scorePctSuffix(r)}</td><td>${passTag(r.passed)}</td>
          <td>
            <button class="btn small" onclick="App.editResult(${r.result_id})">${T("mg_edit")}</button>
            <button class="btn small danger" onclick="App.delResult(${r.result_id})">${T("mg_delete")}</button>
          </td></tr>`).join("")}</tbody></table>`;
      const syncDel = () => {
        const n = $$("#mg-res-body .mg-res-chk:checked").length;
        const btn = $("#mg-batch-del-res-btn");
        if (btn) btn.style.display = n > 0 ? "" : "none";
      };
      $$("#mg-res-body .mg-res-chk").forEach((c) => c.addEventListener("change", syncDel));
      const ca = $("#mg-res-checkall");
      if (ca) ca.onclick = () => { $$("#mg-res-body .mg-res-chk").forEach((c) => (c.checked = ca.checked)); syncDel(); };
      syncDel();
    },
    async editResult(id) {
      const all = await api("/api/results");
      const rec = all.find((x) => x.result_id === id);
      if (!rec) { alert("not found"); return; }
      openForm(T("mg_edit"), [
        { name: "session_id", label: T("mg_exam_name"), value: rec.session_id, type: "select-session" },
        { name: "rep_id", label: T("mg_rep_name"), value: rec.rep_id, type: "select-rep" },
        { name: "subjects", label: T("mg_subjects"), value: JSON.stringify(rec.subjects), type: "textarea" },
        { name: "total", label: T("th_total"), value: rec.total },
      ], async (vals) => {
        vals.subjects = JSON.parse(vals.subjects || "{}");
        await api("/api/results/" + id, { method: "PUT", body: JSON.stringify(vals) });
        await window.App.queryResults(); await loadSelectors(); toast(T("mg_saved"));
      });
    },
    async delResult(id) {
      if (!confirm(T("mg_del_confirm"))) return;
      await api("/api/results/" + id, { method: "DELETE" });
      await window.App.queryResults(); toast(T("mg_deleted"));
    },
    addResult() {
      openForm(T("mg_add"), [
        { name: "session_id", label: T("mg_exam_name"), type: "select-session" },
        { name: "rep_id", label: T("mg_rep_name"), type: "select-rep" },
        { name: "subjects", label: T("mg_subjects"), value: '{"产品知识":0,"服务流程":0,"系统操作":0}', type: "textarea" },
        { name: "total", label: T("th_total") + " (可选)" },
      ], async (vals) => {
        const rep = state.reps.find((x) => x.rep_id === vals.rep_id);
        vals.name = rep ? rep.name : vals.rep_id;
        vals.subjects = JSON.parse(vals.subjects || "{}");
        if (!vals.total) delete vals.total;
        await api("/api/results", { method: "POST", body: JSON.stringify(vals) });
        await window.App.queryResults(); await loadSelectors(); toast(T("mg_saved"));
      });
    },
    async resetData(scope) {  // scope: "all" | "results"
      const msg = scope === "all" ? T("mg_reset_confirm") : T("mg_reset_results_confirm");
      if (!confirm(msg)) return;
      let pwd = null;
      try { pwd = await askResetPassword(); } catch (e) { return; }
      if (pwd === null) return;  // 用户取消授权
      try {
        const r = await api("/api/reset", { method: "POST",
          body: JSON.stringify({ scope, confirm: true, password: pwd }) });
        // 清空后立刻刷新所有受影响视图，避免用户还需手动刷新
        const refresh = async (fn) => { try { await fn(); } catch (e) {} };
        await refresh(loadSelectors);
        await refresh(renderManageReps);
        await refresh(renderManageSessions);
        await refresh(() => window.App && window.App.queryResults && window.App.queryResults());
        await refresh(renderQuestionBanks);
        await refresh(renderQuestions);
        await refresh(renderMaterials);
        await refresh(renderPoints);
        await refresh(renderDimensions);
        await refresh(renderConfig);
        showResetSummary(r);
      } catch (e) { alert("清空失败: " + e.message); }
    },
  };

  // 清空全部数据前的密码授权：返回密码字符串，取消返回 null
  function askResetPassword() {
    return new Promise((resolve) => {
      openForm(T("mg_reset_auth_title"), [
        { name: "password", label: T("mg_reset_auth_pw"), type: "password" },
      ], async (vals) => {
        if (!vals.password) throw new Error(T("mg_reset_auth_req"));
        resolve(vals.password);
      }, () => resolve(null));
    });
  }

  async function renderManageSessions() {
    const sessions = await api("/api/sessions");
    $("#mg-sessions-body").innerHTML = `<table><thead><tr>
      <th><input type="checkbox" id="mg-sessions-checkall" title="${T("mg_batch_del")}"></th>
      <th>${T("mg_exam_name")}</th><th>${T("mg_batch")}</th><th>${T("mg_date")}</th>
      <th>${T("th_pscore")}</th><th>${T("th_note")}</th><th>${T("th_actions")}</th>
      </tr></thead><tbody>${sessions.map((s) => `<tr>
        <td><input type="checkbox" class="mg-session-chk" value="${s.session_id}"></td>
        <td>${s.exam_name}</td><td>${s.batch}</td><td>${s.exam_date}</td>
        <td>${s.pass_score}</td><td>${s.note ?? ""}</td>
        <td>
          <button class="btn small" onclick="App.editSession(${s.session_id})">${T("mg_edit")}</button>
          <button class="btn small danger" onclick="App.delSession(${s.session_id})">${T("mg_delete")}</button>
        </td></tr>`).join("")}</tbody></table>`;
    const syncDel = () => {
      const n = $$("#mg-sessions-body .mg-session-chk:checked").length;
      const btn = $("#mg-batch-del-sessions-btn");
      if (btn) btn.style.display = n > 0 ? "" : "none";
    };
    $$("#mg-sessions-body .mg-session-chk").forEach((c) => c.addEventListener("change", syncDel));
    const ca = $("#mg-sessions-checkall");
    if (ca) ca.onclick = () => { $$("#mg-sessions-body .mg-session-chk").forEach((c) => (c.checked = ca.checked)); syncDel(); };
    syncDel();
  }

  /* ---------- 考题 PPT / 题库管理 ---------- */
  async function renderQuestionBanks() {
    const box = $("#mg-banks-body");
    if (!box) return;
    try {
      const banks = await api("/api/questions/banks");
      if (!banks.length) {
        box.innerHTML = `<div class="muted">${T("qbm_empty")}</div>`;
        return;
      }
    const rows = banks.map((b) => {
      const dims = b.dims && b.dims.length
        ? b.dims.map((d) => `<span class="tag">${escapeHtml(lang === "en" ? (d.name_en || d.name_cn) : d.name_cn)}</span>`).join(" ")
        : `<span class="tag fail">${T("qbm_no_dim")}</span>`;
      const link = b.linked
        ? `<span class="tag pass">${T("qbm_linked")}</span>`
        : `<span class="tag fail">${T("qbm_unlinked")}</span>`;
      const mismatch = (b.result_qcount && b.result_qcount !== b.q_count)
        ? ` <span class="tag fail" title="${T("qbm_mismatch")}">${b.q_count}≠${b.result_qcount}</span>`
        : "";
      return `<tr>
        <td><input type="checkbox" class="qbm-chk" value="${escapeHtml(b.exam_name)}"></td>
        <td>${escapeHtml(b.orig_filename || "—")}</td>
        <td>${escapeHtml(b.exam_name)} ${link}</td>
        <td>${b.q_count}${mismatch}</td>
        <td>${b.result_qcount || "—"}</td>
        <td>${dims}</td>
        <td>${b.uploaded_at ? escapeHtml(b.uploaded_at.slice(0, 16).replace("T", " ")) : "—"}</td>
        <td><button class="btn small danger" onclick="App.delQuestionBank('${escapeHtml(b.exam_name).replace(/'/g, "\\'")}')">${T("mg_delete")}</button></td>
      </tr>`;
    }).join("");
    box.innerHTML = `<table><thead><tr>
      <th><input type="checkbox" id="qbm-checkall" title="${T("mg_batch_del")}"></th>
      <th>${T("qbm_file")}</th><th>${T("qbm_exam")}</th><th>${T("qbm_qcount")}</th>
      <th>${T("qbm_result_qcount")}</th><th>${T("qbm_dims")}</th>
      <th>${T("qbm_uploaded")}</th><th>${T("th_actions")}</th>
      </tr></thead><tbody>${rows}</tbody></table>`;
    const syncDel = () => {
      const n = $$("#mg-banks-body .qbm-chk:checked").length;
      const btn = $("#mg-batch-del-banks-btn");
      if (btn) btn.style.display = n > 0 ? "" : "none";
    };
    $$("#mg-banks-body .qbm-chk").forEach((c) => c.addEventListener("change", syncDel));
    const ca = $("#qbm-checkall");
    if (ca) ca.onclick = () => { $$("#mg-banks-body .qbm-chk").forEach((c) => (c.checked = ca.checked)); syncDel(); };
    syncDel();
    } catch (e) {
      box.innerHTML = `<div class="field-err">⚠ 加载题库列表失败：${escapeHtml(e.message)}</div>`;
    }
  }

  /* ---------- 通用表单模态框 ---------- */
  function openForm(title, fields, onSubmit, onCancel) {
    const body = fields.map((f) => {
      const val = f.value != null ? f.value : "";
      let input;
      if (f.type === "textarea") {
        input = `<textarea data-name="${f.name}">${escapeHtml(val)}</textarea>`;
      } else if (f.type === "select-session") {
        input = `<select data-name="${f.name}">${state.sessions.map((s) =>
          `<option value="${s.session_id}" ${String(s.session_id) === String(val) ? "selected" : ""}>${s.exam_name} [${s.batch}]</option>`).join("")}</select>`;
      } else if (f.type === "select-rep") {
        input = `<select data-name="${f.name}">${state.reps.map((r) =>
          `<option value="${r.rep_id}" ${r.rep_id === val ? "selected" : ""}>${r.rep_id} - ${r.name}</option>`).join("")}</select>`;
      } else if (f.options) {
        input = `<select data-name="${f.name}">${f.options.map((o) => {
          const v = Array.isArray(o) ? o[0] : o;
          const l = Array.isArray(o) ? o[1] : o;
          return `<option value="${escapeHtml(v)}" ${v === val ? "selected" : ""}>${escapeHtml(l)}</option>`;
        }).join("")}</select>`;
      } else if (f.type === "password") {
        const pid = "pw_" + f.name;
        input = `<div class="pw-wrap"><input type="password" id="${pid}" data-name="${f.name}" ${f.disabled ? "disabled" : ""}>${pwToggleBtn(pid)}</div>`;
      } else {
        input = `<input data-name="${f.name}" value="${escapeHtml(val)}" ${f.disabled ? "disabled" : ""}>`;
      }
      return `<div class="field"><label>${f.label}</label>${input}</div>`;
    }).join("");
    $("#modalTitle").textContent = title;
    $("#modalBody").innerHTML = body;
    $("#modalMask").classList.add("show");
    $("#modalSave").disabled = false;
    $("#modalSave").style.display = "";
    $("#modalSave").onclick = async () => {
      const vals = {};
      $$("#modalBody [data-name]").forEach((el) => { vals[el.dataset.name] = el.value.trim(); });
      try {
        await onSubmit(vals);
        closeModal();
      } catch (e) { alert("Error: " + e.message); }
    };
    $("#modalCancel").onclick = () => { closeModal(); if (onCancel) onCancel(); };
  }
  function closeModal() { $("#modalMask").classList.remove("show"); $("#modalCancel").style.display = ""; $("#modalSave").style.display = ""; }

  // 清空数据后展示「删了什么 / 保留了什么」摘要
  const RESET_TABLE_LABELS = {
    exam_assignments: "考试分配",
    exam_answers: "在线作答",
    exam_attempts: "在线考试记录",
    paper_questions: "试卷-题目关联",
    exam_papers: "在线试卷",
    questions: "题库",
    exam_question_dimensions: "题-维度映射",
    exam_question_bank: "考题PPT",
    question_bank_meta: "考题PPT元数据",
    exam_results: "成绩",
    exam_sessions: "考试批次",
    accounts: "登录账号",
    cs_reps: "客服名单",
  };
  function showResetSummary(r) {
    const cleared = (r && r.cleared) || {};
    const skipped = Object.keys(cleared).filter((t) => typeof cleared[t] === "string" && String(cleared[t]).startsWith("skip:"));
    const clearedRows = Object.keys(cleared).filter((t) => !skipped.includes(t));
    const clearedHtml = clearedRows.length
      ? `<ul class="reset-summary">` + clearedRows.map((t) => {
          const n = cleared[t];
          const lbl = RESET_TABLE_LABELS[t] || t;
          const detail = (typeof n === "number" && n > 0) ? `：删除 ${n} 行` : (n === 0 ? "：无数据" : "");
          return `<li><b>${lbl}</b>${detail}</li>`;
        }).join("") + `</ul>`
      : `<div class="muted">${T("mg_reset_cleared_none")}</div>`;
    const preservedHtml = (r && r.preserved || []).map((p) => `<li>${escapeHtml(p)}</li>`).join("");
    const skipHtml = skipped.length
      ? `<div class="field-err" style="margin-top:10px">${T("mg_reset_skip")}<ul>${skipped.map((t) =>
          `<li>${RESET_TABLE_LABELS[t] || t}：${escapeHtml(String(cleared[t]))}</li>`).join("")}</ul></div>`
      : "";
    $("#modalTitle").textContent = T("mg_reset_done_title");
    $("#modalBody").innerHTML =
      `<div class="field"><label>${T("mg_reset_cleared")}</label>${clearedHtml}</div>` +
      `<div class="field"><label>${T("mg_reset_preserved")}</label><ul class="reset-summary">${preservedHtml}</ul></div>` +
      skipHtml;
    const save = $("#modalSave");
    save.textContent = T("mg_reset_ok");
    save.disabled = false;
    save.onclick = closeModal;
    $("#modalCancel").style.display = "none";
    $("#modalMask").classList.add("show");
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  // 把答案（可能是 JSON 数组串 / 字符串 / 数组）统一成字符串数组
  function parseAnswer(ans) {
    if (ans == null) return [];
    if (Array.isArray(ans)) return ans.map(String);
    if (typeof ans === "string") {
      const s = ans.trim();
      if (s.startsWith("[")) {
        try { const a = JSON.parse(s); return Array.isArray(a) ? a.map(String) : [s]; }
        catch (e) { return [s]; }
      }
      return [s];
    }
    return [String(ans)];
  }
  // 选项数组 [{key,text}] 中按 key 取展示文本
  function normalizeOptArr(options) {
    if (!Array.isArray(options)) return [];
    return options.map((x, i) => {
      if (x && typeof x === "object" && "key" in x) {
        return { key: String(x.key), text: x.text != null ? String(x.text) : "" };
      }
      if (typeof x === "string") {
        const m = x.match(/^([A-Za-z0-9])[.、]\s*(.*)$/);
        if (m) return { key: m[1], text: m[2].trim() };
        return { key: String.fromCharCode(65 + i), text: x.trim() };
      }
      return null;
    }).filter(Boolean);
  }
  function optText(options, key) {
    const arr = normalizeOptArr(options);
    const o = arr.find((x) => x && String(x.key) === String(key));
    return o ? `${o.key}. ${o.text}` : key;
  }
  // 选项完整列表：正确项绿底高亮，学生错选红底；返回 HTML
  function optionsBlockHtml(options, correctKeys, studentKeys) {
    const arr = normalizeOptArr(options);
    if (!arr.length) return "";
    const correct = new Set((correctKeys || []).map(String));
    const student = (studentKeys && studentKeys.length) ? new Set(studentKeys.map(String)) : null;
    const html = arr.map((o) => {
      const k = String(o.key);
      let cls = "opt-item";
      let badge = "";
      if (correct.has(k)) {
        cls += " opt-correct";
        badge = `<span class="opt-badge ok">✓ ${T("wk_opt_correct")}</span>`;
      }
      if (student) {
        if (student.has(k)) {
          if (correct.has(k)) {
            cls += " opt-picked";
            badge = `<span class="opt-badge ok">✓ ${T("wk_opt_yourpick")}</span>`;
          } else {
            cls += " opt-wrong";
            badge = `<span class="opt-badge no">✗ ${T("wk_opt_yourpick")}</span>`;
          }
        }
      }
      return `<div class="${cls}"><span class="opt-key">${escapeHtml(o.key)}</span>` +
             `<span class="opt-text">${escapeHtml(o.text)}</span>${badge}</div>`;
    }).join("");
    return `<div class="opt-list">${html}</div>`;
  }
  // 逐题分析：你选X、正确Y、是否答对
  function buildAnalysisLine(studentKeys, correctKeys) {
    if (!studentKeys || !studentKeys.length) return "";
    const same = studentKeys.length === correctKeys.length &&
      studentKeys.every((k) => correctKeys.map(String).includes(String(k)));
    return same
      ? `<div class="wq-analysis ok">✅ ${T("wk_ana_right")}</div>`
      : `<div class="wq-analysis bad">❌ ${T("wk_ana_wrong")}</div>`;
  }

  /* ---------- 弱项 / 错题分析（按维度展示真实错题，前端按语言拼 summary） ---------- */
  function weakSummary(wk) {
    if (!wk || !wk.ranking || !wk.ranking.length) return "";
    const nameOf = (d) => (lang === "zh" ? d.name_cn : (d.name_en || d.name_cn));
    const top = wk.ranking[0];
    const qlist = top.questions.slice(0, 3).map((q) => q.q).join(lang === "zh" ? "、" : ", ");
    let s = (lang === "zh"
      ? `在「${nameOf(top)}」维度错题最多（${top.weak_count} 题，如 ${qlist}），建议优先复习该部分知识。`
      : `Most weak in "${nameOf(top)}" (${top.weak_count} questions, e.g. ${qlist}). Prioritize reviewing it.`);
    if (wk.ranking.length > 1) {
      const rest = wk.ranking.slice(1, 3).map((d) =>
        (lang === "zh" ? `「${nameOf(d)}」(${d.weak_count}题)` : `"${nameOf(d)}" (${d.weak_count})`)
      ).join(lang === "zh" ? "、" : ", ");
      s += (lang === "zh" ? ` 其次关注：${rest}。` : ` Next: ${rest}.`);
    }
    return s;
  }
  // attemptDetail 可选：传入 openExamReport 的逐题详情，用于显示「你的答案」
  function weakQuestionsHtml(wk, attemptDetail) {
    if (!wk || !wk.ranking || !wk.ranking.length) return `<p class="muted">${T("wk_no_wrong")}</p>`;
    const saMap = {};
    if (attemptDetail) attemptDetail.forEach((q) => { saMap[String(q.seq)] = q; });
    const blocks = wk.ranking.map((d, i) => {
      const name = lang === "zh" ? d.name_cn : (d.name_en || d.name_cn);
      const qs = (d.questions || []).map((q) => {
        const correctKeys = parseAnswer(q.answer);
        const sa = saMap[String(q.q)];
        const studentKeys = (sa && sa.student_answer != null) ? parseAnswer(sa.student_answer) : null;
        const correctStr = correctKeys.map((k) => optText(q.options, k)).join(lang === "zh" ? "、" : ", ");
        const saStr = studentKeys ? studentKeys.map((k) => optText(q.options, k)).join(lang === "zh" ? "、" : ", ") : null;
        const analysis = buildAnalysisLine(studentKeys, correctKeys);
        return `<div class="weak-q">
          <div class="wq-head">${q.q} · ${T("wk_q_score")}: ${q.score}/${q.max}</div>
          <div class="wq-content">${escapeHtml(q.content || "")}</div>
          ${optionsBlockHtml(q.options, correctKeys, studentKeys)}
          ${saStr != null ? `<div class="muted">${T("your_ans")}: <b>${escapeHtml(saStr)}</b></div>` : ""}
          <div class="muted">${T("wk_q_correct")}: <b>${escapeHtml(correctStr)}</b></div>
          ${analysis}
          ${q.explanation ? `<div class="wq-exp"><b>${T("wk_q_expl")}：</b>${escapeHtml(q.explanation)}</div>` : ""}
        </div>`;
      }).join("");
      return `<div class="weak-dim"><h4>${i + 1}. ${escapeHtml(name)} <span class="muted">(${d.weak_count} ${T("th_count")})</span></h4>${qs}</div>`;
    }).join("");
    const intro = wk.ranking.length > 1 ? `<p class="muted">${T("wk_intro").replace("%d", wk.ranking.length)}</p>` : "";
    return `<p>${weakSummary(wk)}</p>${intro}${blocks}`;
  }

  // 考试逐题详情（答题报告用），返回单题 HTML；data-wrong 供「只看错题」过滤
  function examDetailRowHtml(q) {
    let mark;
    if (q.q_type === "essay") mark = q.is_correct === null ? `<span class="tag">${T("pending")}</span>` : `<span class="tag ${q.is_correct ? "pass" : "fail"}">${q.score}</span>`;
    else mark = `<span class="tag ${q.is_correct ? "pass" : "fail"}">${q.is_correct ? T("correct") : T("wrong")} · ${q.score}</span>`;
    const sa = q.q_type === "essay" ? escapeHtml(q.student_answer || "") :
      (q.student_answer != null ? (Array.isArray(q.student_answer) ? q.student_answer.join(", ") : q.student_answer) : "—");
    const correctKeys = (q.q_type === "essay") ? [] : parseAnswer(q.answer);
    const studentKeys = (q.q_type === "essay") ? null : (q.student_answer != null ? parseAnswer(q.student_answer) : []);
    const correctStr = (q.q_type === "essay") ? escapeHtml(q.answer || "") :
      correctKeys.map((k) => optText(q.options, k)).join(", ");
    const analysis = (q.q_type === "essay") ? "" : buildAnalysisLine(studentKeys, correctKeys);
    const wrong = (q.is_correct === 0) ? "1" : "0";
    return `<div class="exam-q" data-wrong="${wrong}">
      <div class="eq-no">Q${q.seq} [${typeLabel(q.q_type)}] ${mark}</div>
      <div class="eq-content">${escapeHtml(q.content)}</div>
      ${q.q_type !== "essay" ? optionsBlockHtml(q.options, correctKeys, studentKeys) : ""}
      <div class="muted">${T("ex_ans")}: ${sa}</div>
      ${q.q_type !== "essay" ? `<div class="muted">${T("wk_q_correct")}: <b>${escapeHtml(correctStr)}</b></div>` : ""}
      ${analysis}
      ${q.explanation ? `<div class="wq-exp"><b>${T("wk_q_expl")}：</b>${escapeHtml(q.explanation)}</div>` : ""}
    </div>`;
  }
  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.style.display = "block";
    setTimeout(() => (t.style.display = "none"), 1500);
  }

  /* ---------- 成绩 Excel 批量上传 ---------- */
  function openUploadResults() {
    $("#modalTitle").textContent = T("up_title");
    $("#modalBody").innerHTML = `
      <div class="field"><label>${T("up_file")}</label>
        <input type="file" id="up-file" accept=".xlsx"></div>
      <div class="field"><label>${T("up_exam")}</label><input id="up-exam"></div>
      <div class="field"><label>${T("up_batch")}</label><input id="up-batch"></div>
      <div class="field"><label>${T("up_date")}</label><input type="date" id="up-date"></div>
      <div class="field"><label>${T("up_ratio")}</label><input id="up-ratio" value="0.7"></div>
      <div class="field"><label>${T("up_full")}</label><input id="up-full"></div>
      <div class="field"><label>${T("up_pscore")}</label><input id="up-pscore"></div>
      <div class="muted" style="margin-top:6px">${T("up_hint")}</div>`;
    $("#modalMask").classList.add("show");
    $("#modalSave").onclick = async () => {
      const f = $("#up-file").files[0];
      if (!f) { alert(T("up_file")); return; }
      const fd = new FormData();
      fd.append("file", f);
      const map = { exam_name: "up-exam", batch: "up-batch", exam_date: "up-date",
                    pass_ratio: "up-ratio", full_score: "up-full", pass_score: "up-pscore" };
      Object.entries(map).forEach(([k, id]) => {
        const v = $("#" + id).value.trim();
        if (v) fd.append(k, v);
      });
      $("#modalSave").disabled = true; $("#modalSave").textContent = T("up_doing");
      try {
        const r = await fetch("/api/results/import", { method: "POST", body: fd });
        const j = await r.json();
        if (!j.ok) throw new Error(j.msg);
        closeModal();
        toast(j.msg);
        await loadSelectors();
        await renderManageSessions();
        await window.App.queryResults();
      } catch (e) {
        alert("导入失败: " + e.message);
      } finally {
        $("#modalSave").disabled = false; $("#modalSave").textContent = T("save");
      }
    };
  }

  /* ---------- 考题 PPT 上传（联动题库） ---------- */
  function openUploadPPT() {
    getDims().then((dims) => {
      const examOpts = [...new Set(state.sessions.map((s) => s.exam_name))]
        .map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("");
      const dimChecks = dims.map((d) =>
        `<label class="chk"><input type="checkbox" class="ppt-dim" value="${d.dim_id}"> ${escapeHtml(d.name_cn)}</label>`).join("");
      $("#modalTitle").textContent = T("up_ppt_title");
      $("#modalBody").innerHTML = `
        <div class="field"><label>${T("up_ppt_file")}</label>
          <input type="file" id="ppt-file" accept=".pptx">
          <button type="button" class="btn" id="ppt-preview-btn" style="margin-top:6px">${T("up_ppt_preview")}</button>
        </div>
        <div id="ppt-preview" class="ppt-preview"></div>
        <div class="field"><label>${T("up_ppt_exam")}</label><select id="ppt-exam">${examOpts || `<option value="">（无考试批次，请先上传成绩）</option>`}</select>
          <div class="field-err" id="ppt-exam-err"></div></div>
        <div class="field"><label>${T("up_ppt_dim")}</label>
          <div class="chk-group" id="ppt-dims">${dimChecks || `<span class="muted">（暂无维度，请先在数据管理添加）</span>`}</div>
          <div class="field-err" id="ppt-dim-err"></div>
        </div>
        <div class="muted" style="margin-top:6px">${T("up_ppt_hint")}</div>`;
      $("#modalMask").classList.add("show");
      // 预览解析：仅解析不落库，确认题数/内容后再正式导入
      $("#ppt-preview-btn").onclick = async () => {
        const f = $("#ppt-file").files[0];
        const box = $("#ppt-preview");
        if (!f) { box.innerHTML = `<div class="field-err">⚠ ${T("up_ppt_file")}</div>`; return; }
        box.innerHTML = `<div class="muted">${T("up_ppt_doing")}</div>`;
        const fd = new FormData();
        fd.append("file", f);
        try {
          const r = await fetch("/api/questions/import-ppt?dry=1", { method: "POST", body: fd });
          const j = await r.json();
          if (!j.ok) throw new Error(j.msg);
          const d = j.data || {};
          const list = (d.questions || []).slice(0, 8).map((q) =>
            `<li><b>Q${q.seq}</b> <span class="tag">${q.q_type}</span> ${escapeHtml(q.content)}</li>`).join("");
          const more = (d.questions || []).length > 8 ? `<li class="muted">…还有 ${d.questions.length - 8} 道</li>` : "";
          box.innerHTML = `<div class="result-ok">✅ ${escapeHtml(j.msg)}</div>
            <p class="muted">${T("up_ppt_preview_hint")}</p>
            <ol class="ppt-preview-list">${list}${more}</ol>`;
        } catch (e) {
          box.innerHTML = `<div class="field-err">⚠ 预览失败: ${escapeHtml(e.message)}</div>`;
        }
      };
      $("#modalSave").onclick = async () => {
        const examErr = $("#ppt-exam-err"), dimErr = $("#ppt-dim-err");
        examErr.textContent = ""; dimErr.textContent = "";
        const f = $("#ppt-file").files[0];
        if (!f) { alert(T("up_ppt_file")); return; }
        const exam = $("#ppt-exam").value;
        if (!exam) { examErr.textContent = "⚠ " + T("up_ppt_exam_err"); return; }
        const dimIds = [...document.querySelectorAll(".ppt-dim:checked")].map((c) => c.value);
        if (!dimIds.length) { dimErr.textContent = "⚠ " + T("up_ppt_dim_err"); return; }
        const fd = new FormData();
        fd.append("file", f);
        fd.append("exam_name", exam);
        fd.append("dim_ids", dimIds.join(","));
        $("#modalSave").disabled = true; $("#modalSave").textContent = T("up_ppt_doing");
        try {
          const r = await fetch("/api/questions/import-ppt", { method: "POST", body: fd });
          const j = await r.json();
          if (!j.ok) throw new Error(j.msg);
          showPptResult(j.data || {}, j.msg);
        } catch (e) { alert("导入失败: " + e.message); }
        finally { $("#modalSave").disabled = false; $("#modalSave").textContent = T("save"); }
      };
    });
  }

  function showPptResult(d, msg) {
    const warn = d.warning ? `<div class="result-warn">⚠️ ${escapeHtml(d.warning)}</div>` : "";
    $("#modalTitle").textContent = T("up_ppt_done");
    $("#modalBody").innerHTML = `
      <div class="result-ok">✅ ${escapeHtml(msg)}</div>
      <p class="muted">${T("up_ppt_linked")}</p>
      ${warn}
      <div class="muted" style="margin-top:8px">${T("up_ppt_next")}</div>`;
    const save = $("#modalSave");
    save.textContent = T("close");
    save.onclick = () => closeModal();
    renderQuestionBanks();  // 导入成功后刷新题库管理列表
  }

  /* ---------- 初始化 ---------- */
  function bind() {
    $$(".nav button").forEach((b) => b.addEventListener("click", () => {
      switchView(b.dataset.view);
      const v = b.dataset.view;
      if (v === "overview") renderOverview();
      else if (v === "individual") renderIndividual();
      else if (v === "batch") renderBatch();
      else if (v === "period") renderPeriod();
      else if (v === "questions") renderQuestions();
      else if (v === "exams") renderExams();
      else if (v === "mine") renderMine();
      else if (v === "config") renderConfig();
      else if (v === "points") renderPoints();
      else if (v === "materials") renderMaterials();
      else if (v === "recommend") renderRecommend();
      else if (v === "rep-points") renderRepPoints();
      else if (v === "manage") {
        renderManageReps().catch((e) => console.error("reps", e));
        renderManageSessions().catch((e) => console.error("sessions", e));
        window.App.queryResults().catch((e) => console.error("results", e));
        renderQuestionBanks().catch((e) => console.error("banks", e));
      }
    }));
    // 数据管理：子模块内嵌选项卡切换（外层只切大模块，内层各自可滚动）
    $$(".mg-tab").forEach((t) => t.addEventListener("click", () => {
      const tab = t.dataset.tab;
      $$(".mg-tab").forEach((x) => x.classList.toggle("active", x === t));
      $$(".mg-tab-panel").forEach((p) => p.classList.toggle("active", p.dataset.tab === tab));
    }));
    $$(".lang-toggle button").forEach((b) => b.addEventListener("click", () => setLang(b.dataset.lang)));
    $("#iv-rep").addEventListener("change", renderIndividual);
    const ivPick = $("#iv-exam-pick");
    if (ivPick) ivPick.addEventListener("change", refreshWeaknessPick);
    const ivMulti = $("#iv-multi-toggle");
    if (ivMulti) ivMulti.addEventListener("change", toggleScopeMode);
    const ivSelAll = $("#iv-sel-all");
    if (ivSelAll) ivSelAll.addEventListener("click", (e) => {
      e.preventDefault();
      document.querySelectorAll("#iv-exam-list .iv-exam").forEach((c) => { c.checked = true; });
      refreshWeaknessScope();
    });
    const ivSelNone = $("#iv-sel-none");
    if (ivSelNone) ivSelNone.addEventListener("click", (e) => {
      e.preventDefault();
      document.querySelectorAll("#iv-exam-list .iv-exam").forEach((c) => { c.checked = false; });
      refreshWeaknessScope();
    });
    $("#bv-session").addEventListener("change", renderBatch);
    $("#pk-query").addEventListener("click", renderPeriod);
    const upBtn = $("#mg-upload-btn");
    if (upBtn) upBtn.addEventListener("click", openUploadResults);
    const upSessBtn = $("#mg-upload-session-btn");
    if (upSessBtn) upSessBtn.addEventListener("click", openUploadResults);
    const pptBtn2 = $("#mg-upload-ppt-btn2");
    if (pptBtn2) pptBtn2.addEventListener("click", openUploadPPT);
    const qbmRefresh = $("#qbm-refresh");
    if (qbmRefresh) qbmRefresh.addEventListener("click", renderQuestionBanks);
    const resetAll = $("#mg-reset-all");
    if (resetAll) resetAll.addEventListener("click", () => window.App.resetData("all"));
    const resetResults = $("#mg-reset-results");
    if (resetResults) resetResults.addEventListener("click", () => window.App.resetData("results"));
    // 客服修改密码（仅本人）
    const changePwBtn = $("#changePwBtn");
    if (changePwBtn) changePwBtn.addEventListener("click", openChangePw);
    // 客服名册：Excel 批量导入
    const importRepsBtn = $("#mg-import-reps-btn");
    const repsFile = $("#mg-reps-file");
    if (importRepsBtn && repsFile) {
      importRepsBtn.addEventListener("click", () => repsFile.click());
      repsFile.addEventListener("change", async () => {
        const f = repsFile.files[0];
        if (!f) return;
        try {
          const fd = new FormData();
          fd.append("file", f);
          const r = await fetch("/api/reps/import", { method: "POST", body: fd, credentials: "include" });
          const j = await r.json();
          if (!j.ok) throw new Error(j.msg || "导入失败");
          await renderManageReps(); await loadSelectors();
          toast(`导入 ${j.data.imported} 条，错误 ${j.data.errors.length} 条`);
        } catch (e) { alert("导入失败：" + e.message); }
        repsFile.value = "";
      });
    }
    // 客服名册：批量删除
    const batchDelRepsBtn = $("#mg-batch-del-reps-btn");
    if (batchDelRepsBtn) batchDelRepsBtn.addEventListener("click", async () => {
      const ids = $$("#mg-reps-body .mg-rep-chk:checked").map((c) => c.value);
      if (!ids.length) { alert(T("mg_sel_to_del")); return; }
      if (!confirm(T("mg_batch_del_confirm"))) return;
      try {
        await api("/api/reps/batch-delete", { method: "POST", body: JSON.stringify({ ids }) });
        await renderManageReps(); await loadSelectors();
        toast(T("mg_deleted") + " ×" + ids.length);
      } catch (e) { alert(e.message); }
    });
    // 客服名册：批量修改在职状态
    const batchStatusBtn = $("#mg-batch-status-btn");
    if (batchStatusBtn) batchStatusBtn.addEventListener("click", async () => {
      const ids = $$("#mg-reps-body .mg-rep-chk:checked").map((c) => c.value);
      if (!ids.length) { alert(T("mg_no_sel_status")); return; }
      const status = $("#mg-batch-status-sel").value;
      const statusLabel = status === "left" ? T("mg_status_left") : T("mg_status_active");
      if (!confirm(T("mg_batch_status_confirm").replace("%d", ids.length).replace("%s", statusLabel))) return;
      try {
        const r = await api("/api/reps/batch-update", { method: "POST", body: JSON.stringify({ ids, fields: { status } }) });
        await renderManageReps(); await loadSelectors();
        toast(T("mg_status_updated").replace("%d", r.updated));
      } catch (e) { alert(e.message); }
    });
    // 通用批量删除：勾选后点批量删除按钮 → 确认 → 调后端 → 刷新
    function bulkDeleteSel(btnId, chkSel, url, bodyKey, confirmKey, refreshFn) {
      const btn = $(btnId);
      if (!btn) return;
      btn.addEventListener("click", async () => {
        const ids = $$(chkSel + ":checked").map((c) => c.value);
        if (!ids.length) { alert(T("mg_sel_to_del")); return; }
        if (!confirm(T(confirmKey).replace("%d", ids.length))) return;
        try {
          await api(url, { method: "DELETE", body: JSON.stringify({ [bodyKey]: ids }) });
          await refreshFn();
          toast(T("mg_deleted") + " ×" + ids.length);
        } catch (e) { alert(e.message); }
      });
    }
    bulkDeleteSel("#mg-batch-del-sessions-btn", "#mg-sessions-body .mg-session-chk",
      "/api/sessions/bulk", "ids", "mg_batch_del_sessions_confirm",
      () => { renderManageSessions(); loadSelectors(); });
    bulkDeleteSel("#mg-batch-del-res-btn", "#mg-res-body .mg-res-chk",
      "/api/results/bulk", "ids", "mg_batch_del_res_confirm",
      () => window.App.queryResults());
    bulkDeleteSel("#mg-batch-del-banks-btn", "#mg-banks-body .qbm-chk",
      "/api/questions/banks/bulk", "names", "mg_batch_del_banks_confirm",
      () => renderQuestionBanks());
    bulkDeleteSel("#mat-batch-del-btn", "#mat-admin-body .mat-chk",
      "/api/materials/bulk", "ids", "mg_batch_del_mat_confirm",
      () => renderMaterials());
    bulkDeleteSel("#dim-batch-del-btn", "#dim-body .dim-bulk-chk",
      "/api/dimensions/bulk", "ids", "mg_batch_del_dim_confirm",
      () => { invalidateDims(); renderDimensions(); });
    $("#modalCancel").addEventListener("click", closeModal);
    let maskDownOnMask = false;
    $("#modalMask").addEventListener("mousedown", (e) => { maskDownOnMask = (e.target.id === "modalMask"); });
    $("#modalMask").addEventListener("click", (e) => {
      if (e.target.id !== "modalMask") return;
      // 仅当“按下”也在遮罩本身时才关闭；若从输入框/文本域内拖选文字、松手落在遮罩上，不关闭
      // （否则题目表单会消失，必须重新点“新增题目”，正是用户反馈的痛点）
      if (!maskDownOnMask) return;
      closeModal();
    });
    // 登录相关
    $("#loginBtn").addEventListener("click", doLogin);
    $("#logoutBtn").addEventListener("click", doLogout);
    $("#roleAdmin").addEventListener("click", () => {
      $("#roleAdmin").classList.add("active"); $("#roleRep").classList.remove("active");
      $("#adminFields").style.display = ""; $("#repFields").style.display = "none";
    });
    $("#roleRep").addEventListener("click", () => {
      $("#roleRep").classList.add("active"); $("#roleAdmin").classList.remove("active");
      $("#repFields").style.display = ""; $("#adminFields").style.display = "none";
    });
    // 题库页静态按钮（一次性绑定）
    const qbAdd = $("#qb-add"), qbImport = $("#qb-import"), qbExport = $("#qb-export"),
          qbQuery = $("#qb-query"), qbFile = $("#qb-file");
    if (qbAdd) qbAdd.onclick = () => openQuestionForm(null);
    if (qbImport) qbImport.onclick = () => qbFile.click();
    if (qbExport) qbExport.onclick = () => { window.location = "/api/questions/export"; };
    if (qbQuery) qbQuery.onclick = renderQuestions;
    if (qbFile) qbFile.onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      const fd = new FormData(); fd.append("file", f);
      try {
        const r = await fetch("/api/questions/import", { method: "POST", body: fd });
        const j = await r.json();
        if (!j.ok) throw new Error(j.msg);
        toast(`导入 ${j.data.imported} 题，错误 ${j.data.errors.length}`);
        await renderQuestions();
      } catch (err) { alert("导入失败: " + err.message); }
      e.target.value = "";
    };
  }

  /* ---------- 鉴权（本地验证；上云替换为 Google SSO） ---------- */
  async function checkAuth() {
    try { me = await api("/api/me"); } catch (e) { me = { role: "anon" }; }
    applyAuthUI();
  }
  function applyAuthUI() {
    const mask = $("#authMask"), bar = $("#userBar"), name = $("#userName");
    const navBtns = $$(".nav button");
    if (me.role === "anon") {
      mask.classList.add("show");
      bar.style.display = "none";
      navBtns.forEach((b) => (b.style.display = "none"));
      return;
    }
    mask.classList.remove("show");
    bar.style.display = "inline-flex";
    name.textContent = me.name || me.role;
    // 按 data-roles 显隐导航；admin 默认仅隐藏纯客服视图，rep 仅显示本人相关视图
    navBtns.forEach((b) => {
      const roles = (b.dataset.roles || "admin").split(",");
      b.style.display = roles.includes(me.role) ? "" : "none";
    });
    if (me.role === "admin") {
      // 恢复个人视图下拉与筛选（此前以客服身份登录时可能被隐藏，登回管理端需还原）
      $("#iv-rep") && ($("#iv-rep").style.display = "");
      const ivf = $("#view-individual .filters");
      if (ivf) ivf.style.display = "";
    } else { // rep：隐藏后台筛选
      $("#iv-rep") && ($("#iv-rep").style.display = "none");
      const ivf = $("#view-individual .filters");
      if (ivf) ivf.style.display = "none";
    }
    // 「修改密码」仅客服可见
    const cpb = $("#changePwBtn");
    if (cpb) cpb.style.display = me.role === "rep" ? "" : "none";
  }
  async function doLogin() {
    const role = $("#roleAdmin").classList.contains("active") ? "admin" : "rep";
    const payload = { role };
    if (role === "admin") payload.password = $("#loginPw").value;
    else { payload.name = $("#loginName").value.trim(); payload.password = $("#loginPwRep").value; }
    $("#loginErr").style.display = "none";
    try {
      me = await api("/api/login", { method: "POST", body: JSON.stringify(payload) });
      await loadSelectors();
      applyAuthUI();
      if (me.role === "rep") { switchView("mine"); renderMine(); }
      else { switchView("overview"); renderOverview(); }
    } catch (e) {
      $("#loginErr").textContent = e.message;
      $("#loginErr").style.display = "block";
    }
  }
  async function doLogout() {
    try { await api("/api/logout", { method: "POST" }); } catch (e) {}
    me = { role: "anon" };
    applyAuthUI();
  }
  // 客服修改本人密码
  function openChangePw() {
    openForm(T("rep_change_pw"), [
      { name: "old", label: T("rep_old_pw"), type: "password" },
      { name: "new", label: T("rep_new_pw"), type: "password" },
      { name: "confirm", label: T("rep_confirm_pw"), type: "password" },
    ], async (vals) => {
      if (vals.new !== vals.confirm) throw new Error(T("rep_pw_mismatch"));
      await api("/api/me/password", { method: "POST", body: JSON.stringify({ old: vals.old, new: vals.new }) });
      toast(T("rep_pw_changed"));
    });
  }
  // 构建员工姓名 datalist（登录用）
  function fillRepNames() {
    const dl = $("#repNames");
    if (dl) dl.innerHTML = state.reps.map((r) => `<option value="${r.name}">`).join("");
  }
  // 管理员/员工：展示弱项题目联动（题干 + 你的得分 + 正确答案 + 解析）
  // sessionIds: 为空/undefined=综合全部；单元素=该场错题；多元素=所选综合维度统计
  async function renderWeakness(repId, sessionIds) {
    repId = repId || me.rep_id;
    if (!repId) return;
    // 优先写入专属容器（个人视图，切换时整块替换，避免多面板叠加）；
    // 无该容器时回退为追加（兼容其它调用处）。
    let host = document.getElementById("iv-weak");
    const replace = !!host;
    if (!host) host = $("#iv-body");
    if (!host) return;
    let url = "/api/views/rep-weakness?rep_id=" + encodeURIComponent(repId);
    if (sessionIds && sessionIds.length) url += "&session_ids=" + sessionIds.join(",");
    let d;
    try { d = await api(url); }
    catch (e) {
      if (host) host.innerHTML = `<div class="field-err">⚠ ${T("la_load_fail")} ${escapeHtml(e.message)}</div>`;
      return;
    }
    if (!d || !d.ranking || !d.ranking.length) {
      const emptyHtml = `<div class="panel"><h3>${T("la_title")}</h3><div class="empty">${T("la_none")}</div></div>`;
      if (replace) host.innerHTML = emptyHtml; else host.insertAdjacentHTML("beforeend", emptyHtml);
      return;
    }
    // 范围标题：单场错题 / 综合 N 场 / 全部
    let scopeTitle = "";
    if (d.scope === "single" && d.exams && d.exams.length) {
      const ex = d.exams[0];
      scopeTitle = ` · ${escapeHtml(ex.exam_name)} <span class="muted">[${escapeHtml(ex.exam_date || "")}]</span>`;
    } else if (d.scope === "combined" && d.exams) {
      scopeTitle = ` · ${T("la_combined")} ${d.exams.length} ${T("la_exams")}`;
    } else {
      scopeTitle = ` · ${T("la_all")}`;
    }
    let html = `<div class="panel"><h3>${T("la_title")}${scopeTitle}</h3>
        <div class="la-summary">${escapeHtml(d.summary)}</div>`;
    for (const dim of d.ranking) {
      html += `<div class="la-dim">
        <div class="la-dim-head">${T("la_dim")}：<b>${escapeHtml(dim.name_cn)}</b> · ${T("la_weak_q")} ${dim.weak_count}</div>
        <div class="la-qlist">`;
      for (const q of dim.questions) {
        const opts = normalizeOptArr(q.options);
        let optHtml = "";
        if (opts && opts.length) {
          optHtml = `<div class="la-opts">` + opts.map((o) => {
            const corr = String(q.answer).toUpperCase().includes(o.key.toUpperCase());
            return `<span class="la-opt ${corr ? "correct" : ""}">${escapeHtml(o.key)}. ${escapeHtml(o.text)}</span>`;
          }).join("") + `</div>`;
        }
        const ansText = q.q_type === "judge"
          ? (q.answer === "true" ? "正确" : "错误")
          : (Array.isArray(q.answer) ? q.answer.join(",") : q.answer);
        const dimTags = (q.dims && q.dims.length)
          ? `<span class="tag dim">${q.dims.map((d) => escapeHtml(d)).join(" · ")}</span>` : "";
        // 综合/全部视图下，同一题号可能跨多场考试重复出现，标注所属考试让"你的得分"归属清晰
        const examTag = (d.scope !== "single" && q.exam_name)
          ? `<span class="tag exam">${escapeHtml(q.exam_name)}</span>` : "";
        html += `<div class="la-q">
          <div class="la-q-head">${escapeHtml(q.q)} · <span class="tag fail">${T("la_yours")} ${q.score}${T("pt_unit")} <span class="muted">/ ${q.max}</span></span> ${dimTags}${examTag}</div>
          <div class="la-content">${escapeHtml(q.content || "")}</div>
          ${optHtml}
          <div class="la-correct">${T("la_correct")}：<b>${escapeHtml(ansText || "—")}</b></div>
          ${q.explanation ? `<div class="la-feedback"><b>${T("la_feedback")}：</b>${escapeHtml(q.explanation)}</div>` : ""}
        </div>`;
      }
      html += `</div></div>`;
    }
    html += `</div>`;
    if (replace) host.innerHTML = html; else host.insertAdjacentHTML("beforeend", html);
  }

  /* ---------- 初始化 ---------- */
  async function init() {
    bind();
    const bk = await api("/api/backend").catch(() => ({ backend: "sqlite" }));
    $("#backendBadge").textContent = `${T("backend")}: ${bk.backend}`;
    await checkAuth();
    applyLang();
    if (me.role !== "anon") {
      if (me.role === "rep") { switchView("mine"); renderMine(); }
      else { switchView("overview"); renderOverview(); renderQuestionBanks().catch((e) => console.error("banks-init", e)); }
    }
  }
  /* ================= 题库 / 在线考试（前端） ================= */
  let dimCache = null;
  async function getDims(force) {
    if (force || !dimCache) dimCache = await api("/api/dimensions");
    return dimCache;
  }
  // 维度发生变化后使缓存失效，确保题库/资料库下拉立即反映最新维度
  function invalidateDims() { dimCache = null; }
  function typeLabel(qt) {
    return { single: T("qb_single"), multiple: T("qb_multiple"), judge: T("qb_judge"), essay: T("qb_essay") }[qt] || qt;
  }
  function parseOptions(text) {
    return text.split("\n").map((s) => s.trim()).filter(Boolean)
      .map((line, i) => {
        const m = line.match(/^[A-G][.、。)\s]\s*(.*)$/);
        return { key: String.fromCharCode(65 + i), text: m ? m[1] : line };
      });
  }
  function normAnswer(qt, raw) {
    raw = (raw || "").trim();
    if (qt === "single") return raw.toUpperCase();
    if (qt === "multiple") return JSON.stringify(raw.split(/[,，]/).map((s) => s.trim().toUpperCase()).filter(Boolean));
    if (qt === "judge") return (raw === "正确" || raw.toLowerCase() === "true") ? "true" : "false";
    return null;
  }

  async function renderQuestions() {
    const type = $("#qb-filter-type").value;
    const kw = $("#qb-kw").value.trim();
    const p = new URLSearchParams();
    if (type) p.set("q_type", type);
    if (kw) p.set("keyword", kw);
    let qs = [];
    try { qs = await api("/api/questions?" + p.toString()); } catch (e) { qs = []; }
    const body = $("#qb-body");
    const bulkBar = `<div class="qb-bulk-bar">
        <span class="muted" id="qb-bulk-count"></span>
        <button class="btn small" id="qb-bulk-set-source">${T("qb_bulk_set_source")}</button>
        <button class="btn small danger" id="qb-bulk-del">${T("qb_bulk_delete")}</button>
        <span class="muted">${T("qb_bulk_hint")}</span>
      </div>`;
    body.innerHTML = bulkBar + `<table><thead><tr>
      <th><input type="checkbox" id="qb-checkall" title="${T("qb_bulk_sel_all")}"></th>
      <th>${T("qb_type")}</th><th>${T("qb_content")}</th><th>${T("qb_dim")}</th>
      <th>${T("qb_score")}</th><th>${T("th_actions")}</th></tr></thead><tbody>${qs.map((q) => `<tr>
        <td><input type="checkbox" class="qb-chk" value="${q.question_id}"></td>
        <td>${typeLabel(q.q_type)}</td>
        <td style="max-width:420px;white-space:normal">${escapeHtml(q.content)}${q.source_exam ? `<div class="muted">📌 ${escapeHtml(q.source_exam)}</div>` : ""}${attachmentsHtml(q.attachments)}</td>
        <td>${q.dim_cn || "—"}</td>
        <td>${q.score}</td>
        <td>
          <button class="btn small" data-edit="${q.question_id}">${T("qb_edit")}</button>
          <button class="btn small danger" data-del="${q.question_id}">${T("mg_delete")}</button>
        </td></tr>`).join("")}</tbody></table>
      <div class="empty">${T("qb_count")}: ${qs.length}</div>`;
    $$("#qb-body [data-edit]").forEach((b) => b.addEventListener("click", async () => {
      const q = qs.find((x) => String(x.question_id) === b.dataset.edit);
      openQuestionForm(q);
    }));
    $$("#qb-body [data-del]").forEach((b) => b.addEventListener("click", () => delQuestion(b.dataset.del)));
    const syncBulk = () => {
      const n = $$("#qb-body .qb-chk:checked").length;
      $("#qb-bulk-count").textContent = T("qb_bulk_count").replace("%d", n);
    };
    $$("#qb-body .qb-chk").forEach((c) => c.addEventListener("change", syncBulk));
    const ca = $("#qb-checkall");
    if (ca) ca.addEventListener("change", () => {
      $$("#qb-body .qb-chk").forEach((c) => (c.checked = ca.checked)); syncBulk();
    });
    $("#qb-bulk-set-source").addEventListener("click", () => {
      const ids = $$("#qb-body .qb-chk:checked").map((c) => parseInt(c.value));
      if (!ids.length) { alert(T("qb_bulk_pick_first")); return; }
      openBulkSourceModal(ids);
    });
    $("#qb-bulk-del").addEventListener("click", () => {
      const ids = $$("#qb-body .qb-chk:checked").map((c) => parseInt(c.value));
      if (!ids.length) { alert(T("qb_bulk_pick_first")); return; }
      if (!confirm(T("qb_bulk_delete_confirm").replace("%d", ids.length))) return;
      bulkDeleteQuestions(ids);
    });
    syncBulk();
  }

  // 批量设置题目来源：弹窗让用户输入来源，非空才提交
  function openBulkSourceModal(ids) {
    $("#modalTitle").textContent = T("qb_bulk_title");
    $("#modalBody").innerHTML = `<div class="field"><label>${T("qb_bulk_source_ph")}</label>
        <input id="qb-modal-source" placeholder="${T("qb_bulk_source_ph")}" autofocus>
        <div id="qb-modal-err" class="muted" style="color:#e03131;display:none"></div></div>
      <div class="muted">${T("qb_bulk_modal_hint").replace("%d", ids.length)}</div>`;
    const save = $("#modalSave");
    save.disabled = false;
    save.textContent = T("qb_bulk_set_source");
    $("#modalMask").classList.add("show");
    const inp = $("#qb-modal-source");
    inp.focus();
    const submit = async () => {
      const source = inp.value.trim();
      if (!source) {
        $("#qb-modal-err").textContent = T("qb_bulk_err_empty");
        $("#qb-modal-err").style.display = "";
        inp.focus();
        return;
      }
      try {
        const r = await api("/api/questions/bulk-source", { method: "POST",
          body: JSON.stringify({ ids, source_exam: source }) });
        closeModal();
        toast((r.updated != null ? `${r.updated} ` : "") + T("qb_bulk_done"));
        await renderQuestions();
      } catch (e) { alert(e.message); }
    };
    save.onclick = submit;
    inp.onkeydown = (e) => { if (e.key === "Enter") submit(); };
  }

  // 题目附件：题库列表 / 组卷 / 考生端展示用
  function attachmentsHtml(atts) {
    if (!atts || !atts.length) return "";
    return `<div class="qatts">` + atts.map((a) =>
      `<a href="/api/attachments/${a.att_id}" target="_blank"><img src="/api/attachments/${a.att_id}" alt="${escapeHtml(a.filename || "附件")}" loading="lazy"></a>`).join("") + `</div>`;
  }

  // 出题弹窗内的附件缩略图列表（支持删除）
  function renderQfAttList(existing, pending) {
    const ex = (existing || []).map((a) =>
      `<span class="att-thumb"><img src="/api/attachments/${a.att_id}" alt=""><button type="button" class="att-del" data-delatt="${a.att_id}" title="${T("qb_del_attach")}">×</button></span>`).join("");
    const pe = (pending || []).map((p, i) =>
      `<span class="att-thumb"><img src="${p.url}" alt=""><button type="button" class="att-del" data-delatt="__pending__" data-idx="${i}" title="${T("qb_del_attach")}">×</button></span>`).join("");
    if (!ex && !pe) return `<span class="muted">${T("qb_no_attach")}</span>`;
    return ex + pe;
  }

  async function openQuestionForm(q) {
    const dims = await getDims();
    const isEdit = !!q;
    const qtype = q ? q.q_type : "single";
    const optsText = q && q.options ? JSON.parse(q.options).map((o) => `${o.key}.${o.text}`).join("\n") : "";
    let ansText = "";
    if (q && q.answer) {
      if (q.q_type === "multiple") ansText = JSON.parse(q.answer).join(",");
      else if (q.q_type === "judge") ansText = q.answer === "true" ? "正确" : "错误";
      else ansText = q.answer;
    }
    const dimName = (d) => (lang === "en" ? (d.name_en || d.name_cn) : d.name_cn);
    const dimOpts = dims.map((d) => `<option value="${d.dim_id}" ${q && q.dim_id === d.dim_id ? "selected" : ""}>${escapeHtml(dimName(d))}</option>`).join("");
    let existingAtts = [];
    if (isEdit) {
      try { existingAtts = await api("/api/questions/" + q.question_id + "/attachments"); } catch (e) { existingAtts = []; }
    }
    const pending = [];  // 新增模式下待上传的图片
    const body = `
      <div class="field"><label>${T("qb_qtype")}</label>
        <select id="qf-type">
          <option value="single" ${qtype === "single" ? "selected" : ""}>${T("qb_single")}</option>
          <option value="multiple" ${qtype === "multiple" ? "selected" : ""}>${T("qb_multiple")}</option>
          <option value="judge" ${qtype === "judge" ? "selected" : ""}>${T("qb_judge")}</option>
          <option value="essay" ${qtype === "essay" ? "selected" : ""}>${T("qb_essay")}</option>
        </select></div>
      <div class="field"><label>${T("qb_content")}</label><textarea id="qf-content">${escapeHtml(q ? q.content : "")}</textarea></div>
      <div class="field" id="qf-opt-wrap"><label>${T("qb_options")}</label>
        <div id="qf-opts"></div>
        <button type="button" class="btn small" id="qf-add-opt" style="margin-top:6px;">+ ${T("qb_add_option")}</button>
      </div>
      <div class="field"><label>${T("qb_dim")}</label><select id="qf-dim">${dimOpts}</select></div>
      <div class="field"><label>${T("qb_score")}</label><input id="qf-score" value="${q ? q.score : 5}"></div>
      <div class="field"><label>${T("qb_source")}</label><input id="qf-source" value="${escapeHtml(q && q.source_exam ? q.source_exam : "")}" placeholder="如：Aftersales Risk Handling Test"></div>
      <div class="field"><label>${T("qb_attach")}</label>
        <div id="qf-attach-list">${renderQfAttList(existingAtts, pending)}</div>
        <button type="button" class="btn small" id="qf-attach-add">${T("qb_add_attach")}</button>
        <input type="file" id="qf-attach" accept="image/*" multiple style="display:none">
      </div>
      <div class="field"><label>${T("qb_expl")}</label><textarea id="qf-expl">${escapeHtml(q && q.explanation ? q.explanation : "")}</textarea></div>`;
    $("#modalTitle").textContent = isEdit ? T("qb_edit") : T("qb_add");
    $("#modalBody").innerHTML = body;
    const renderAttList = () => { $("#qf-attach-list").innerHTML = renderQfAttList(existingAtts, pending); };
    $("#qf-attach-add").onclick = () => $("#qf-attach").click();
    $("#qf-attach").onchange = async (e) => {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      if (isEdit) {
        for (const f of files) {
          const fd = new FormData(); fd.append("file", f);
          try {
            const r = await fetch("/api/questions/" + q.question_id + "/attachments", { method: "POST", body: fd });
            const j = await r.json();
            if (!j.ok) throw new Error(j.msg);
            existingAtts.push(j.data);
          } catch (err) { alert("上传失败: " + err.message); }
        }
      } else {
        for (const f of files) pending.push({ file: f, url: URL.createObjectURL(f) });
      }
      renderAttList(); e.target.value = "";
    };
    $("#qf-attach-list").addEventListener("click", async (e) => {
      const del = e.target.closest("[data-delatt]");
      if (!del) return;
      const attId = del.getAttribute("data-delatt");
      if (attId === "__pending__") {
        pending.splice(parseInt(del.getAttribute("data-idx")), 1); renderAttList();
      } else {
        try { await api("/api/questions/attachments/" + attId, { method: "DELETE" }); } catch (err) { alert(err.message); }
        existingAtts = existingAtts.filter((a) => String(a.att_id) !== String(attId));
        renderAttList();
      }
    });
    // —— 动态选项编辑器（单选/多选/判断）——
    const optState = { type: qtype, items: [] };
    if (q && q.options) {
      const arr = JSON.parse(q.options);
      optState.items = arr.map((o) => ({ text: o.text || "", correct: false }));
      const ans = q.answer;
      if (qtype === "multiple") {
        let a = []; try { a = JSON.parse(ans || "[]"); } catch (e) { a = []; }
        optState.items.forEach((it, i) => { it.correct = a.includes(arr[i].key); });
      } else if (qtype === "single" || qtype === "judge") {
        optState.items.forEach((it, i) => { it.correct = (arr[i].key === ans); });
      }
    } else if (qtype === "judge") {
      optState.items = [{ text: T("judge_true"), correct: q && q.answer === "true" }, { text: T("judge_false"), correct: q && q.answer === "false" }];
    } else if (!q) {
      optState.items = [{ text: "", correct: false }, { text: "", correct: false }, { text: "", correct: false }];
    }
    const renderOptEditor = () => {
      const t = optState.type;
      const cont = $("#qf-opts");
      if (t === "essay") { cont.innerHTML = ""; return; }
      if (t === "judge") {
        cont.innerHTML = optState.items.map((it) => `
          <div class="qf-row"><input type="radio" name="qf-correct" class="qf-correct" ${it.correct ? "checked" : ""}>
            <input class="qf-opt-text" value="${escapeHtml(it.text)}" placeholder="${T("qb_opt_placeholder")}">
            <button type="button" class="qf-del-opt" title="删除">✕</button></div>`).join("");
      } else {
        const inputType = t === "multiple" ? "checkbox" : "radio";
        cont.innerHTML = optState.items.map((it, i) => `
          <div class="qf-row"><input type="${inputType}" name="qf-correct" class="qf-correct" ${it.correct ? "checked" : ""}>
            <span class="qf-key">${String.fromCharCode(65 + i)}</span>
            <input class="qf-opt-text" value="${escapeHtml(it.text)}" placeholder="${T("qb_opt_placeholder")}">
            <button type="button" class="qf-del-opt" title="删除">✕</button></div>`).join("");
      }
      cont.querySelectorAll(".qf-opt-text").forEach((inp, idx) => { inp.oninput = () => { optState.items[idx].text = inp.value; }; });
      cont.querySelectorAll(".qf-correct").forEach((cb, idx) => {
        cb.onchange = () => {
          if (cb.type === "radio") {
            // 单选/判断：同一组只能有一个正确；浏览器只对「新选中」项触发 change，
            // 被取消的那项 correct 不会自动置 false，因此在这里统一清空其余项。
            optState.items.forEach((it, i) => { it.correct = (i === idx); });
          } else {
            optState.items[idx].correct = cb.checked;
          }
        };
      });
      cont.querySelectorAll(".qf-del-opt").forEach((b, idx) => { b.onclick = () => { optState.items.splice(idx, 1); renderOptEditor(); }; });
    };
    const toggleAns = () => {
      const t = $("#qf-type").value;
      optState.type = t;
      $("#qf-opt-wrap").style.display = (t === "essay") ? "none" : "";
      $("#qf-add-opt").style.display = (t === "judge" || t === "essay") ? "none" : "";
      if (t === "judge") {
        if (optState.items.length !== 2)
          optState.items = [{ text: T("judge_true"), correct: false }, { text: T("judge_false"), correct: false }];
      } else if (t === "single" || t === "multiple") {
        if (optState.items.length === 0 || optState.items.every((it) => it.text === "正确" || it.text === "错误"))
          optState.items = [{ text: "", correct: false }, { text: "", correct: false }, { text: "", correct: false }];
      }
      renderOptEditor();
    };
    $("#qf-type").addEventListener("change", toggleAns);
    toggleAns();
    $("#qf-add-opt").onclick = () => { optState.items.push({ text: "", correct: false }); renderOptEditor(); };
    $("#modalMask").classList.add("show");
    $("#modalSave").onclick = async () => {
      try {
        const qt = $("#qf-type").value;
        const payload = {
          q_type: qt,
          content: $("#qf-content").value.trim(),
          dim_id: $("#qf-dim").value ? parseInt($("#qf-dim").value) : null,
          score: parseFloat($("#qf-score").value || 5),
          explanation: $("#qf-expl").value.trim(),
          source_exam: $("#qf-source").value.trim(),
        };
        if (qt === "essay") {
          payload.options = null; payload.answer = null;
        } else {
          const items = optState.items;
          const options = items.map((it, i) => ({
            key: qt === "judge" ? (i === 0 ? "true" : "false") : String.fromCharCode(65 + i),
            text: it.text
          }));
          payload.options = JSON.stringify(options);
          if (qt === "judge") {
            payload.answer = items[0].correct ? "true" : "false";
          } else if (qt === "single") {
            const ci = items.findIndex((it) => it.correct);
            payload.answer = ci >= 0 ? String.fromCharCode(65 + ci) : "";
          } else {
            payload.answer = JSON.stringify(items.map((it, i) => it.correct ? String.fromCharCode(65 + i) : null).filter(Boolean));
          }
        }
        if (!payload.content) throw new Error("题面必填");
        let newId = null;
        if (isEdit) await api("/api/questions/" + q.question_id, { method: "PUT", body: JSON.stringify(payload) });
        else { const r = await api("/api/questions", { method: "POST", body: JSON.stringify(payload) }); newId = r.question_id; }
        // 新增模式下，把待上传的图片落到新题目上
        if (!isEdit && newId != null) {
          for (const p of pending) {
            const fd = new FormData(); fd.append("file", p.file);
            try { await fetch("/api/questions/" + newId + "/attachments", { method: "POST", body: fd }); }
            catch (err) { alert("图片上传失败: " + err.message); }
          }
        }
        closeModal(); await renderQuestions(); toast(T("mg_saved"));
      } catch (e) { alert("Error: " + e.message); }
    };
  }

  async function delQuestion(id) {
    if (!confirm(T("mg_del_confirm"))) return;
    await api("/api/questions/" + id, { method: "DELETE" });
    await renderQuestions(); toast(T("mg_deleted"));
  }

  async function bulkDeleteQuestions(ids) {
    try {
      const r = await api("/api/questions/bulk", { method: "DELETE", body: JSON.stringify({ ids }) });
      toast((r.deleted != null ? `${r.deleted} ` : "") + T("qb_bulk_deleted"));
      await renderQuestions();
    } catch (e) { alert(e.message); }
  }

  async function renderExams() {
    let papers = [];
    try { papers = await api("/api/papers"); } catch (e) { papers = []; }
    const statusLabel = (s) => ({ draft: T("ex_draft"), published: T("ex_published"), closed: T("ex_closed") }[s] || s);
    $("#ex-body").innerHTML = `<table><thead><tr>
      <th>${T("ex_name")}</th><th>${T("ex_type")}</th><th>${T("ex_pscore")}</th>
      <th>${T("qb_count")}</th><th>${T("ex_status")}</th><th>${T("th_actions")}</th>
      </tr></thead><tbody>${papers.map((p) => `<tr>
        <td>${escapeHtml(p.title)}</td><td>${p.exam_type}</td><td>${p.pass_score}%</td>
        <td>${p.question_count}</td><td>${statusLabel(p.status)}</td>
        <td>
          <button class="btn small" data-compose="${p.paper_id}">${T("ex_questions")}</button>
          <button class="btn small" data-publish="${p.paper_id}" data-cur="${p.status}">${p.status === "published" ? T("ex_close") : T("ex_publish")}</button>
          <button class="btn small" data-preview="${p.paper_id}">${T("ex_preview")}</button>
          <button class="btn small" data-grade="${p.paper_id}">${T("ex_grade")}</button>
          <button class="btn small" data-makeup="${p.paper_id}">${T("ex_makeup")}</button>
          <button class="btn small danger" data-delpaper="${p.paper_id}">${T("mg_delete")}</button>
        </td></tr>`).join("")}</tbody></table>`;
    $("#ex-add").onclick = () => openPaperForm(null);
    $$("#ex-body [data-compose]").forEach((b) => b.addEventListener("click", () => renderExamCompose(parseInt(b.dataset.compose))));
    $$("#ex-body [data-publish]").forEach((b) => b.addEventListener("click", () => {
      if (b.dataset.cur === "published") setPaperStatus(parseInt(b.dataset.publish), "closed");
      else openPublishForm(parseInt(b.dataset.publish));
    }));
    $$("#ex-body [data-preview]").forEach((b) => b.addEventListener("click", () => openPreviewForm(parseInt(b.dataset.preview))));
    $$("#ex-body [data-grade]").forEach((b) => b.addEventListener("click", () => renderGrading(parseInt(b.dataset.grade))));
    $$("#ex-body [data-makeup]").forEach((b) => b.addEventListener("click", () => renderMakeup(parseInt(b.dataset.makeup))));
    $$("#ex-body [data-delpaper]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm(T("mg_del_confirm"))) return;
      await api("/api/papers/" + b.dataset.delpaper, { method: "DELETE" });
      await renderExams(); toast(T("mg_deleted"));
    }));
  }

  function openPaperForm(pid) {
    const body = `
      <div class="field"><label>${T("ex_name")}</label><input id="pf-title" value=""></div>
      <div class="field"><label>${T("ex_type")}</label>
        <select id="pf-type"><option value="onboarding">onboarding</option><option value="monthly">monthly</option><option value="quarterly">quarterly</option></select></div>
      <div class="field"><label>${T("ex_pscore")} (%)</label><input id="pf-pscore" value="60"><span class="muted" style="margin-left:6px">${T("ex_pscore_hint")}</span></div>
      <div class="field"><label>${T("ex_duration")}</label><input id="pf-dur" value="0"></div>`;
    $("#modalTitle").textContent = T("ex_add");
    $("#modalBody").innerHTML = body;
    $("#modalSave").style.display = "";
    $("#modalMask").classList.add("show");
    $("#modalSave").onclick = async () => {
      try {
        const payload = { title: $("#pf-title").value.trim(), exam_type: $("#pf-type").value,
          pass_score: parseFloat($("#pf-pscore").value || 60), duration_min: parseInt($("#pf-dur").value || 0) };
        if (!payload.title) throw new Error("标题必填");
        await api("/api/papers", { method: "POST", body: JSON.stringify(payload) });
        closeModal(); await renderExams(); toast(T("mg_saved"));
      } catch (e) { alert("Error: " + e.message); }
    };
  }

  async function renderExamCompose(pid) {
    const [paper, all] = await Promise.all([api("/api/papers/" + pid), api("/api/questions")]);
    const selected = (paper.questions || []).map((q) => q.question_id);
    // 来源按出现频次降序（常用置顶），选项后附题数，便于快速定位
    const srcCount = {};
    all.forEach((q) => { if (q.source_exam) srcCount[q.source_exam] = (srcCount[q.source_exam] || 0) + 1; });
    const sources = Object.keys(srcCount).sort((a, b) => srcCount[b] - srcCount[a]);
    const detail = $("#ex-detail");
    detail.style.display = "";
    const srcOpts = [`<option value="">${T("filter_all")}</option>`]
      .concat(sources.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)} (${srcCount[s]})</option>`)).join("");
    const closeCompose = () => { detail.style.display = "none"; detail.innerHTML = ""; };
    const rowHtml = (q) => `<label class="qrow" data-src="${escapeHtml(q.source_exam || "")}">
        <input type="checkbox" data-qid="${q.question_id}" ${selected.includes(q.question_id) ? "checked" : ""}>
        <span>[${typeLabel(q.q_type)}] ${escapeHtml(q.content)}${q.source_exam ? ` <em class="muted">·${escapeHtml(q.source_exam)}</em>` : ""}</span>
        ${attachmentsHtml(q.attachments)}</label>`;
    detail.innerHTML = `<div class="compose-head"><h3>${escapeHtml(paper.title)} — ${T("ex_questions")}</h3>
        <button class="btn small" id="ex-compose-close">${T("close")}</button></div>
      <div class="compose-bar">
        <label>${T("ex_src_filter")}: <select id="ex-src">${srcOpts}</select></label>
        <label>${T("ex_src_search")}: <input id="ex-src-search" placeholder="${T("ex_src_search_ph")}"></label>
        <button class="btn small" id="ex-select-all">${T("ex_select_all_visible")}</button>
      </div>
      <div class="qlist" id="ex-qlist">${all.map(rowHtml).join("")}</div>
      <button class="btn" id="ex-save-q">${T("save")}</button>`;
    // 按来源筛选 + 实时搜索（按来源子串过滤题目行，标签多时快速定位）
    const applySrcFilter = () => {
      const v = $("#ex-src").value;
      const kw = $("#ex-src-search").value.trim().toLowerCase();
      $$("#ex-qlist .qrow").forEach((row) => {
        const src = (row.getAttribute("data-src") || "").toLowerCase();
        const okSel = !v || src === (v || "").toLowerCase();
        const okKw = !kw || src.includes(kw);
        row.style.display = (okSel && okKw) ? "" : "none";
      });
    };
    $("#ex-src").onchange = applySrcFilter;
    $("#ex-src-search").addEventListener("input", applySrcFilter);
    $("#ex-select-all").onclick = () => {
      $$("#ex-qlist .qrow").forEach((row) => {
        if (row.style.display !== "none") {
          const cb = row.querySelector("input[type=checkbox]"); if (cb) cb.checked = true;
        }
      });
    };
    $("#ex-save-q").onclick = async () => {
      const items = $$("#ex-qlist input[data-qid]:checked").map((c, i) => ({ question_id: parseInt(c.dataset.qid), seq: i + 1 }));
      await api("/api/papers/" + pid + "/questions", { method: "PUT", body: JSON.stringify({ items }) });
      await renderExams(); toast(T("mg_saved"));
    };
    const closeBtn = $("#ex-compose-close");
    if (closeBtn) closeBtn.onclick = closeCompose;
  }

  async function setPaperStatus(pid, status) {
    await api("/api/papers/" + pid, { method: "PUT", body: JSON.stringify({ status }) });
    await renderExams(); toast(T("mg_saved"));
  }

  // 职级 / 渠道 取值（与名册一致）
  const POSITIONS = ["Intern", "Demoted P1", "P2", "P3", "P4", "P5", "P6", "TL", "QA"];
  const CHANNELS = ["Email", "LC", "CC"];

  // 发布试卷 + 指定可见客服（按在职/职级/渠道筛选）
  async function openPublishForm(pid) {
    let paper, reps;
    try { paper = await api("/api/papers/" + pid); reps = await api("/api/reps"); }
    catch (e) { alert(e.message); return; }
    const assigned = new Set(paper.assignments || []);
    const statusOpts = `<option value="">${T("filter_all")}</option><option value="active" selected>${T("mg_status_active")}</option><option value="left">${T("mg_status_left")}</option>`;
    const chOpts = `<option value="">${T("filter_all")}</option>` + CHANNELS.map((c) => `<option value="${c}">${c}</option>`).join("");
    const posChips = POSITIONS.map((p) => `<label class="chip"><input type="checkbox" class="pf-pos-chk" value="${escapeHtml(p)}"> ${escapeHtml(p)}</label>`).join("");
    function repRow(r, checked) {
      return `<label class="qrow"><input type="checkbox" class="rep-chk" value="${escapeHtml(r.rep_id)}" ${checked ? "checked" : ""}> ${escapeHtml(r.name)} <span class="muted">(${escapeHtml(r.rep_id)} · ${escapeHtml(r.position || "—")} · ${escapeHtml(r.channel || "—")})</span></label>`;
    }
    function renderList() {
      const fSt = $("#pf-f-status").value, fCh = $("#pf-f-channel").value;
      const selPos = new Set($$("#pf-f-position-chips .pf-pos-chk:checked").map((c) => c.value));
      const visible = reps.filter((r) =>
        (!fSt || (r.status || "active") === fSt) &&
        (!selPos.size || selPos.has(r.position || "")) &&
        (!fCh || (r.channel || "") === fCh));
      $("#pf-replist").innerHTML = visible.length
        ? visible.map((r) => repRow(r, assigned.size ? assigned.has(r.rep_id) : true)).join("")
        : '<span class="muted">（无匹配客服）</span>';
    }
    const body = `
      <div class="field"><label>${T("ex_name")}</label><div class="readonly">${escapeHtml(paper.title)}</div></div>
      <div class="field"><label>${T("ex_open_at")}</label><input id="pf-open" type="datetime-local"></div>
      <div class="field"><label>${T("ex_close_at")}</label><input id="pf-close" type="datetime-local"></div>
      <div class="field"><label>${T("ex_assign")}</label>
        <div class="rep-filter">
          <select id="pf-f-status" title="${T("ex_filter_status")}">${statusOpts}</select>
          <span class="chip-group" id="pf-f-position-chips" title="${T("ex_filter_position")}">${posChips}</span>
          <select id="pf-f-channel" title="${T("ex_filter_channel")}">${chOpts}</select>
          <button type="button" class="btn small" id="pf-selall">${T("ex_select_filtered")}</button>
        </div>
        <div class="muted">${T("ex_filter_position_multi")}</div>
        <div class="rep-list" id="pf-replist"></div>
        <div class="muted">${T("ex_assign_hint")}</div>
      </div>`;
    $("#modalTitle").textContent = T("ex_publish");
    $("#modalBody").innerHTML = body;
    $("#modalMask").classList.add("show");
    ["#pf-f-status", "#pf-f-channel"].forEach((s) => $(s).addEventListener("change", renderList));
    $$("#pf-f-position-chips .pf-pos-chk").forEach((c) => c.addEventListener("change", renderList));
    $("#pf-selall").addEventListener("click", () => {
      $$("#pf-replist .rep-chk").forEach((c) => { c.checked = true; });
    });
    renderList();
    $("#modalSave").onclick = async () => {
      const checked = $$("#modalBody .rep-chk:checked").map((c) => c.value);
      const payload = { rep_ids: checked };  // 空数组 = 全员广播
      const open = $("#pf-open").value, close = $("#pf-close").value;
      if (open) payload.open_at = open.replace("T", " ");
      if (close) payload.close_at = close.replace("T", " ");
      try {
        await api("/api/papers/" + pid + "/publish", { method: "POST", body: JSON.stringify(payload) });
        closeModal(); await renderExams(); toast(T("ex_published"));
      } catch (e) { alert("Error: " + e.message); }
    };
  }

  // 管理员预览：以某客服身份查看其能否看到该试卷 + 只读试题
  async function openPreviewForm(pid) {
    let paper, reps;
    try { paper = await api("/api/papers/" + pid); reps = await api("/api/reps"); }
    catch (e) { alert(e.message); return; }
    const repOpts = `<option value="">—</option>` + reps.map((r) => `<option value="${escapeHtml(r.rep_id)}">${escapeHtml(r.name)}</option>`).join("");
    const body = `
      <div class="field"><label>${T("pv_rep")}</label>
        <select id="pv-rep">${repOpts}</select>
        <button type="button" class="btn small" id="pv-go">${T("ex_preview")}</button>
      </div>
      <div id="pv-result"></div>`;
    $("#modalTitle").textContent = T("ex_preview") + " · " + paper.title;
    $("#modalBody").innerHTML = body;
    $("#modalMask").classList.add("show");
    $("#pv-go").onclick = async () => {
      const rid = $("#pv-rep").value;
      if (!rid) { alert("请先选择客服"); return; }
      const host = $("#pv-result");
      host.innerHTML = "加载中...";
      try {
        const avail = await api("/api/admin/preview-papers?rep_id=" + encodeURIComponent(rid));
        const visible = avail.some((p) => p.paper_id === pid);
        host.innerHTML = `<div class="tag ${visible ? "pass" : "fail"}">${visible ? T("pv_visible") : T("pv_not_visible")}</div>`
          + `<h4>${T("pv_questions")}</h4>`
          + (paper.questions || []).map((q, i) => `
            <div class="exam-q"><div class="eq-no">Q${i + 1}. [${typeLabel(q.q_type)}]</div>
            <div class="eq-content">${escapeHtml(q.content)}${attachmentsHtml(q.attachments)}</div></div>`).join("");
      } catch (e) { host.innerHTML = "错误: " + e.message; }
    };
  }

  async function renderGrading(pid) {
    let pend = [];
    try { pend = await api("/api/exam/grading"); } catch (e) { pend = []; }
    pend = pend.filter((x) => x.paper_id === pid);
    const detail = $("#ex-detail");
    detail.style.display = "";
    if (!pend.length) { detail.innerHTML = `<h3>${T("ex_grade")}</h3><div class="empty">${T("ex_pending")}: 0</div>`; return; }
    detail.innerHTML = `<h3>${T("ex_grade")} (${pend.length})</h3>` + pend.map((g, i) => `<div class="panel" style="margin-top:8px">
      <div><b>${escapeHtml(g.rep_name)}</b> · ${escapeHtml(g.paper_title)}</div>
      <div style="white-space:normal">${escapeHtml(g.content)}</div>
      <div class="muted">${T("ex_ans")}: ${escapeHtml(g.answer || "")}</div>
      <div class="field" style="margin-top:6px"><label>${T("th_total")} / ${T("ex_max")} ${g.max_score}</label>
        <input id="grade-${i}" type="number" step="0.5" max="${g.max_score}" value="0"></div>
      <button class="btn small" data-gi="${i}" data-att="${g.attempt_id}" data-q="${g.question_id}" data-max="${g.max_score}">${T("save")}</button>
    </div>`).join("");
    $$("#ex-detail [data-gi]").forEach((b) => b.addEventListener("click", async () => {
      const sc = parseFloat($("#grade-" + b.dataset.gi).value || 0);
      await api("/api/exam/grade", { method: "POST", body: JSON.stringify({ attempt_id: parseInt(b.dataset.att), question_id: parseInt(b.dataset.q), score: sc }) });
      await renderGrading(pid); toast(T("mg_saved"));
    }));
  }

  async function renderMakeup(pid) {
    let reps = state.reps || [];
    if (!reps.length) { try { reps = await api("/api/reps"); } catch (e) {} }
    const detail = $("#ex-detail");
    detail.style.display = "";
    const repOpts = reps.map((r) => `<option value="${r.rep_id}">${escapeHtml((r.name || r.rep_id) + " (" + r.rep_id + ")")}</option>`).join("");
    let list = [];
    try { list = await api("/api/papers/" + pid + "/makeup"); } catch (e) {}
    const listHtml = list.length
      ? `<h4 style="margin-top:12px">${T("ex_makeup_list")}</h4>` + list.map((m) => `<div class="panel" style="margin-top:6px;display:flex;justify-content:space-between;align-items:center;gap:10px">
          <div><b>${escapeHtml(m.rep_id)}</b> · ${T("ex_makeup_openat")} ${m.open_at || T("mine_none")} → ${m.due_at || T("ex_makeup_none")}</div>
          <button class="btn small danger" data-rev="${m.rep_id}">${T("ex_revoke")}</button></div>`).join("")
      : `<p class="muted" style="margin-top:12px">${T("ex_makeup_none")}</p>`;
    const closeDetail = () => { detail.style.display = "none"; detail.innerHTML = ""; };
    detail.innerHTML = `<div class="compose-head"><h3>${T("ex_makeup")}</h3>
      <button class="btn small" id="mk-close">${T("close")}</button></div>
      <p class="muted">${T("ex_makeup_tip")}</p>
      <div class="field"><label>${T("ex_makeup_rep")}</label><select id="mk-rep">${repOpts || `<option value="">（无客服）</option>`}</select></div>
      <div class="field"><label>${T("ex_makeup_open")}</label><input id="mk-open" type="datetime-local"></div>
      <div class="field"><label>${T("ex_makeup_due")}</label><input id="mk-due" type="datetime-local"></div>
      <div style="display:flex;gap:8px">
        <button class="btn" id="mk-save">${T("ex_makeup_save")}</button>
        <button class="btn small" id="mk-cancel">${T("cancel")}</button>
      </div>
      ${listHtml}`;
    $("#mk-close").onclick = closeDetail;
    $("#mk-cancel").onclick = closeDetail;
    $("#mk-save").onclick = async () => {
      const rep_id = $("#mk-rep").value;
      if (!rep_id) { alert("请选择客服"); return; }
      const open_at = $("#mk-open").value ? $("#mk-open").value.replace("T", " ") : null;
      const due_at = $("#mk-due").value ? $("#mk-due").value.replace("T", " ") : null;
      try {
        await api("/api/papers/" + pid + "/makeup", { method: "POST", body: JSON.stringify({ rep_id, open_at, due_at }) });
        await renderMakeup(pid); toast(T("mg_saved"));
      } catch (e) { alert("Error: " + e.message); }
    };
    $$("#ex-detail [data-rev]").forEach((b) => b.onclick = async () => {
      if (!confirm(T("mg_del_confirm"))) return;
      await api("/api/papers/" + pid + "/makeup/" + b.dataset.rev, { method: "DELETE" });
      await renderMakeup(pid); toast(T("mg_deleted"));
    });
  }

  async function renderMine() {
    // 可参加（仍 published 且未考）
    let avail = [];
    try { avail = await api("/api/exam/papers/available"); } catch (e) { avail = []; }
    const open = avail.filter((p) => !p.already_taken);
    // 在线考试记录（exam_attempts，可能为空）
    let history = [];
    try { history = await api("/api/exam/my-history"); } catch (e) { history = []; }
    // 维度弱项按场次选择用的场次列表（本人全部考试：批次成绩 + 在线考试）
    let recs = [];
    try {
      const ind = await api("/api/views/individual");
      recs = (ind.records || []).slice().sort((a, b) => (b.exam_date || "").localeCompare(a.exam_date || ""));
    } catch (e) { recs = []; }

    // 统一「我的考试」列表：批次/历史成绩(exam_results) 与 在线考试(exam_attempts) 合并，
    // 让客服能点开任意一场（含未通过在线模块的纯批次考试）查看得分与弱项，
    // 而不是只显示真正在模块里考过的那几条。
    const attemptBySession = {};
    history.forEach((h) => { if (h.session_id != null) attemptBySession[h.session_id] = h; });
    const mineExams = recs.map((r) => ({
      session_id: r.session_id,
      exam_name: r.exam_name,
      exam_date: r.exam_date,
      total: r.total,
      score_rate: r.score_rate,
      passed: r.passed,
      pass_score: r.pass_score,
      attempt_id: attemptBySession[r.session_id] ? attemptBySession[r.session_id].attempt_id : null,
    }));
    history.forEach((h) => {
      if (h.session_id == null || !recs.find((r) => r.session_id === h.session_id)) {
        mineExams.push({
          session_id: h.session_id,
          exam_name: h.paper_title,
          exam_date: (h.submit_time || h.start_time || "").slice(0, 10),
          total: h.total_score,
          score_rate: h.score_rate,
          passed: h.passed,
          pass_score: h.pass_score,
          attempt_id: h.attempt_id,
        });
      }
    });
    mineExams.sort((a, b) => (b.exam_date || "").localeCompare(a.exam_date || ""));

    const host = $("#mine-body");
    host.innerHTML = `<div class="mine-head"><h2>${T("mine_title")}</h2>
        <p class="muted">${T("mine_sub")}</p></div>` +
      `<h3>${T("mine_available")}</h3>` +
      (open.length ? `<div class="card-grid">${open.map((p) => `<div class="card">
        <div class="card-title">${escapeHtml(p.title)}</div>
        <div class="muted">${p.exam_type} · ${T("ex_pscore")}: ${p.pass_score}%</div>
        <button class="btn" data-take="${p.paper_id}">${T("ex_start")}</button></div>`).join("")}</div>`
        : `<div class="empty">${T("mine_none")}</div>`)
      + `<h3 style="margin-top:18px">${T("mine_history")}</h3>` +
      (mineExams.length ? `<table class="mine-exams"><thead><tr>
        <th>${T("th_exam")}</th><th>${T("th_date")}</th><th>${T("th_total")}</th>
        <th>${T("th_pscore")}</th><th>${T("th_pass")}</th><th></th></tr></thead><tbody>${mineExams.map((m) => {
          const st = (m.passed == null) ? "" : (m.passed ? T("th_pass_yes") : T("th_pass_no"));
          const stCls = (m.passed == null) ? "" : (m.passed ? "pass" : "fail");
          const kind = m.attempt_id ? "attempt" : "session";
          const att = m.attempt_id == null ? "" : m.attempt_id;
          const sess = m.session_id == null ? "" : m.session_id;
          const psTxt = (m.pass_score != null && m.pass_score !== "") ? (m.pass_score + "%") : "—";
          return `<tr class="mine-exam-row" data-kind="${kind}" data-att="${att}" data-session="${sess}" style="cursor:pointer">
            <td>${escapeHtml(m.exam_name)}</td>
            <td>${m.exam_date || "—"}</td>
            <td>${fmtScore(m)}${scorePctSuffix(m)}</td>
            <td>${psTxt}</td>
            <td><span class="tag ${stCls}">${st || "—"}</span></td>
            <td><button class="btn small" data-kind="${kind}" data-att="${att}" data-session="${sess}">${T("mine_view")}</button></td>
          </tr>`;
        }).join("")}</tbody></table>
        <p class="muted" style="margin-top:6px">${T("mine_row_tip")}</p>`
        : `<div class="empty">${T("mine_history_none")}</div>`)
      + `<h3 style="margin-top:18px">${T("mine_weak")}</h3>` +
      (recs.length ? `<div class="field"><label>${T("mine_weak_pick")}</label>
        <select id="mine-exam-sel">${recs.map((r) => `<option value="${r.session_id}">${escapeHtml(r.exam_name)} (${r.exam_date})</option>`).join("")}</select></div>
        <div id="mine-weak-box"></div>`
        : `<div class="empty">${T("mine_weak_none")}</div>`);

    $$("#mine-body [data-take]").forEach((b) => b.addEventListener("click", () => renderTakeExam(parseInt(b.dataset.take))));
    $$("#mine-body .mine-exam-row, #mine-body [data-kind]").forEach((b) => b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const att = b.dataset.att ? parseInt(b.dataset.att) : null;
      const sess = b.dataset.session ? parseInt(b.dataset.session) : null;
      const m = mineExams.find((x) => (x.session_id == sess) && (x.attempt_id == att));
      if (att) openExamReport(att, sess);
      else if (m) openSessionReport(m);
    }));
    if (recs.length) {
      const sel = $("#mine-exam-sel");
      sel.addEventListener("change", () => renderRepWeak(parseInt(sel.value), "#mine-weak-box"));
      await renderRepWeak(parseInt(sel.value), "#mine-weak-box");
    }
  }

  // 纯批次/历史成绩（无在线考试 attempt）的只读报告：得分 + 该场维度弱项与题目
  async function openSessionReport(m) {
    let wk = null;
    try { wk = await api(`/api/views/rep-weakness?session_ids=${encodeURIComponent(m.session_id)}`); } catch (e) { wk = null; }
    const body = (wk && wk.ranking && wk.ranking.length)
      ? weakQuestionsHtml(wk, null)
      : `<p class="muted">${T("wk_no_wrong")}</p>`;
    const st = (m.passed == null) ? "—" : (m.passed ? T("th_pass_yes") : T("th_pass_no"));
    const stCls = (m.passed == null) ? "" : (m.passed ? "pass" : "fail");
    const psTxt = (m.pass_score != null && m.pass_score !== "") ? (m.pass_score + "%") : "—";
    $("#mine-body").innerHTML = `<button class="btn secondary" id="mine-back">${T("mine_back")}</button>
      <h3>${escapeHtml(m.exam_name)} (${m.exam_date || ""})</h3>
      <p class="muted">${T("th_pscore")}: ${psTxt}</p>
      <div class="panel">
        <p>${T("result_summary")}: <b>${fmtScore(m)}${scorePctSuffix(m)}</b> · <span class="tag ${stCls}">${st}</span></p>
        <div id="exam-detail">${body}</div>
      </div>`;
    $("#mine-back").onclick = renderMine;
  }

  async function renderRepWeak(sessId, boxSel) {
    const box = $(boxSel);
    if (!box || !sessId) return;
    let wk = null;
    try { wk = await api(`/api/views/rep-weakness?session_ids=${encodeURIComponent(sessId)}`); } catch (e) { wk = null; }
    if (!wk || !wk.ranking || !wk.ranking.length) {
      box.innerHTML = `<p class="muted">${T("mine_weak_none")}</p>`;
      return;
    }
    box.innerHTML = weakQuestionsHtml(wk, null);
  }

  async function openExamReport(attemptId, sessionId) {
    let d;
    try { d = await api("/api/exam/attempt/" + attemptId); } catch (e) { alert(e.message); return; }
    const a = d.attempt;
    const statusTxt = { submitted: T("pending"), graded: (a.passed ? T("th_pass_yes") : T("th_pass_no")) }[a.status] || a.status;
    const rows = d.detail.map(examDetailRowHtml).join("");
    const wrongN = d.detail.filter((q) => q.is_correct === 0).length;
    let weakHtml = "";
    if (sessionId) {
      try {
        const wk = await api(`/api/views/rep-weakness?session_ids=${encodeURIComponent(sessionId)}`);
        if (wk && wk.ranking && wk.ranking.length) {
          weakHtml = `<h4 style="margin-top:14px">${T("mine_weak")}</h4>` + weakQuestionsHtml(wk, d.detail);
        } else weakHtml = `<p class="muted" style="margin-top:14px">${T("wk_no_wrong")}</p>`;
      } catch (e) { /* 忽略 */ }
    }
    let psTxt = "—";
    try {
      const paper = await api("/api/papers/" + a.paper_id);
      if (paper && paper.pass_score != null && paper.pass_score !== "") psTxt = paper.pass_score + "%";
    } catch (e) { /* 忽略 */ }
    $("#mine-body").innerHTML = `<button class="btn secondary" id="mine-back">${T("mine_back")}</button>
      <h3>${T("ex_result")}</h3>
      <p class="muted">${T("th_pscore")}: ${psTxt}</p>
      <div class="panel">
        <p>${T("result_summary")}: <b>${fmtScore({ score_rate: a.score_rate, total: a.total_score })}${scorePctSuffix({ score_rate: a.score_rate, total: a.total_score })}</b> · ${statusTxt}</p>
        <p class="muted">${T("wrong_count").replace("%d", wrongN)}</p>
        <button class="btn secondary" id="exam-wrong-toggle" ${wrongN ? "" : "disabled"}>${T("show_wrong_only")} (${wrongN})</button>
      </div>
      <div id="exam-detail">${rows}</div>
      <div class="panel" style="margin-top:18px">${weakHtml}</div>`;
    bindWrongToggle();
    $("#mine-back").onclick = renderMine;
  }

  function bindWrongToggle() {
    const toggle = $("#exam-wrong-toggle");
    if (!toggle) return;
    let only = false;
    const countWrong = () => $$("#exam-detail .exam-q[data-wrong='1']").length;
    toggle.onclick = () => {
      only = !only;
      $$("#exam-detail .exam-q").forEach((el) => {
        el.style.display = (only && el.dataset.wrong !== "1") ? "none" : "";
      });
      toggle.textContent = only ? `${T("show_all_q")} (${countWrong()})` : `${T("show_wrong_only")} (${countWrong()})`;
    };
  }

  async function renderTakeExam(pid) {
    const paper = await api("/api/papers/" + pid);
    const qs = paper.questions || [];
    const host = $("#mine-body");
    host.innerHTML = `<h3>${escapeHtml(paper.title)}</h3><div id="exam-form">${qs.map((q, i) => {
      let input;
      if (q.q_type === "essay") input = `<textarea id="a_${q.question_id}" placeholder="..."></textarea>`;
      else {
        const opts = q.options_parsed || [];
        const type = q.q_type === "multiple" ? "checkbox" : "radio";
        input = opts.map((o) => `<label><input type="${type}" name="a_${q.question_id}" value="${o.key}"> ${escapeHtml(o.text)}</label>`).join("<br>");
      }
      return `<div class="exam-q"><div class="eq-no">Q${i + 1}. [${typeLabel(q.q_type)}]</div>
        <div class="eq-content">${escapeHtml(q.content)}${attachmentsHtml(q.attachments)}</div><div class="eq-opts">${input}</div></div>`;
    }).join("")}<button class="btn" id="exam-submit">${T("ex_submit")}</button></div>`;
    $("#exam-submit").onclick = async () => {
      const answers = {};
      for (const q of qs) {
        if (q.q_type === "essay") answers[q.question_id] = $("#a_" + q.question_id).value;
        else {
          const els = $$(`input[name="a_${q.question_id}"]:checked`);
          answers[q.question_id] = q.q_type === "multiple" ? els.map((e) => e.value) : (els[0] ? els[0].value : null);
        }
      }
      try {
        const att = await api("/api/exam/attempt/start", { method: "POST", body: JSON.stringify({ paper_id: pid }) });
        await api("/api/exam/attempt/" + att.attempt_id + "/submit", { method: "POST", body: JSON.stringify({ answers }) });
        await showExamResult(att.attempt_id);
      } catch (e) { alert("Error: " + e.message); }
    };
  }

  async function showExamResult(attempt_id) {
    const d = await api("/api/exam/attempt/" + attempt_id);
    const a = d.attempt;
    const statusTxt = { submitted: T("pending"), graded: (a.passed ? T("th_pass_yes") : T("th_pass_no")) }[a.status] || a.status;
    const wrongN = d.detail.filter((q) => q.is_correct === 0).length;
    const rows = d.detail.map(examDetailRowHtml).join("");
    $("#mine-body").innerHTML = `<h3>${T("ex_result")}</h3>
      <div class="panel">
        <p>${T("result_summary")}: <b>${fmtScore({ score_rate: a.score_rate, total: a.total_score })}${scorePctSuffix({ score_rate: a.score_rate, total: a.total_score })}</b> · ${statusTxt}</p>
        <p class="muted">${T("wrong_count").replace("%d", wrongN)}</p>
        <button class="btn secondary" id="exam-wrong-toggle" ${wrongN ? "" : "disabled"}>${T("show_wrong_only")} (${wrongN})</button>
      </div>
      <div id="exam-detail">${rows}</div>
      <button class="btn" onclick="location.reload()">${T("close")}</button>`;
    bindWrongToggle();
  }

  // ---------------- 系统设置 / 积分 / 资料库 / 智能推荐 ----------------
  let _dimsCache = null;
  async function getDims(force) {
    if (force || !_dimsCache) _dimsCache = await api("/api/dimensions");
    return _dimsCache;
  }
  function invalidateDims() { _dimsCache = null; }
  function matTypeName(m) {
    return ({ text: T("mat_t_text"), image: T("mat_t_image"), ppt: T("mat_t_ppt"),
      pdf: T("mat_t_pdf"), video: T("mat_t_video"), link: T("mat_t_link") })[m] || m;
  }
  // link 类型资料的内容类型标签（标明是 Word/Excel/视频等）
  function linkKindLabel(k) {
    return ({ word: "📄 " + T("mat_lk_word"), excel: "📊 " + T("mat_lk_excel"),
      pdf: "📕 " + T("mat_lk_pdf"), video: "🎬 " + T("mat_lk_video"),
      web: "🔗 " + T("mat_lk_web") })[k] || (k || "");
  }
  async function renderConfig() {
    await renderDimensions();
    const cfg = await api("/api/system-config");
    $("#cfg-pass-line").value = cfg.pass_line_ratio != null ? cfg.pass_line_ratio : "0.88";
    $("#cfg-threshold").value = cfg.points_threshold != null ? cfg.points_threshold : 100;
    $("#cfg-rec-top").value = cfg.recommend_top_n != null ? cfg.recommend_top_n : 3;
    $("#cfg-rec-quiz").value = cfg.recommend_quiz_n != null ? cfg.recommend_quiz_n : 5;
    // Q6 周期目标
    const pperiod = cfg.period || "quarter";
    const ptarget = cfg.period_target != null ? cfg.period_target : 0;
    $("#cfg-period").value = pperiod;
    $("#cfg-period-target").value = ptarget;
    const rules = cfg.points_rules || {};
    $("#cfg-participate").value = rules.participate != null ? rules.participate : 10;
    $("#cfg-material").value = rules.material != null ? rules.material : 5;
    $("#cfg-mini-quiz").value = rules.mini_quiz != null ? rules.mini_quiz : 10;
    const tiers = rules.pass || { 0.88: 20, 0.90: 30, 0.95: 40 };
    const tierKeys = Object.keys(tiers).sort();
    $("#cfg-pass-tiers").innerHTML = tierKeys.map((k) =>
      `<div class="tier-row">
        <input type="number" step="0.01" min="0" max="1" class="tier-thr" value="${k}" placeholder="得分率(0~1)">
        <span>${T("cfg_tier_ge")}</span>
        <input type="number" step="1" min="0" class="tier-val" value="${tiers[k]}" placeholder="积分">
      </div>`).join("");
    $("#cfg-save").onclick = async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      try {
        const payload = {
          pass_line_ratio: $("#cfg-pass-line").value,
          points_threshold: $("#cfg-threshold").value,
          points_period: $("#cfg-period").value,
          points_period_target: parseInt($("#cfg-period-target").value, 10) || 0,
          recommend_top_n: parseInt($("#cfg-rec-top").value, 10) || 3,
          recommend_quiz_n: parseInt($("#cfg-rec-quiz").value, 10) || 5,
          points_rules: {
            participate: parseInt($("#cfg-participate").value, 10) || 0,
            material: parseInt($("#cfg-material").value, 10) || 0,
            mini_quiz: parseInt($("#cfg-mini-quiz").value, 10) || 0,
            pass: {}
          }
        };
        $$("#cfg-pass-tiers .tier-row").forEach((row) => {
          const thr = parseFloat(row.querySelector(".tier-thr").value);
          const val = parseInt(row.querySelector(".tier-val").value, 10) || 0;
          if (!isNaN(thr)) payload.points_rules.pass[thr] = val;
        });
        await api("/api/system-config", { method: "PUT", body: JSON.stringify(payload) });
        toast(T("cfg_saved"));
      } catch (e) {
        // 任何保存失败都给出明确提示，而不是在控制台抛 "Failed to fetch"
        alert((T("cfg_save_fail") || "保存失败") + "：" + (e.message || e));
      } finally {
        btn.disabled = false;
      }
    };
    $("#cfg-change-pw").onclick = async () => {
      const current_pw = $("#cfg-current-pw").value.trim();
      const new_pw = $("#cfg-new-pw").value.trim();
      const safe_key = $("#cfg-safe-key").value.trim();
      if (!current_pw || !new_pw) {
        alert(T("cfg_pw_empty") || "当前密码和新密码都不能为空");
        return;
      }
      if (new_pw.length < 4) {
        alert(T("cfg_pw_too_short") || "新密码至少 4 个字符");
        return;
      }
      if (!safe_key) {
        alert(T("cfg_safe_key_required") || "安全密钥不能为空");
        return;
      }
      try {
        await api("/api/admin/change-password", {
          method: "POST",
          body: JSON.stringify({ current_password: current_pw, new_password: new_pw, safe_key: safe_key })
        });
        toast(T("cfg_pw_changed") || "管理员密码已修改");
        $("#cfg-current-pw").value = "";
        $("#cfg-new-pw").value = "";
        $("#cfg-safe-key").value = "";
      } catch (e) {
        alert((T("cfg_save_fail") || "修改失败") + "：" + (e.message || e));
      }
    };
  }

  async function renderDimensions() {
    if (me.role !== "admin") {
      const p = document.getElementById("dim-body");
      if (p) p.innerHTML = "";
      return;
    }
    let dims = [];
    try { dims = await api("/api/dimensions"); } catch (e) { dims = []; }
    const body = document.getElementById("dim-body");
    if (!body) return;
    body.innerHTML = dims.length ? `<table class="tbl"><thead><tr>
      <th><input type="checkbox" id="dim-checkall" title="${T("mg_batch_del")}"></th>
      <th>${T("dim_cn")}</th><th>${T("dim_en")}</th><th></th></tr></thead><tbody>${dims.map((d) => `<tr data-dim="${d.dim_id}">
        <td><input type="checkbox" class="dim-bulk-chk" value="${d.dim_id}"></td>
        <td><input class="dim-cn" value="${escapeHtml(d.name_cn || "")}"></td>
        <td><input class="dim-en" value="${escapeHtml(d.name_en || "")}"></td>
        <td>
          <a class="link dim-save" data-dim="${d.dim_id}">${T("save")}</a>
          <a class="link dim-del" data-dim="${d.dim_id}">${T("delete")}</a>
        </td></tr>`).join("")}</tbody></table>` : `<div class="empty">${T("dim_empty")}</div>`;
    const syncDel = () => {
      const n = $$("#dim-body .dim-bulk-chk:checked").length;
      const btn = $("#dim-batch-del-btn");
      if (btn) btn.style.display = n > 0 ? "" : "none";
    };
    $$("#dim-body .dim-bulk-chk").forEach((c) => c.addEventListener("change", syncDel));
    const ca = $("#dim-checkall");
    if (ca) ca.onclick = () => { $$("#dim-body .dim-bulk-chk").forEach((c) => (c.checked = ca.checked)); syncDel(); };
    syncDel();
    $$("#dim-body .dim-save").forEach((a) => a.onclick = async () => {
      const tr = a.closest("tr");
      const cn = tr.querySelector(".dim-cn").value.trim();
      const en = tr.querySelector(".dim-en").value.trim();
      if (!cn) { alert(T("dim_cn_req")); return; }
      try {
        await api("/api/dimensions/" + a.dataset.dim, { method: "PUT", body: JSON.stringify({ name_cn: cn, name_en: en }) });
        invalidateDims(); toast(T("saved")); renderDimensions();
      } catch (e) { alert(e.message); }
    });
    $$("#dim-body .dim-del").forEach((a) => a.onclick = async () => {
      if (!confirm(T("dim_del_confirm"))) return;
      try {
        await api("/api/dimensions/" + a.dataset.dim, { method: "DELETE" });
        invalidateDims(); toast(T("deleted")); renderDimensions();
      } catch (e) { alert(e.message); }
    });
    const add = document.getElementById("dim-add");
    if (add) add.onclick = () => {
      const cn = prompt(T("dim_cn_prompt"));
      if (!cn) return;
      const en = prompt(T("dim_en_prompt") + "（" + T("optional") + "）") || "";
      api("/api/dimensions", { method: "POST", body: JSON.stringify({ name_cn: cn.trim(), name_en: en.trim() }) })
        .then(() => { invalidateDims(); toast(T("saved")); renderDimensions(); })
        .catch((e) => alert(e.message));
    };
  }

  async function renderPoints() {
    // 年份下拉（首次填充可选年份，默认当前年）
    const years = await api("/api/points/years");
    const ySel = $("#pt-year");
    if (!ySel.dataset.ready) {
      ySel.innerHTML = years.map((y) => `<option value="${y}">${y}</option>`).join("");
      const cur = new Date().getFullYear();
      ySel.value = years.includes(cur) ? String(cur) : (years[0] != null ? String(years[0]) : String(cur));
      ySel.dataset.ready = "1";
      ySel.onchange = renderPoints;
    }
    const year = ySel.value || String(new Date().getFullYear());
    const rows = await api("/api/points/summary?year=" + year);
    const filter = ($("#pt-filter").value) || "all";
    const filtered = rows.filter((r) => filter === "all" ? true : (filter === "pass" ? r.meets : !r.meets));
    const total = rows.reduce((s, r) => s + (r.year_total || 0), 0);
    const meetsN = rows.filter((r) => r.meets).length;
    const periodT = rows.length > 0 ? (rows[0].period_target || 0) : 0;
    const periodN = periodT > 0 ? rows.filter((r) => r.period_meets).length : -1;
    $("#pt-summary").textContent =
      `${T("pt_year")} ${year} · ${T("pt_total_reps")} ${rows.length} · ${T("pt_meet")} ${meetsN} · ${T("pt_avg")} ${rows.length ? Math.round(total / rows.length) : 0}` +
      (periodN >= 0 ? ` · ${T("pt_period_title") || "当期达标"} ${periodN}` : "");
    const periodCol = periodT > 0 ? `<th>${T("pt_period") || "当期"}</th>` : "";
    const periodCell = (r) => periodT > 0
      ? `<td><span class="badge ${r.period_meets ? "ok" : "no"}">${r.period_points}/${r.period_target}</span></td>`
      : "";
    $("#pt-body").innerHTML = rows.length ? `<table class="tbl"><thead><tr>
      <th>${T("pt_rep")}</th><th>${T("pt_name")}</th><th>${T("pt_position")}</th><th>${T("pt_channel")}</th>
      <th>${T("pt_q1")}</th><th>${T("pt_q2")}</th><th>${T("pt_q3")}</th><th>${T("pt_q4")}</th>
      <th>${T("pt_year_total")}</th>${periodCol}<th>${T("pt_threshold")}</th><th>${T("pt_status")}</th><th></th>
    </tr></thead><tbody>${filtered.map((r) => `<tr class="${r.meets ? "" : "pt-fail"}" data-rep="${r.rep_id}">
      <td>${r.rep_id}</td><td>${r.name || ""}</td><td>${r.position || ""}</td><td>${r.channel || ""}</td>
      <td>${r.q1 || 0}</td><td>${r.q2 || 0}</td><td>${r.q3 || 0}</td><td>${r.q4 || 0}</td>
      <td><b>${r.year_total || 0}</b></td>${periodCell(r)}<td>${r.threshold}</td>
      <td><span class="badge ${r.meets ? "ok" : "no"}">${r.meets ? T("pt_meet") : T("pt_not_meet")}</span></td>
      <td><a class="link pt-log" data-rep="${r.rep_id}">${T("pt_log")}</a></td>
    </tr>`).join("")}</tbody></table>` : `<div class="empty">${T("pt_empty")}</div>`;
    $$("#pt-body .pt-log").forEach((a) => a.onclick = () => showPointsLog(a.dataset.rep));
    $("#pt-filter").onchange = renderPoints;
  }

  // Q5 客服端：我的积分
  async function renderRepPoints() {
    const years = await api("/api/points/years");
    const ySel = $("#rpt-year");
    if (!ySel.dataset.ready) {
      ySel.innerHTML = years.map((y) => `<option value="${y}">${y}</option>`).join("");
      const cur = new Date().getFullYear();
      ySel.value = years.includes(cur) ? String(cur) : (years[0] != null ? String(years[0]) : String(cur));
      ySel.dataset.ready = "1";
      ySel.onchange = renderRepPoints;
    }
    const year = ySel.value || String(new Date().getFullYear());
    const p = await api("/api/points/me?year=" + year);
    // 年度卡片
    $("#rpt-year-val").textContent = p.total || 0;
    $("#rpt-year-target-val").textContent = p.threshold || 0;
    const ys = $("#rpt-year-status-val");
    ys.textContent = p.meets ? (T("pt_meet") || "达标") : (T("pt_not_meet") || "未达标");
    ys.className = "val " + (p.meets ? "ok" : "no");
    // 周期卡片
    const ps = $("#rpt-period-status");
    const psv = $("#rpt-period-status-val");
    if (p.period_target > 0) {
      $("#rpt-period-val").textContent = p.period_points || 0;
      $("#rpt-period-target-val").textContent = p.period_target;
      psv.textContent = p.period_meets ? (T("pt_meet") || "达标") : (T("pt_not_meet") || "未达标");
      psv.className = "val " + (p.period_meets ? "ok" : "no");
      ps.style.display = "flex";
    } else {
      $("#rpt-period-val").textContent = "-";
      $("#rpt-period-target-val").textContent = "-";
      psv.textContent = "-";
      psv.className = "val";
      ps.style.display = "none";
    }
    // 季度明细
    $("#rpt-q1").textContent = p.q1 || 0;
    $("#rpt-q2").textContent = p.q2 || 0;
    $("#rpt-q3").textContent = p.q3 || 0;
    $("#rpt-q4").textContent = p.q4 || 0;
    // 积分记录
    const log = await api("/api/points/" + (p.rep_id || "") + "/log?year=" + year);
    $("#rpt-log").innerHTML = log.length ? `<table class="tbl"><thead><tr>
      <th>${T("pt_rule")}</th><th>${T("pt_q")}</th><th>${T("pt_delta")}</th><th>${T("pt_note")}</th><th>${T("pt_time")}</th></tr></thead>
      <tbody>${log.map((l) => `<tr><td>${l.rule_key}</td><td>Q${l.quarter || ""}</td><td>${l.delta > 0 ? "+" : ""}${l.delta}</td>
        <td>${l.note || ""}</td><td>${l.created_at || ""}</td></tr>`).join("")}</tbody></table>`
      : `<div class="empty">${T("pt_no_log")}</div>`;
  }

  async function showPointsLog(repId) {
    const year = ($("#pt-year").value) || String(new Date().getFullYear());
    const log = await api("/api/points/" + repId + "/log?year=" + year);
    const body = log.length ? `<table class="tbl"><thead><tr>
      <th>${T("pt_rule")}</th><th>${T("pt_q")}</th><th>${T("pt_delta")}</th><th>${T("pt_note")}</th><th>${T("pt_time")}</th></tr></thead>
      <tbody>${log.map((l) => `<tr><td>${l.rule_key}</td><td>Q${l.quarter || ""}</td><td>${l.delta > 0 ? "+" : ""}${l.delta}</td>
        <td>${l.note || ""}</td><td>${l.created_at || ""}</td></tr>`).join("")}</tbody></table>`
      : `<div class="empty">${T("pt_no_log")}</div>`;
    $("#modalTitle").textContent = `${T("pt_log_title")} · ${repId} · ${year}`;
    $("#modalBody").innerHTML = `<div style="max-height:55vh;overflow:auto">${body}</div>`;
    $("#modalSave").style.display = "none";
    $("#modalMask").classList.add("show");
  }

  async function renderMaterials() {
    const isAdmin = me.role === "admin";
    $("#mat-admin-panel").style.display = isAdmin ? "" : "none";
    $("#mat-rep-panel").style.display = "";
    const dims = await getDims();
    const dimName = (id) => { const d = dims.find((x) => String(x.dim_id) === String(id)); return d ? (d.name_cn || d.name_en) : (id || ""); };
    if (isAdmin) {
      const mats = await api("/api/materials");
      $("#mat-admin-body").innerHTML = mats.length ? `<table class="tbl"><thead><tr>
        <th><input type="checkbox" id="mat-checkall" title="${T("mg_batch_del")}"></th>
        <th>${T("mat_title_col")}</th><th>${T("mat_type")}</th><th>${T("mat_dim")}</th><th></th></tr></thead>
        <tbody>${mats.map((m) => `<tr data-mid="${m.material_id}">
          <td><input type="checkbox" class="mat-chk" value="${m.material_id}"></td>
          <td>${escapeHtml(m.title)}</td><td>${matTypeName(m.mtype)}${m.mtype === "link" && m.link_kind ? " · " + linkKindLabel(m.link_kind) : ""}</td><td>${m.dim_ids ? m.dim_ids.map((d) => dimName(d)).join("、") : dimName(m.dim_id)}</td>
          <td><a class="link mat-edit" data-mid="${m.material_id}">${T("edit")}</a> · <a class="link mat-del" data-mid="${m.material_id}">${T("delete")}</a></td>
        </tr>`).join("")}</tbody></table>` : `<div class="empty">${T("mat_empty")}</div>`;
      $$("#mat-admin-body .mat-edit").forEach((a) => a.onclick = () => {
        const mid = a.dataset.mid;
        const m = mats.find((x) => String(x.material_id) === String(mid));
        openMaterialForm(m);
      });
      $$("#mat-admin-body .mat-del").forEach((a) => a.onclick = async () => {
        if (!confirm(T("mat_del_confirm"))) return;
        await api("/api/materials/" + a.dataset.mid, { method: "DELETE" });
        toast(T("deleted")); renderMaterials();
      });
      const syncDel = () => {
        const n = $$("#mat-admin-body .mat-chk:checked").length;
        const btn = $("#mat-batch-del-btn");
        if (btn) btn.style.display = n > 0 ? "" : "none";
      };
      $$("#mat-admin-body .mat-chk").forEach((c) => c.addEventListener("change", syncDel));
      const ca = $("#mat-checkall");
      if (ca) ca.onclick = () => { $$("#mat-admin-body .mat-chk").forEach((c) => (c.checked = ca.checked)); syncDel(); };
      syncDel();
      $("#mat-add").onclick = () => openMaterialForm();
    }
    const mats = await api("/api/materials");
    $("#mat-rep-body").innerHTML = mats.length ? mats.map((m) => {
      const hasText = !!m.content;
      const dims = (m.dim_ids && m.dim_ids.length) ? m.dim_ids : (m.dim_id ? [m.dim_id] : []);
      const quizBtns = dims.map((d) =>
        `<button class="btn small secondary mat-quiz" data-dim="${d}" data-name="${escapeHtml(dimName(d))}">${T("mat_quiz")}·${escapeHtml(dimName(d))}</button>`).join("");
      return `<div class="mat-card" data-mid="${m.material_id}">
        <div class="mat-card-head"><b>${escapeHtml(m.title)}</b><span class="muted">${matTypeName(m.mtype)}${m.mtype === "link" && m.link_kind ? " · " + linkKindLabel(m.link_kind) : ""} · ${(dims.map((d) => dimName(d)).join("、") || "—")}</span></div>
        ${hasText ? `<div class="mat-card-text">${escapeHtml(m.content).slice(0, 120)}${m.content.length > 120 ? "…" : ""}</div>` : ""}
        <div class="mat-card-actions">
          <button class="btn small mat-open" data-mid="${m.material_id}">${T("mat_open")}</button>
          ${quizBtns}
        </div></div>`;
    }).join("") : `<div class="empty">${T("mat_empty")}</div>`;
    $$("#mat-rep-body .mat-open").forEach((b) => b.onclick = () => openMaterialDetail(b.dataset.mid));
    $$("#mat-rep-body .mat-quiz").forEach((b) => b.onclick = () => takeQuiz(b.dataset.dim, b.dataset.name));
  }

  function openMaterialForm(m) {
    const isEdit = !!(m && m.material_id);
    getDims().then((dims) => {
      const dimChks = dims.map((d) => {
        const checked = isEdit && m.dim_ids && m.dim_ids.map(String).includes(String(d.dim_id));
        return `<label class="chk-item"><input type="checkbox" class="mat-dim-chk" value="${d.dim_id}" ${checked ? "checked" : ""}> ${escapeHtml(d.name_cn || d.name_en)}</label>`;
      }).join("");
      $("#modalTitle").textContent = isEdit ? T("mat_edit") : T("mat_add");
      const curFile = (isEdit && m.file_path) ? `<div class="muted">${T("mat_cur_file")}: ${escapeHtml(m.file_path.split("/").pop())}</div>` : "";
      $("#modalBody").innerHTML = `
        <div class="field"><label>${T("mat_title_col")}</label><input data-name="title" value="${isEdit ? escapeHtml(m.title) : ""}"></div>
        <div class="field"><label>${T("mat_type")}</label><select data-name="mtype">
          <option value="text" ${isEdit && m.mtype === "text" ? "selected" : ""}>${T("mat_t_text")}</option>
          <option value="image" ${isEdit && m.mtype === "image" ? "selected" : ""}>${T("mat_t_image")}</option>
          <option value="ppt" ${isEdit && m.mtype === "ppt" ? "selected" : ""}>${T("mat_t_ppt")}</option>
          <option value="pdf" ${isEdit && m.mtype === "pdf" ? "selected" : ""}>${T("mat_t_pdf")}</option>
          <option value="video" ${isEdit && m.mtype === "video" ? "selected" : ""}>${T("mat_t_video")}</option>
          <option value="link" ${isEdit && m.mtype === "link" ? "selected" : ""}>${T("mat_t_link")}</option></select></div>
        <div class="field"><label>${T("mat_dims")}</label>
          <div class="chk-group" id="mat-dim-chks">${dimChks || `<span class="muted">（暂无维度）</span>`}</div></div>
        <div class="field"><label>${T("mat_content")}</label><textarea data-name="content" rows="4">${isEdit ? escapeHtml(m.content || "") : ""}</textarea></div>
        <div class="field"><label>${T("mat_url")}</label><input data-name="url" value="${isEdit ? escapeHtml(m.url || "") : ""}"></div>
        <div class="field" id="mat-link-kind-field" style="display:none"><label>${T("mat_link_kind")}</label><select data-name="link_kind">
          <option value="">${T("mat_lk_auto")}</option>
          <option value="word" ${isEdit && m.link_kind === "word" ? "selected" : ""}>${T("mat_lk_word")}</option>
          <option value="excel" ${isEdit && m.link_kind === "excel" ? "selected" : ""}>${T("mat_lk_excel")}</option>
          <option value="pdf" ${isEdit && m.link_kind === "pdf" ? "selected" : ""}>${T("mat_lk_pdf")}</option>
          <option value="video" ${isEdit && m.link_kind === "video" ? "selected" : ""}>${T("mat_lk_video")}</option>
          <option value="web" ${isEdit && m.link_kind === "web" ? "selected" : ""}>${T("mat_lk_web")}</option></select></div>
        <div class="field"><label>${T("mat_file")}</label><input type="file" data-name="file">${curFile}</div>`;
      $("#modalSave").style.display = "";
      // 仅当类型为「链接」时显示内容类型下拉
      const mtypeSel = $("#modalBody [data-name='mtype']");
      const lkField = document.getElementById("mat-link-kind-field");
      mtypeSel.onchange = () => { lkField.style.display = (mtypeSel.value === "link") ? "" : "none"; };
      lkField.style.display = (mtypeSel.value === "link") ? "" : "none";
      $("#modalMask").classList.add("show");
      $("#modalSave").onclick = async () => {
        const fd = new FormData();
        $$("#modalBody [data-name]").forEach((el) => {
          if (el.type === "file") { if (el.files[0]) fd.append(el.dataset.name, el.files[0]); }
          else fd.append(el.dataset.name, el.value);
        });
        const sel = $$("#mat-dim-chks .mat-dim-chk:checked").map((c) => c.value);
        fd.delete("dim_id");
        if (sel.length) fd.append("dim_ids", sel.join(","));
        $("#modalSave").disabled = true;
        try {
          const url = isEdit ? ("/api/materials/" + m.material_id) : "/api/materials";
          const method = isEdit ? "PUT" : "POST";
          const r = await fetch(url, { method, body: fd });
          const j = await r.json();
          if (!j.ok) throw new Error(j.msg);
          closeModal(); toast(T("saved")); renderMaterials();
        } catch (e) { alert("Error: " + e.message); }
        finally { $("#modalSave").disabled = false; }
      };
    });
  }

  async function openMaterialDetail(mid) {
    await api("/api/materials/" + mid + "/open", { method: "POST" });
    const m = await api("/api/materials/" + mid);
    const dims = await getDims();
    const dimIds = (m.dim_ids && m.dim_ids.length) ? m.dim_ids : (m.dim_id ? [m.dim_id] : []);
    const dimNames = dimIds.map((d) => {
      const d0 = dims.find((x) => String(x.dim_id) === String(d));
      return d0 ? (d0.name_cn || d0.name_en) : d;
    });
    let body = `<div class="mat-detail">
      <div class="muted">${m.mtype ? matTypeName(m.mtype) : ""}${m.mtype === "link" && m.link_kind ? " · " + linkKindLabel(m.link_kind) : ""}${dimNames.length ? " · " + escapeHtml(dimNames.join("、")) : ""}</div>`;
    if (m.content) body += `<div class="mat-detail-text" style="margin:10px 0">${escapeHtml(m.content).replace(/\n/g, "<br>")}</div>`;
    if (m.file_path) body += `<p><a class="btn small" href="/api/materials/${m.material_id}/file" target="_blank">${T("mat_download")}</a></p>`;
    if (m.url) body += `<p><a class="btn small" href="${escapeHtml(m.url)}" target="_blank">${T("mat_open_link")}</a></p>`;
    body += `<div style="margin-top:10px">` + dimIds.map((d) => {
      const dn = dims.find((x) => String(x.dim_id) === String(d));
      return `<button class="btn mat-detail-quiz" data-dim="${d}" data-name="${escapeHtml((dn && (dn.name_cn || dn.name_en)) || String(d))}">${T("mat_quiz")}·${escapeHtml((dn && (dn.name_cn || dn.name_en)) || String(d))}</button>`;
    }).join(" ") + `</div></div>`;
    $("#modalTitle").textContent = m.title || T("mat_title");
    $("#modalBody").innerHTML = body;
    $("#modalSave").style.display = "none";
    $("#modalMask").classList.add("show");
    $$(".mat-detail-quiz").forEach((qb) => qb.onclick = () => takeQuiz(qb.dataset.dim, qb.dataset.name));
  }

  function takeQuiz(dimId, title) {
    api("/api/quiz/draw?dim_id=" + dimId + "&n=5").then((d) => {
      const qs = d.questions || [];
      if (!qs.length) {
        $("#modalTitle").textContent = title || T("quiz_title");
        $("#modalBody").innerHTML = `<div class="empty">${T("quiz_no_q")}</div>`;
        $("#modalSave").style.display = "none";
        $("#modalMask").classList.add("show");
        return;
      }
      const html = qs.map((q, i) => {
        const multi = q.q_type === "multiple";
        const inpType = multi ? "checkbox" : "radio";
        return `<div class="quiz-q" data-qid="${q.question_id}" data-multi="${multi ? 1 : 0}">
        <div class="qq-title">${i + 1}. ${escapeHtml(q.question)}</div>
        <div class="opt-list">${q.options.map((o) => `<label class="opt-item"><input type="${inpType}" name="q${q.question_id}" value="${o.key}">
          <span class="opt-key">${o.key}</span><span class="opt-text">${escapeHtml(o.text)}</span></label>`).join("")}</div>
      </div>`;
      }).join("");
      $("#modalTitle").textContent = (title || T("quiz_title")) + ` (${qs.length})`;
      $("#modalBody").innerHTML = `<div id="quiz-box">${html}</div>
        <button class="btn" id="quiz-submit">${T("quiz_submit")}</button>`;
      $("#modalSave").style.display = "none";
      $("#modalMask").classList.add("show");
      $("#quiz-submit").onclick = async () => {
        const answers = {};
        qs.forEach((q) => {
          const name = `q${q.question_id}`;
          if (q.q_type === "multiple") {
            const sels = $$(`input[name="${name}"]:checked`);
            answers[q.question_id] = sels.map((el) => el.value);
          } else {
            const sel = document.querySelector(`input[name="${name}"]:checked`);
            answers[q.question_id] = sel ? sel.value : "";
          }
        });
        try {
          const res = await api("/api/quiz/" + d.quiz_id + "/submit", { method: "POST", body: JSON.stringify({ answers }) });
          const msg = res.passed
            ? `${T("quiz_pass")} (${res.correct}/${res.total}, +${res.points_awarded})`
            : `${T("quiz_fail")} (${res.correct}/${res.total})`;
          $("#quiz-box").innerHTML = `<div class="quiz-result ${res.passed ? "ok" : "bad"}">${msg}</div>
            <div class="muted">${T("quiz_tip")}</div>`;
        } catch (e) { alert("Error: " + e.message); }
      };
    }).catch((e) => alert(e.message));
  }

  async function renderRecommend() {
    const d = await api("/api/recommend");
    if (!d.sessions || !d.sessions.length) {
      $("#rec-intro").textContent = T("rec_empty_hint");
      $("#rec-body").innerHTML = `<div class="empty">${T("rec_no_weak")}</div>`;
      return;
    }
    const dimName = (dim) => (lang === "en" ? (dim.name_en || dim.name_cn) : dim.name_cn);
    $("#rec-intro").textContent = `${T("rec_intro")} · ${T("rec_quiz_n").replace("%d", d.quiz_n)}`;
    $("#rec-body").innerHTML = d.sessions.map((sess) => {
      const passTxt = (sess.passed == null) ? "" : (sess.passed ? T("rec_session_pass") : T("rec_session_fail"));
      const passCls = (sess.passed == null) ? "" : (sess.passed ? "pass" : "fail");
      const dimsHtml = sess.dims.map((dim) => {
        const mats = (dim.materials && dim.materials.length)
          ? dim.materials.map((m) => `<li><a class="link rec-mat" data-mid="${m.material_id}">${escapeHtml(m.title)}</a></li>`).join("")
          : `<li class="muted">${T("rec_no_mat")}</li>`;
        let quizBadge = "";
        if (dim.quiz && dim.quiz.done) {
          quizBadge = dim.quiz.passed
            ? `<span class="badge ok">${T("rec_quiz_done")} · ${T("rec_quiz_pass")}</span>`
            : `<span class="badge no">${T("rec_quiz_done")} · ${T("rec_quiz_fail")}</span>`;
        }
        return `<div class="rec-dim" data-dim="${dim.dim_id}" data-sess="${sess.session_id}">
          <div class="rec-dim-head"><b>${escapeHtml(dimName(dim))}</b>
            <span class="badge no">${T("rec_weak")} ${dim.weak_count}</span>
            ${quizBadge}
            <button class="btn small" id="rec-quiz-${sess.session_id}-${dim.dim_id}" data-dim="${dim.dim_id}" data-name="${escapeHtml(dimName(dim))}">${T("rec_take_quiz")}</button></div>
          <div class="muted">${T("rec_materials")}</div>
          <ul class="rec-mats">${mats}</ul>
        </div>`;
      }).join("");
      return `<div class="rec-session">
        <div class="rec-session-head"><b>${escapeHtml(sess.exam_name)}</b>
          <span class="muted">${escapeHtml(sess.exam_date || "")}</span>
          ${passTxt ? `<span class="tag ${passCls}">${passTxt}</span>` : ""}</div>
        ${dimsHtml}
      </div>`;
    }).join("");
    d.sessions.forEach((sess) => {
      sess.dims.forEach((dim) => {
        const b = $("#rec-quiz-" + sess.session_id + "-" + dim.dim_id);
        if (b) b.onclick = () => takeQuiz(b.dataset.dim, b.dataset.name);
      });
    });
    $$("#rec-body .rec-mat").forEach((a) => a.onclick = () => openMaterialDetail(a.dataset.mid));
  }

  document.addEventListener("DOMContentLoaded", init);
})();
