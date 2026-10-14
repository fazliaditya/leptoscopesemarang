(() => {
  "use strict";

  const API_URL = "/api/simulate/annual";
  const DISTRICT_COUNT = 16;

  const RISK_COLORS = {
    "Rendah": "#2ca25f",
    "Sedang": "#fee08b",
    "Tinggi": "#fdae61",
    "Sangat Tinggi": "#d73027"
  };

  const state = {
    map: null,
    layer: null,
    legend: null,
    data: null,
    view: "scenario",
    firstFit: true,
    requestController: null
  };

  const PRESETS = {
    baseline: { rain: 0, humidity: 0, temperature: 0, cases: 0 },
    wet: { rain: 40, humidity: 4, temperature: -0.5, cases: 0 },
    extreme: { rain: 80, humidity: 8, temperature: -1, cases: 2 },
    cases: { rain: 20, humidity: 2, temperature: 0, cases: 5 }
  };

  const byId = id => document.getElementById(id);

  const escapeHtml = value => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

  const districtName = properties =>
    properties.kecamatan_name ||
    properties.kecamatan ||
    properties.district_name ||
    properties.WADMKC ||
    "Kecamatan";

  const number = value => Number(value || 0);

  const decimal = (value, digits = 3) =>
    new Intl.NumberFormat("id-ID", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    }).format(number(value));

  const signed = (value, digits = 3, suffix = "") => {
    const parsed = number(value);
    const prefix = parsed > 0 ? "+" : "";
    return `${prefix}${decimal(parsed, digits)}${suffix}`;
  };

  function removeLegacyUI() {
    ["ls-sim-open", "ls-sim-modal"].forEach(id => {
      const element = byId(id);
      if (element) element.remove();
    });
  }

  function createUI() {
    if (byId("ls20-sim-open")) return;

    removeLegacyUI();

    document.body.insertAdjacentHTML("beforeend", `
      <button id="ls20-sim-open" class="ls20-open" type="button">
        <span class="ls20-open-icon" aria-hidden="true">◫</span>
        Simulasi Risiko
      </button>

      <section id="ls20-modal" class="ls20-modal" aria-hidden="true">
        <div class="ls20-dialog" role="dialog" aria-modal="true"
             aria-labelledby="ls20-title">
          <header class="ls20-header">
            <div>
              <p class="ls20-eyebrow">Eksplorasi skenario historis 2023</p>
              <h2 id="ls20-title">Simulasi Skenario LeptoScope</h2>
              <p>
                Bandingkan baseline dan respons model pada seluruh kecamatan.
              </p>
            </div>
            <button id="ls20-close" class="ls20-close" type="button"
                    aria-label="Tutup simulasi">×</button>
          </header>

          <div class="ls20-layout">
            <aside class="ls20-controls">
              <div class="ls20-section-heading">
                <div>
                  <span>Parameter</span>
                  <h3>Kondisi berkelanjutan</h3>
                </div>
                <button id="ls20-reset" class="ls20-text-button" type="button">
                  Reset
                </button>
              </div>

              <div class="ls20-presets" aria-label="Preset simulasi">
                <button type="button" data-preset="baseline" class="active">
                  Baseline
                </button>
                <button type="button" data-preset="wet">Musim basah</button>
                <button type="button" data-preset="extreme">Ekstrem</button>
                <button type="button" data-preset="cases">Tekanan kasus</button>
              </div>

              <label class="ls20-control" for="ls20-rain">
                <span>
                  <span>Curah hujan</span>
                  <strong id="ls20-rain-value">0%</strong>
                </span>
                <input id="ls20-rain" type="range"
                       min="-40" max="80" step="5" value="0">
                <small>Perubahan relatif selama periode simulasi</small>
              </label>

              <label class="ls20-control" for="ls20-humidity">
                <span>
                  <span>Kelembapan</span>
                  <strong id="ls20-humidity-value">0 poin</strong>
                </span>
                <input id="ls20-humidity" type="range"
                       min="-10" max="10" step="1" value="0">
                <small>Perubahan dalam poin persentase</small>
              </label>

              <label class="ls20-control" for="ls20-temperature">
                <span>
                  <span>Suhu udara</span>
                  <strong id="ls20-temperature-value">0°C</strong>
                </span>
                <input id="ls20-temperature" type="range"
                       min="-2" max="2" step="0.5" value="0">
                <small>Perubahan terhadap suhu historis</small>
              </label>

              <label class="ls20-control" for="ls20-cases">
                <span>
                  <span>Kasus berjalan</span>
                  <strong id="ls20-cases-value">0</strong>
                </span>
                <input id="ls20-cases" type="range"
                       min="0" max="10" step="1" value="0">
                <small>Tambahan kasus per kecamatan pada periode berjalan</small>
              </label>

              <button id="ls20-run" class="ls20-run" type="button">
                <span>Jalankan Simulasi</span>
                <span aria-hidden="true">→</span>
              </button>

              <div id="ls20-status" class="ls20-status" role="status">
                Siap menggunakan baseline 2023.
              </div>

              <div class="ls20-method-note">
                <strong>Catatan metode</strong>
                <p>
                  Perubahan diterapkan pada nilai saat ini, lag, dan rata-rata
                  bergerak. Kelas risiko memakai batas baseline tetap agar
                  skenario dapat dibandingkan secara konsisten.
                </p>
              </div>
            </aside>

            <main class="ls20-main">
              <section class="ls20-kpis" aria-label="Ringkasan simulasi">
                <article>
                  <span>Perubahan rata-rata</span>
                  <strong id="ls20-kpi-change">–</strong>
                  <small id="ls20-kpi-change-note">dibanding baseline</small>
                </article>
                <article>
                  <span>Kelas berubah</span>
                  <strong id="ls20-kpi-class">–</strong>
                  <small>kecamatan berpindah kelas</small>
                </article>
                <article>
                  <span>Bulan peringatan</span>
                  <strong id="ls20-kpi-alert">–</strong>
                  <small>dari 192 kecamatan-bulan</small>
                </article>
                <article class="ls20-kpi-primary">
                  <span>Respons terbesar</span>
                  <strong id="ls20-kpi-impact">–</strong>
                  <small id="ls20-kpi-impact-note">berdasarkan kelas dan peringatan</small>
                </article>
              </section>

              <section class="ls20-toolbar">
                <div class="ls20-view-switch" role="group"
                     aria-label="Tampilan peta simulasi">
                  <button type="button" data-view="baseline">Baseline</button>
                  <button type="button" data-view="scenario" class="active">
                    Skenario
                  </button>
                  <button type="button" data-view="change">Perubahan</button>
                </div>
                <div id="ls20-context" class="ls20-context">
                  Baseline tahunan 2023
                </div>
              </section>

              <div class="ls20-visual-grid">
                <div class="ls20-map-wrap">
                  <div id="ls20-map"></div>
                  <div id="ls20-map-loading" class="ls20-map-loading" hidden>
                    <span></span>
                    Menghitung skenario…
                  </div>
                </div>

                <aside class="ls20-ranking">
                  <div>
                    <span class="ls20-ranking-label">Urutan respons</span>
                    <h3>5 wilayah paling responsif</h3>
                    <p>Prioritas perubahan kelas, bulan peringatan, lalu skor.</p>
                  </div>
                  <ol id="ls20-impact-list"></ol>
                  <div class="ls20-risk-leader">
                    <span>Risiko skenario tertinggi</span>
                    <strong id="ls20-risk-leader">–</strong>
                  </div>
                </aside>
              </div>

              <footer class="ls20-footer">
                <span>
                  Skor merupakan peringatan relatif, bukan probabilitas klinis.
                </span>
                <span id="ls20-updated">Belum dijalankan</span>
              </footer>
            </main>
          </div>
        </div>
      </section>
    `);

    placeOpenButton();
    bindEvents();
    updateSliderLabels();
  }

  function placeOpenButton() {
    const openButton = byId("ls20-sim-open");
    const methodButton = byId("methodButton");

    if (openButton && methodButton?.parentElement) {
      openButton.classList.add("inline");
      methodButton.parentElement.insertBefore(openButton, methodButton);
    }
  }

  function bindEvents() {
    byId("ls20-sim-open").addEventListener("click", openModal);
    byId("ls20-close").addEventListener("click", closeModal);
    byId("ls20-modal").addEventListener("click", event => {
      if (event.target === byId("ls20-modal")) closeModal();
    });

    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && byId("ls20-modal")?.classList.contains("open")) {
        closeModal();
      }
    });

    ["rain", "humidity", "temperature", "cases"].forEach(key => {
      byId(`ls20-${key}`).addEventListener("input", () => {
        updateSliderLabels();
        clearPresetSelection();
        markDirty();
      });
    });

    document.querySelectorAll("[data-preset]").forEach(button => {
      button.addEventListener("click", () => {
        setPreset(button.dataset.preset);
        runSimulation();
      });
    });

    document.querySelectorAll("[data-view]").forEach(button => {
      button.addEventListener("click", () => {
        state.view = button.dataset.view;
        updateViewButtons();
        if (state.data) renderMap(state.data, false);
      });
    });

    byId("ls20-run").addEventListener("click", runSimulation);
    byId("ls20-reset").addEventListener("click", () => {
      setPreset("baseline");
      runSimulation();
    });
  }

  function openModal() {
    const modal = byId("ls20-modal");
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("ls20-no-scroll");

    initializeMap();

    window.setTimeout(() => {
      state.map.invalidateSize();
      if (!state.data) runSimulation();
    }, 160);
  }

  function closeModal() {
    const modal = byId("ls20-modal");
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("ls20-no-scroll");
  }

  function initializeMap() {
    if (state.map) return;

    state.map = L.map("ls20-map", {
      zoomControl: false,
      preferCanvas: true,
      minZoom: 9,
      maxZoom: 17
    }).setView([-7.005, 110.438], 11);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors"
    }).addTo(state.map);

    L.control.zoom({ position: "topleft" }).addTo(state.map);
    L.control.scale({ position: "bottomleft", imperial: false }).addTo(state.map);
  }

  function setPreset(name) {
    const preset = PRESETS[name] || PRESETS.baseline;

    byId("ls20-rain").value = preset.rain;
    byId("ls20-humidity").value = preset.humidity;
    byId("ls20-temperature").value = preset.temperature;
    byId("ls20-cases").value = preset.cases;

    document.querySelectorAll("[data-preset]").forEach(button => {
      button.classList.toggle("active", button.dataset.preset === name);
    });

    updateSliderLabels();
  }

  function clearPresetSelection() {
    document.querySelectorAll("[data-preset]").forEach(button => {
      button.classList.remove("active");
    });
  }

  function updateSliderLabels() {
    byId("ls20-rain-value").textContent = `${byId("ls20-rain").value}%`;
    byId("ls20-humidity-value").textContent =
      `${byId("ls20-humidity").value} poin`;
    byId("ls20-temperature-value").textContent =
      `${byId("ls20-temperature").value}°C`;
    byId("ls20-cases-value").textContent = byId("ls20-cases").value;
  }

  function markDirty() {
    byId("ls20-status").textContent =
      "Parameter berubah. Jalankan simulasi untuk memperbarui peta.";
    byId("ls20-status").classList.add("dirty");
  }

  function currentParameters() {
    return {
      rainfall_change_percent: byId("ls20-rain").value,
      humidity_change_point: byId("ls20-humidity").value,
      temperature_change_c: byId("ls20-temperature").value,
      additional_cases: byId("ls20-cases").value
    };
  }

  function isBaseline(parameters) {
    return Object.values(parameters).every(value => number(value) === 0);
  }

  async function runSimulation() {
    const parameters = currentParameters();
    const query = new URLSearchParams(parameters);
    const runButton = byId("ls20-run");
    const status = byId("ls20-status");
    const loading = byId("ls20-map-loading");

    if (state.requestController) state.requestController.abort();
    state.requestController = new AbortController();

    runButton.disabled = true;
    loading.hidden = false;
    status.classList.remove("dirty", "error");
    status.textContent = "Menghitung 12 bulan × 16 kecamatan…";

    try {
      const response = await fetch(`${API_URL}?${query.toString()}`, {
        cache: "no-store",
        signal: state.requestController.signal
      });

      if (!response.ok) {
        const detail = await response.text();
        throw new Error(detail || `HTTP ${response.status}`);
      }

      const data = await response.json();
      state.data = data;
      renderResults(data);

      const modeText = isBaseline(parameters)
        ? "Baseline 2023 berhasil dimuat."
        : "Skenario berhasil dihitung dan dibandingkan dengan baseline.";

      status.textContent = modeText;
    } catch (error) {
      if (error.name === "AbortError") return;
      console.error(error);
      status.classList.add("error");
      status.textContent =
        "Simulasi gagal. Pastikan backend v4.0.0 aktif, lalu coba lagi.";
    } finally {
      runButton.disabled = false;
      loading.hidden = true;
    }
  }

  function renderResults(data) {
    renderKpis(data.metadata || {});
    renderImpactRanking(data.features || []);
    renderMap(data, state.firstFit);
    renderContext(data.metadata || {});
    state.firstFit = false;
  }

  function renderKpis(metadata) {
    byId("ls20-kpi-change").textContent =
      signed(metadata.mean_risk_delta, 4);
    byId("ls20-kpi-change-note").textContent =
      `${signed(metadata.average_change_percent, 1, "%")} dari baseline`;

    byId("ls20-kpi-class").textContent =
      `${metadata.changed_class_districts || 0}/${DISTRICT_COUNT}`;

    byId("ls20-kpi-alert").textContent =
      `${metadata.total_alert_months || 0}/192`;

    byId("ls20-kpi-impact").textContent =
      metadata.impact_district || "Belum ada perubahan";
    byId("ls20-kpi-impact-note").textContent =
      number(metadata.impact_delta) === 0
        ? "atur parameter untuk melihat dampak"
        : `${signed(metadata.impact_delta, 4)} · perubahan skor`;

    byId("ls20-risk-leader").textContent =
      `${metadata.highest_risk_district || "–"} · ` +
      `${decimal(metadata.highest_risk_score, 4)}`;

    const updated = metadata.last_updated
      ? new Date(metadata.last_updated).toLocaleString("id-ID", {
          dateStyle: "medium",
          timeStyle: "short"
        })
      : "–";
    byId("ls20-updated").textContent = `Diperbarui ${updated}`;
  }

  function renderContext(metadata) {
    const parameters = metadata.parameters || {};
    const baseline = Object.values(parameters)
      .every(value => number(value) === 0);

    byId("ls20-context").textContent = baseline
      ? "Baseline tahunan 2023 · tanpa perubahan parameter"
      : `CH ${signed(parameters.rainfall_change_percent, 0, "%")} · ` +
        `RH ${signed(parameters.humidity_change_point, 0, " poin")} · ` +
        `T ${signed(parameters.temperature_change_c, 1, "°C")} · ` +
        `Kasus +${number(parameters.additional_cases)}`;
  }

  function renderImpactRanking(features) {
    const sorted = [...features]
      .sort((a, b) =>
        number(a.properties?.sim_impact_rank) -
        number(b.properties?.sim_impact_rank)
      )
      .slice(0, 5);

    const maximum = Math.max(
      ...sorted.map(feature =>
        Math.abs(number(feature.properties?.sim_risk_delta))
      ),
      0
    );

    if (maximum < 1e-8) {
      byId("ls20-impact-list").innerHTML = `
        <li class="empty">
          Gunakan slider atau preset untuk membentuk skenario.
        </li>
      `;
      return;
    }

    byId("ls20-impact-list").innerHTML = sorted.map((feature, index) => {
      const properties = feature.properties || {};
      const delta = number(properties.sim_risk_delta);
      const width = Math.max(4, Math.abs(delta) / maximum * 100);
      const direction = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
      const arrow = delta > 0 ? "↑" : delta < 0 ? "↓" : "–";

      return `
        <li>
          <div class="ls20-rank-row">
            <span class="ls20-rank-number">${index + 1}</span>
            <span class="ls20-rank-name">
              ${escapeHtml(districtName(properties))}
            </span>
            <strong class="${direction}">${arrow} ${signed(delta, 4)}</strong>
          </div>
          <div class="ls20-rank-track">
            <span class="${direction}" style="width:${width}%"></span>
          </div>
        </li>
      `;
    }).join("");
  }

  function updateViewButtons() {
    document.querySelectorAll("[data-view]").forEach(button => {
      button.classList.toggle("active", button.dataset.view === state.view);
    });
  }

  function maximumAbsoluteDelta(features) {
    return Math.max(
      ...features.map(feature =>
        Math.abs(number(feature.properties?.sim_risk_delta))
      ),
      0.001
    );
  }

  function changeColor(delta, maximum) {
    const ratio = delta / maximum;
    if (ratio <= -0.66) return "#2166ac";
    if (ratio <= -0.20) return "#67a9cf";
    if (ratio < 0.20) return "#e2e8f0";
    if (ratio < 0.66) return "#fdae61";
    return "#d73027";
  }

  function renderMap(data, fitBounds) {
    if (!state.map) return;
    if (state.layer) state.map.removeLayer(state.layer);

    const features = data.features || [];
    const maxDelta = maximumAbsoluteDelta(features);

    state.layer = L.geoJSON(data, {
      style: feature => {
        const properties = feature.properties || {};
        const className = state.view === "baseline"
          ? properties.sim_baseline_class
          : properties.sim_risk_class;
        const fillColor = state.view === "change"
          ? changeColor(number(properties.sim_risk_delta), maxDelta)
          : RISK_COLORS[className] || "#94a3b8";
        const changedClass = number(properties.sim_class_shift) !== 0;
        const isImpactLeader = number(properties.sim_impact_rank) === 1 &&
          Math.abs(number(properties.sim_risk_delta)) >= 1e-8;

        return {
          color: isImpactLeader ? "#0f172a" : "#334155",
          weight: isImpactLeader ? 3.2 : changedClass ? 2 : 1.1,
          dashArray: changedClass ? "6 3" : null,
          fillColor,
          fillOpacity: 0.82
        };
      },
      onEachFeature: (feature, layer) => bindFeature(feature, layer)
    }).addTo(state.map);

    if (fitBounds && state.layer.getBounds().isValid()) {
      state.map.fitBounds(state.layer.getBounds(), { padding: [18, 18] });
    }

    renderLegend(data.metadata || {}, maxDelta);
  }

  function bindFeature(feature, layer) {
    const properties = feature.properties || {};
    const name = districtName(properties);
    const delta = number(properties.sim_risk_delta);
    const classShift = number(properties.sim_class_shift);
    const transition = classShift === 0
      ? properties.sim_risk_class
      : `${properties.sim_baseline_class} → ${properties.sim_risk_class}`;

    layer.bindTooltip(escapeHtml(name), {
      sticky: true,
      direction: "top"
    });

    layer.bindPopup(`
      <div class="ls20-popup">
        <div class="ls20-popup-head">
          <strong>${escapeHtml(name)}</strong>
          <span class="${delta > 0 ? "up" : delta < 0 ? "down" : "flat"}">
            ${signed(delta, 4)}
          </span>
        </div>
        <dl>
          <div><dt>Skor baseline</dt><dd>${decimal(properties.sim_baseline_score, 4)}</dd></div>
          <div><dt>Skor skenario</dt><dd>${decimal(properties.sim_risk_score, 4)}</dd></div>
          <div><dt>Perubahan</dt><dd>${signed(properties.sim_change_percent, 1, "%")}</dd></div>
          <div><dt>Kelas</dt><dd>${escapeHtml(transition)}</dd></div>
          <div><dt>Bulan peringatan</dt><dd>${properties.sim_baseline_alert_months} → ${properties.sim_alert_months}</dd></div>
          <div><dt>Peringkat risiko</dt><dd>${properties.sim_rank}</dd></div>
        </dl>
        <p>
          Rerata skenario: CH ${decimal(properties.sim_rainfall_mm, 1)} mm ·
          RH ${decimal(properties.sim_humidity_pct, 1)}% ·
          T ${decimal(properties.sim_temperature_c, 1)}°C
        </p>
      </div>
    `);

    layer.on({
      mouseover: event => {
        event.target.setStyle({ weight: 3.2, color: "#0f172a" });
        event.target.bringToFront();
      },
      mouseout: event => {
        if (state.layer) state.layer.resetStyle(event.target);
      }
    });
  }

  function renderLegend(metadata, maxDelta) {
    if (!state.legend) {
      state.legend = L.control({ position: "bottomright" });
      state.legend.onAdd = () => {
        const element = L.DomUtil.create("div", "ls20-legend");
        element.id = "ls20-legend";
        return element;
      };
      state.legend.addTo(state.map);
    }

    const legend = byId("ls20-legend");
    if (!legend) return;

    if (state.view === "change") {
      legend.innerHTML = `
        <strong>Perubahan skor</strong>
        <div><i style="background:#2166ac"></i> Penurunan terbesar</div>
        <div><i style="background:#67a9cf"></i> Menurun</div>
        <div><i style="background:#e2e8f0"></i> Relatif tetap</div>
        <div><i style="background:#fdae61"></i> Meningkat</div>
        <div><i style="background:#d73027"></i> Kenaikan terbesar</div>
        <small>Rentang ±${decimal(maxDelta, 4)} pada skenario ini</small>
      `;
      return;
    }

    const breaks = metadata.class_breaks || metadata.baseline_breaks || [];
    legend.innerHTML = `
      <strong>${state.view === "baseline" ? "Kelas baseline" : "Kelas skenario"}</strong>
      <div><i style="background:${RISK_COLORS.Rendah}"></i>
        Rendah ≤ ${decimal(breaks[0], 4)}</div>
      <div><i style="background:${RISK_COLORS.Sedang}"></i>
        Sedang ≤ ${decimal(breaks[1], 4)}</div>
      <div><i style="background:${RISK_COLORS.Tinggi}"></i>
        Tinggi ≤ ${decimal(breaks[2], 4)}</div>
      <div><i style="background:${RISK_COLORS["Sangat Tinggi"]}"></i>
        Sangat Tinggi</div>
      <small>Batas berasal dari baseline dan tidak berubah.</small>
    `;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", createUI);
  } else {
    createUI();
  }
})();
