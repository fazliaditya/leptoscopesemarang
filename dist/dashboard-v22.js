(() => {
  "use strict";

  const COLORS = {
    "Rendah": "#2ca25f",
    "Sedang": "#fee08b",
    "Tinggi": "#fdae61",
    "Sangat Tinggi": "#d73027"
  };
  const CLASS_ORDER = ["Rendah", "Sedang", "Tinggi", "Sangat Tinggi"];
  const API = {
    years: "/api/history/years",
    history: year => `/api/history?year=${encodeURIComponent(year)}`,
    realtime: refresh => `/api/realtime?refresh=${refresh ? "true" : "false"}`,
    liveStatus: "/api/live-data/status",
    validateUpload: filename => `/api/live-data/validate?filename=${encodeURIComponent(filename)}`,
    applyUpload: filename => `/api/live-data/apply?filename=${encodeURIComponent(filename)}`,
    facilities: "data/fasilitas_kesehatan.geojson",
    model: "data/model_metadata.json"
  };

  const state = {
    mode: "annual",
    year: 2023,
    month: "2023-12",
    district: "all",
    years: [],
    history: null,
    historyCache: new Map(),
    realtime: null,
    facilities: null,
    modelMetadata: null,
    riskLayer: null,
    boundaryLayer: null,
    facilityLayer: null,
    trendChart: null,
    initialBounds: null,
    requestToken: 0,
    riskVisible: true,
    boundaryVisible: true,
    baseMap: "osm",
    baseLayer: null,
    uploadFile: null,
    uploadValidation: null
  };

  const elements = {
    loading: document.getElementById("loadingState"),
    error: document.getElementById("errorState"),
    yearSelect: document.getElementById("yearSelect"),
    monthSelect: document.getElementById("monthSelect"),
    districtSelect: document.getElementById("districtSelect"),
    refreshRealtime: document.getElementById("refreshRealtimeButton"),
    sourceStatus: document.getElementById("sourceStatus"),
    facilityToggle: document.getElementById("facilityToggle"),
    mapTitle: document.getElementById("mapTitle"),
    mapEyebrow: document.getElementById("mapEyebrow"),
    legend: document.getElementById("mapLegend"),
    hoverCard: document.getElementById("hoverCard"),
    detailPanel: document.getElementById("detailPanel"),
    closeDetail: document.getElementById("closeDetailButton"),
    caseMetric: document.getElementById("caseMetric"),
    caseMetricLabel: document.getElementById("caseMetricLabel"),
    caseMetricNote: document.getElementById("caseMetricNote"),
    alertMetric: document.getElementById("alertMetric"),
    alertMetricNote: document.getElementById("alertMetricNote"),
    districtMetric: document.getElementById("districtMetric"),
    districtMetricNote: document.getElementById("districtMetricNote"),
    topMetric: document.getElementById("topMetric"),
    topMetricNote: document.getElementById("topMetricNote"),
    summaryTitle: document.getElementById("summaryTitle"),
    rankingTitle: document.getElementById("rankingTitle"),
    rankingList: document.getElementById("rankingList"),
    trendTitle: document.getElementById("trendTitle"),
    chartFallback: document.getElementById("chartFallback"),
    dataNoteText: document.getElementById("dataNoteText"),
    resetMap: document.getElementById("resetMapButton"),
    methodButton: document.getElementById("methodButton"),
    methodDialog: document.getElementById("methodDialog"),
    closeMethod: document.getElementById("closeMethodButton"),
    mobilePanelButton: document.getElementById("mobilePanelButton"),
    analysisPanel: document.getElementById("analysisPanel"),
    liveStatusLabel: document.getElementById("liveStatusLabel"),
    layerButton: document.getElementById("layerButton"),
    closeLayerButton: document.getElementById("closeLayerButton"),
    layerDrawer: document.getElementById("layerDrawer"),
    riskToggle: document.getElementById("riskToggle"),
    boundaryToggle: document.getElementById("boundaryToggle"),
    liveUploadCard: document.getElementById("liveUploadCard"),
    liveUploadBadge: document.getElementById("liveUploadBadge"),
    liveUploadSummary: document.getElementById("liveUploadSummary"),
    openUploadButton: document.getElementById("openUploadButton"),
    uploadDialog: document.getElementById("uploadDialog"),
    closeUploadDialog: document.getElementById("closeUploadDialog"),
    caseFileInput: document.getElementById("caseFileInput"),
    caseFileName: document.getElementById("caseFileName"),
    validateUploadButton: document.getElementById("validateUploadButton"),
    applyUploadButton: document.getElementById("applyUploadButton"),
    uploadValidationState: document.getElementById("uploadValidationState"),
    uploadSummaryGrid: document.getElementById("uploadSummaryGrid"),
    uploadIssues: document.getElementById("uploadIssues"),
    uploadPreviewWrap: document.getElementById("uploadPreviewWrap"),
    uploadPreviewBody: document.getElementById("uploadPreviewBody")
  };

  if (typeof L === "undefined") {
    showFatalError("Pustaka peta gagal dimuat.");
    return;
  }

  const map = L.map("map", {
    zoomControl: false,
    preferCanvas: true,
    minZoom: 9,
    maxZoom: 17
  }).setView([-7.005, 110.438], 11);

  const BASEMAPS = {
    osm: {
      url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      options: { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }
    },
    satellite: {
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      options: { maxZoom: 19, attribution: "Tiles &copy; Esri" }
    }
  };
  state.baseLayer = L.tileLayer(BASEMAPS.osm.url, BASEMAPS.osm.options).addTo(map);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.control.scale({ position: "bottomleft", imperial: false }).addTo(map);

  bindInterfaceEvents();
  loadApplicationData();

  async function loadApplicationData() {
    try {
      const yearsPayload = await fetchJSON(API.years);
      state.years = [...(yearsPayload.years || [])].sort((a, b) => b - a);
      state.year = Number(yearsPayload.default_year || state.years[0] || 2023);

      const history = await fetchJSON(API.history(state.year));
      const [realtime, facilities, modelMetadata] = await Promise.all([
        fetchOptionalJSON(API.realtime(false)),
        fetchOptionalJSON(API.facilities),
        fetchOptionalJSON(API.model)
      ]);

      state.history = history;
      state.historyCache.set(state.year, history);
      state.realtime = realtime;
      state.facilities = facilities;
      state.modelMetadata = modelMetadata;
      state.mode = "annual";
      state.month = history.metadata?.available_months?.at(-1) || `${state.year}-12`;

      validatePayloads();
      populatePeriodControls();
      populateDistrictControl();
      createTrendChart();
      createFacilityLayer();
      updateModelMetrics();
      updateControlState();
      renderDashboard(true);
      elements.loading.hidden = true;
    } catch (error) {
      console.error(error);
      showFatalError(error.message || "Data aplikasi tidak dapat dimuat.");
    }
  }

  async function fetchJSON(path) {
    const response = await fetch(path, { cache: "no-store" });
    if (!response.ok) {
      let detail = `${response.status}`;
      try {
        const body = await response.json();
        detail = body.detail || detail;
      } catch (_) {
        detail = await response.text() || detail;
      }
      throw new Error(`Gagal memuat ${path}: ${detail}`);
    }
    return response.json();
  }

  async function fetchOptionalJSON(path) {
    try {
      return await fetchJSON(path);
    } catch (error) {
      console.warn(error);
      return null;
    }
  }

  function validatePayloads() {
    if ((state.history?.annual_geojson?.features || []).length !== 16) {
      throw new Error("Cakupan peta historis tidak lengkap (harus 16 kecamatan). ");
    }
    if (state.realtime && (state.realtime?.features || []).length !== 16) {
      console.warn("Cakupan pemantauan eksperimental tidak lengkap; evaluasi historis tetap tersedia.");
      state.realtime = null;
    }
  }

  function populatePeriodControls() {
    elements.yearSelect.innerHTML = state.years
      .map(year => `<option value="${year}">${year}</option>`)
      .join("");
    elements.yearSelect.value = String(state.year);
    populateMonthControl();
  }

  function populateMonthControl() {
    const months = state.history?.metadata?.available_months || [];
    if (!months.includes(state.month)) state.month = months.at(-1) || "";
    elements.monthSelect.innerHTML = months
      .map(month => `<option value="${month}">${monthLabel(month)}</option>`)
      .join("");
    elements.monthSelect.value = state.month;
  }

  function populateDistrictControl() {
    const features = state.realtime?.features || state.history?.annual_geojson?.features || [];
    const districts = features
      .map(feature => ({
        code: String(feature.properties.kecamatan_code),
        name: feature.properties.kecamatan_name
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "id"));
    elements.districtSelect.innerHTML = [
      '<option value="all">Semua kecamatan</option>',
      ...districts.map(item => `<option value="${escapeHTML(item.code)}">${escapeHTML(item.name)}</option>`)
    ].join("");
  }

  function bindInterfaceEvents() {
    document.querySelectorAll(".segment-button").forEach(button => {
      button.addEventListener("click", async () => {
        const nextMode = button.dataset.mode;
        if (!nextMode || nextMode === state.mode) return;
        if (nextMode === "realtime" && !state.realtime) {
          await refreshRealtime(false);
          if (!state.realtime) {
            showTransientError("Pemantauan eksperimental belum tersedia. Evaluasi historis tetap dapat digunakan.");
            return;
          }
        }
        state.mode = nextMode;
        setActiveModeButton();
        updateControlState();
        closeDistrictDetail();
        if (state.mode !== "realtime") await ensureHistory(state.year);
        renderDashboard(false);
      });
    });

    elements.yearSelect.addEventListener("change", async event => {
      state.year = Number(event.target.value);
      await ensureHistory(state.year);
      state.month = state.history.metadata?.available_months?.at(-1) || `${state.year}-12`;
      populateMonthControl();
      closeDistrictDetail();
      renderDashboard(false);
    });

    elements.monthSelect.addEventListener("change", event => {
      state.month = event.target.value;
      closeDistrictDetail();
      renderDashboard(false);
    });

    elements.refreshRealtime.addEventListener("click", async () => {
      await refreshRealtime(true);
    });

    elements.districtSelect.addEventListener("change", event => {
      state.district = event.target.value;
      closeDistrictDetail();
      renderRiskLayer(false);
      updateTrendChart();
      focusSelectedDistrict();
    });

    elements.facilityToggle.addEventListener("change", event => {
      if (!state.facilityLayer) return;
      if (event.target.checked) state.facilityLayer.addTo(map);
      else map.removeLayer(state.facilityLayer);
    });

    elements.riskToggle?.addEventListener("change", event => {
      state.riskVisible = event.target.checked;
      if (!state.riskLayer) return;
      if (state.riskVisible && !map.hasLayer(state.riskLayer)) state.riskLayer.addTo(map);
      if (!state.riskVisible && map.hasLayer(state.riskLayer)) map.removeLayer(state.riskLayer);
    });

    elements.boundaryToggle?.addEventListener("change", event => {
      state.boundaryVisible = event.target.checked;
      if (!state.boundaryLayer) return;
      if (state.boundaryVisible && !map.hasLayer(state.boundaryLayer)) state.boundaryLayer.addTo(map);
      if (!state.boundaryVisible && map.hasLayer(state.boundaryLayer)) map.removeLayer(state.boundaryLayer);
    });

    elements.layerButton?.addEventListener("click", () => {
      const open = elements.layerDrawer?.hasAttribute("hidden");
      if (open) {
        elements.layerDrawer.removeAttribute("hidden");
        document.body.classList.add("layer-open");
      } else {
        elements.layerDrawer?.setAttribute("hidden", "");
        document.body.classList.remove("layer-open");
      }
      elements.layerButton?.setAttribute("aria-expanded", String(open));
    });
    elements.closeLayerButton?.addEventListener("click", () => {
      elements.layerDrawer?.setAttribute("hidden", "");
      document.body.classList.remove("layer-open");
      elements.layerButton?.setAttribute("aria-expanded", "false");
    });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && elements.layerDrawer && !elements.layerDrawer.hasAttribute("hidden")) {
        elements.layerDrawer.setAttribute("hidden", "");
        document.body.classList.remove("layer-open");
        elements.layerButton?.setAttribute("aria-expanded", "false");
      }
    });
    document.querySelectorAll(".basemap-btn").forEach(button => {
      button.addEventListener("click", () => {
        const key = button.dataset.basemap;
        const config = BASEMAPS[key];
        if (!config || key === state.baseMap) return;
        if (state.baseLayer) map.removeLayer(state.baseLayer);
        state.baseLayer = L.tileLayer(config.url, config.options).addTo(map);
        state.baseLayer.bringToBack();
        state.baseMap = key;
        document.querySelectorAll(".basemap-btn").forEach(item => item.classList.toggle("active", item === button));
      });
    });

    elements.openUploadButton?.addEventListener("click", () => {
      resetUploadDialog(false);
      if (typeof elements.uploadDialog?.showModal === "function") elements.uploadDialog.showModal();
      else elements.uploadDialog?.setAttribute("open", "");
    });
    elements.closeUploadDialog?.addEventListener("click", () => elements.uploadDialog?.close());
    elements.uploadDialog?.addEventListener("click", event => {
      if (event.target === elements.uploadDialog) elements.uploadDialog.close();
    });
    elements.caseFileInput?.addEventListener("change", async event => {
      state.uploadFile = event.target.files?.[0] || null;
      state.uploadValidation = null;
      elements.caseFileName.textContent = state.uploadFile ? state.uploadFile.name : "Belum ada file dipilih";
      elements.validateUploadButton.disabled = !state.uploadFile;
      elements.applyUploadButton.disabled = true;
      clearUploadResults();
      if (state.uploadFile) await validateSelectedUpload();
    });
    elements.validateUploadButton?.addEventListener("click", validateSelectedUpload);
    elements.applyUploadButton?.addEventListener("click", applySelectedUpload);

    elements.resetMap.addEventListener("click", () => {
      state.district = "all";
      elements.districtSelect.value = "all";
      renderRiskLayer(false);
      updateTrendChart();
      closeDistrictDetail();
      if (state.initialBounds) map.fitBounds(state.initialBounds, { padding: [22, 22] });
    });

    elements.rankingList.addEventListener("click", event => {
      const item = event.target.closest("[data-district-code]");
      if (!item) return;
      state.district = item.dataset.districtCode;
      elements.districtSelect.value = state.district;
      renderRiskLayer(false);
      updateTrendChart();
      focusSelectedDistrict();
      if (window.innerWidth <= 860) toggleMobilePanel(false);
    });

    elements.closeDetail.addEventListener("click", closeDistrictDetail);
    map.on("click", event => {
      if (event.originalEvent?.target?.closest?.(".leaflet-interactive")) return;
      closeDistrictDetail();
    });

    elements.methodButton.addEventListener("click", () => {
      if (typeof elements.methodDialog.showModal === "function") elements.methodDialog.showModal();
      else elements.methodDialog.setAttribute("open", "");
    });
    elements.closeMethod.addEventListener("click", () => elements.methodDialog.close());
    elements.methodDialog.addEventListener("click", event => {
      if (event.target === elements.methodDialog) elements.methodDialog.close();
    });

    elements.mobilePanelButton.addEventListener("click", () => {
      toggleMobilePanel(!elements.analysisPanel.classList.contains("open"));
    });
    window.addEventListener("resize", () => {
      if (window.innerWidth > 860) toggleMobilePanel(false);
      window.setTimeout(() => map.invalidateSize(), 120);
    });
  }

  async function ensureHistory(year) {
    if (state.historyCache.has(year)) {
      state.history = state.historyCache.get(year);
      populateMonthControl();
      return;
    }
    const token = ++state.requestToken;
    setBusy(true, `Memuat seri waktu ${year}…`);
    try {
      const payload = await fetchJSON(API.history(year));
      if (token !== state.requestToken) return;
      state.historyCache.set(year, payload);
      state.history = payload;
      populateMonthControl();
    } catch (error) {
      console.error(error);
      showTransientError(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function refreshRealtime(forceRefresh) {
    elements.refreshRealtime.disabled = true;
    elements.refreshRealtime.classList.add("is-loading");
    elements.refreshRealtime.textContent = "Memperbarui…";
    try {
      state.realtime = await fetchJSON(API.realtime(forceRefresh));
      if (state.mode === "realtime") renderDashboard(false);
    } catch (error) {
      console.error(error);
      showTransientError(error.message);
    } finally {
      elements.refreshRealtime.disabled = false;
      elements.refreshRealtime.classList.remove("is-loading");
      elements.refreshRealtime.textContent = "Perbarui data terkini";
    }
  }

  function setActiveModeButton() {
    document.querySelectorAll(".segment-button").forEach(button => {
      const active = button.dataset.mode === state.mode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  }

  function updateControlState() {
    const realtime = state.mode === "realtime";
    elements.yearSelect.disabled = realtime;
    elements.monthSelect.disabled = state.mode !== "monthly";
    elements.refreshRealtime.hidden = !realtime;
    if (elements.liveUploadCard) elements.liveUploadCard.hidden = !realtime;
    document.getElementById("yearField")?.classList.toggle("is-disabled", realtime);
    document.getElementById("monthField")?.classList.toggle("is-disabled", state.mode !== "monthly");
  }

  function renderDashboard(fitToData) {
    updateHeadings();
    updateMetrics();
    updateRanking();
    updateLegend();
    updateSourceStatus();
    updateUploadCard();
    updateTrendChart();
    renderRiskLayer(fitToData);
  }

  function renderRiskLayer(fitToData) {
    const displayData = createDisplayGeoJSON();
    if (!displayData) return;
    if (state.riskLayer) map.removeLayer(state.riskLayer);
    if (state.boundaryLayer) map.removeLayer(state.boundaryLayer);
    state.riskLayer = L.geoJSON(displayData, {
      style: featureStyle,
      onEachFeature: bindFeatureInteractions
    });
    state.boundaryLayer = L.geoJSON(displayData, {
      interactive: false,
      style: { color: "#21474f", weight: 1.35, opacity: 0.9, fillOpacity: 0 }
    });
    if (state.riskVisible) state.riskLayer.addTo(map);
    if (state.boundaryVisible) state.boundaryLayer.addTo(map);
    if (!state.initialBounds) state.initialBounds = state.riskLayer.getBounds();
    if (fitToData && state.initialBounds?.isValid()) {
      map.fitBounds(state.initialBounds, { padding: [22, 22] });
    }
  }

  function createDisplayGeoJSON() {
    if (state.mode === "realtime") return state.realtime;
    const annual = state.history?.annual_geojson;
    if (!annual || state.mode === "annual") return annual;
    const monthlyByCode = new Map(
      selectedMonthRecords().map(record => [String(record.kecamatan_code), record])
    );
    return {
      type: "FeatureCollection",
      features: annual.features.map(feature => ({
        type: "Feature",
        geometry: feature.geometry,
        properties: {
          ...feature.properties,
          ...(monthlyByCode.get(String(feature.properties.kecamatan_code)) || {})
        }
      }))
    };
  }

  function featureStyle(feature) {
    const properties = feature.properties || {};
    const riskClass = getRiskClass(properties);
    const selected = state.district === "all" || String(properties.kecamatan_code) === state.district;
    return {
      color: selected ? "#17343b" : "#7d9296",
      weight: String(properties.kecamatan_code) === state.district ? 3 : 1.15,
      opacity: selected ? 1 : 0.45,
      fillColor: COLORS[riskClass] || "#9aabad",
      fillOpacity: selected ? 0.78 : 0.18
    };
  }

  function bindFeatureInteractions(feature, layer) {
    const properties = feature.properties || {};
    layer.bindTooltip(properties.kecamatan_name || "Kecamatan", { sticky: true, direction: "top" });
    layer.on({
      mouseover: event => {
        event.target.setStyle({ weight: 3, color: "#08232b", fillOpacity: 0.9 });
        event.target.bringToFront();
        updateHoverCard(properties);
      },
      mouseout: event => {
        state.riskLayer?.resetStyle(event.target);
        resetHoverCard();
      },
      click: event => {
        L.DomEvent.stopPropagation(event);
        openDistrictDetail(properties);
      }
    });
  }

  function getRiskClass(properties) {
    if (state.mode === "realtime") return properties.rt_risk_class || "Rendah";
    if (state.mode === "annual") return properties.history_priority_class || "Rendah";
    return properties.relative_score_class || "Rendah";
  }

  function getScore(properties) {
    if (state.mode === "realtime") return Number(properties.rt_risk_score || 0);
    if (state.mode === "annual") return Number(properties.history_mean_score || 0);
    return Number(properties.model_score || 0);
  }

  function updateHoverCard(properties) {
    const riskClass = getRiskClass(properties);
    const score = getScore(properties);
    let value = `Skor ${formatDecimal(score, 3)}`;
    if (state.mode === "realtime") value += properties.rt_alert ? " · Peringatan" : " · Dipantau";
    if (state.mode === "monthly") value += properties.prediction ? " · Peringatan" : " · Tanpa peringatan";
    elements.hoverCard.innerHTML = `
      <span>${escapeHTML(riskClass)} · ${escapeHTML(value)}</span>
      <strong>${escapeHTML(properties.kecamatan_name)}</strong>
    `;
  }

  function resetHoverCard() {
    elements.hoverCard.innerHTML = `
      <span>Arahkan kursor pada kecamatan</span>
      <strong>Ringkasan wilayah akan tampil di sini</strong>
    `;
  }

  function openDistrictDetail(properties) {
    const riskClass = getRiskClass(properties);
    const riskColor = COLORS[riskClass] || "#547176";
    let content;
    if (state.mode === "realtime") content = realtimeDetailHTML(properties, riskClass, riskColor);
    else if (state.mode === "annual") content = annualDetailHTML(properties, riskClass, riskColor);
    else content = monthlyDetailHTML(properties, riskClass, riskColor);
    elements.detailPanel.innerHTML = content;
    elements.detailPanel.hidden = false;
    elements.closeDetail.hidden = false;
    elements.legend.style.opacity = "0";
  }

  function realtimeDetailHTML(properties, riskClass, riskColor) {
    const metadata = state.realtime?.metadata || {};
    return `
      <div class="detail-header">
        <p class="eyebrow">Pemantauan eksperimental</p>
        <h3>${escapeHTML(properties.kecamatan_name)}</h3>
        <p>Target peringatan ${escapeHTML(dateMonthLabel(metadata.prediction_target))} · peringkat ${formatInteger(properties.rt_rank)}/16</p>
      </div>
      <div class="detail-risk" style="--risk-color:${riskColor}">
        <span>Kelas skor relatif</span><strong>${escapeHTML(riskClass)}</strong>
      </div>
      <div class="detail-grid">
        ${detailStat("Skor prediksi", formatDecimal(properties.rt_risk_score, 4))}
        ${detailStat("Perubahan skor", formatSigned(properties.rt_risk_delta, 4))}
        ${detailStat("Suhu saat ini", properties.rt_current_temperature_c == null ? "Belum tersedia" : `${formatDecimal(properties.rt_current_temperature_c, 1)} °C`)}
        ${detailStat("Kelembapan saat ini", properties.rt_current_humidity_pct == null ? "Belum tersedia" : `${formatDecimal(properties.rt_current_humidity_pct, 1)}%`)}
        ${detailStat("Presipitasi saat ini", properties.rt_current_precipitation_mm == null ? "Belum tersedia" : `${formatDecimal(properties.rt_current_precipitation_mm, 2)} mm`)}
        ${detailStat("Angin saat ini", properties.rt_current_wind_speed_kmh == null ? "Belum tersedia" : `${formatDecimal(properties.rt_current_wind_speed_kmh, 1)} km/jam`)}
        ${detailStat(`Hujan ${monthLabel(metadata.model_input_period)}`, `${formatDecimal(properties.rt_rainfall_30d_mm, 1)} mm`)}
        ${detailStat(`Kelembapan ${monthLabel(metadata.model_input_period)}`, `${formatDecimal(properties.rt_humidity_30d_pct, 1)}%`)}
        ${detailStat(`Suhu ${monthLabel(metadata.model_input_period)}`, `${formatDecimal(properties.rt_temperature_30d_c, 1)} °C`)}
        ${detailStat(`Kasus input ${monthLabel(metadata.model_input_period)}`, properties.rt_case_count == null ? "Fallback historis" : formatInteger(properties.rt_case_count))}
        ${detailStat(`Kasus sementara ${monthLabel(metadata.monitoring_period)}`, properties.rt_current_month_case_count == null ? "Belum dilaporkan" : formatInteger(properties.rt_current_month_case_count))}
        ${detailStat("Penduduk resmi 2025", formatInteger(properties.rt_population_2025_bps))}
        ${detailStat("Estimasi penduduk 2026", formatInteger(properties.rt_population_2026_estimate))}
        ${detailStat("Kepadatan resmi 2025", `${formatDecimal(properties.rt_density_2025_bps, 0)}/km²`)}
        ${detailStat("Estimasi kepadatan 2026", `${formatDecimal(properties.rt_density_2026_estimate, 0)}/km²`)}
      </div>
      <p class="detail-message">Cuaca saat ini berasal dari Open-Meteo pada titik centroid kecamatan dan ditampilkan sebagai konteks monitoring. Fitur model tetap memakai agregat bulan kalender lengkap sebelumnya. Penduduk 2025 bersumber dari BPS; nilai 2026 merupakan estimasi.</p>
    `;
  }

  function annualDetailHTML(properties, riskClass, riskColor) {
    return `
      <div class="detail-header">
        <p class="eyebrow">Ringkasan tahunan ${state.year}</p>
        <h3>${escapeHTML(properties.kecamatan_name)}</h3>
        <p>Peringkat prioritas ${formatInteger(properties.history_rank)} dari 16 kecamatan</p>
      </div>
      <div class="detail-risk" style="--risk-color:${riskColor}">
        <span>Prioritas relatif</span><strong>${escapeHTML(riskClass)}</strong>
      </div>
      <div class="detail-grid">
        ${detailStat("Skor rata-rata", formatDecimal(properties.history_mean_score, 3))}
        ${detailStat("Skor maksimum", formatDecimal(properties.history_max_score, 3))}
        ${detailStat("Kasus tercatat", formatInteger(properties.history_cases))}
        ${detailStat("Bulan peringatan", formatInteger(properties.history_alert_months))}
        ${detailStat("Peringatan tepat", formatInteger(properties.history_correct_alerts))}
        ${detailStat("Kasus terlewat", formatInteger(properties.history_missed_cases))}
        ${detailStat("Estimasi penduduk", formatInteger(properties.population_estimate))}
        ${detailStat("Insidensi/100 ribu", formatDecimal(properties.history_incidence_per_100k, 2))}
      </div>
      <p class="detail-message">Kelas prioritas dihitung relatif berdasarkan kuartil skor antarkecamatan pada tahun yang dipilih.</p>
    `;
  }

  function monthlyDetailHTML(properties, riskClass, riskColor) {
    const observed = Number(properties.target_occurrence_next_month) === 1;
    const alerted = Number(properties.prediction) === 1;
    let message = "Tidak ada peringatan maupun kasus tercatat pada bulan target.";
    if (alerted && observed) message = "Peringatan model sesuai dengan kemunculan kasus surveilans.";
    if (alerted && !observed) message = "Model memberi peringatan, tetapi tidak ada kasus tercatat.";
    if (!alerted && observed) message = "Kasus tercatat muncul tanpa didahului peringatan model.";
    return `
      <div class="detail-header">
        <p class="eyebrow">Target ${escapeHTML(monthLabel(properties.target_month))}</p>
        <h3>${escapeHTML(properties.kecamatan_name)}</h3>
        <p>Peringkat skor ${formatInteger(properties.month_rank)} dari 16 kecamatan</p>
      </div>
      <div class="detail-risk" style="--risk-color:${riskColor}">
        <span>Kelas skor relatif</span><strong>${escapeHTML(riskClass)}</strong>
      </div>
      <div class="detail-grid">
        ${detailStat("Model score", formatDecimal(properties.model_score, 3))}
        ${detailStat("Threshold", formatDecimal(properties.threshold, 3))}
        ${detailStat("Status model", alerted ? "Peringatan" : "Tidak ada")}
        ${detailStat("Kasus tercatat", formatInteger(properties.target_case_next_month))}
        ${detailStat("Curah hujan", `${formatDecimal(properties.rainfall_mm, 1)} mm`)}
        ${detailStat("Kelembapan", `${formatDecimal(properties.humidity_pct, 1)}%`)}
      </div>
      <p class="detail-message">${escapeHTML(message)}</p>
    `;
  }

  function detailStat(label, value) {
    return `<div class="detail-stat"><span>${escapeHTML(label)}</span><strong>${escapeHTML(String(value))}</strong></div>`;
  }

  function closeDistrictDetail() {
    elements.detailPanel.hidden = true;
    elements.closeDetail.hidden = true;
    elements.legend.style.opacity = "1";
  }

  function focusSelectedDistrict() {
    if (state.district === "all") {
      if (state.initialBounds) map.fitBounds(state.initialBounds, { padding: [22, 22] });
      return;
    }
    state.riskLayer?.eachLayer(layer => {
      if (String(layer.feature.properties.kecamatan_code) === state.district) {
        map.fitBounds(layer.getBounds(), { padding: [55, 55], maxZoom: 13 });
        openDistrictDetail(layer.feature.properties);
      }
    });
  }

  function updateHeadings() {
    if (state.mode === "realtime") {
      const meta = state.realtime?.metadata || {};
      elements.mapEyebrow.textContent = "Pemantauan kasus, cuaca terkini & peringatan bulanan";
      elements.mapTitle.textContent = `Monitoring kasus ${monthLabel(meta.monitoring_period)} & peringatan risiko ${dateMonthLabel(meta.prediction_target)}`;
      elements.summaryTitle.textContent = `Monitoring ${monthLabel(meta.monitoring_period)}`;
      elements.rankingTitle.textContent = `Prioritas ${dateMonthLabel(meta.prediction_target)}`;
      elements.trendTitle.textContent = `Konteks kasus historis ${state.year}`;
      elements.dataNoteText.textContent = `Prediksi ${dateMonthLabel(meta.prediction_target)} menggunakan bulan kalender lengkap sebelumnya (${monthLabel(meta.model_input_period)}). Skor adalah peringatan relatif, bukan diagnosis klinis.`;
      if (elements.liveStatusLabel) elements.liveStatusLabel.textContent = "Terkini";
    } else if (state.mode === "annual") {
      elements.mapEyebrow.textContent = "Peta seri tahunan";
      elements.mapTitle.textContent = `Risiko relatif leptospirosis ${state.year}`;
      elements.summaryTitle.textContent = `Kondisi ${state.year}`;
      elements.rankingTitle.textContent = `Prioritas kecamatan ${state.year}`;
      elements.trendTitle.textContent = `Kasus dan peringatan bulanan ${state.year}`;
      elements.dataNoteText.textContent = `Evaluasi historis ${state.year}. Kelas warna bersifat relatif antarkecamatan dan bukan probabilitas klinis.`;
      if (elements.liveStatusLabel) elements.liveStatusLabel.textContent = "Historis";
    } else {
      const label = monthLabel(state.month);
      elements.mapEyebrow.textContent = "Peta seri bulanan";
      elements.mapTitle.textContent = `Risiko relatif · ${label}`;
      elements.summaryTitle.textContent = label;
      elements.rankingTitle.textContent = `Skor tertinggi · ${label}`;
      elements.trendTitle.textContent = `Kasus dan peringatan bulanan ${state.year}`;
      elements.dataNoteText.textContent = `Evaluasi historis bulanan ${label}. Prediksi dibuat dari kondisi bulan sebelumnya.`;
      if (elements.liveStatusLabel) elements.liveStatusLabel.textContent = "Historis";
    }
  }

  function updateMetrics() {
    if (state.mode === "realtime") {
      const features = (state.realtime?.features || []).map(feature => feature.properties);
      const meta = state.realtime?.metadata || {};
      const top = [...features].sort((a, b) => Number(b.rt_risk_score) - Number(a.rt_risk_score))[0] || {};
      if (elements.caseMetricLabel) elements.caseMetricLabel.textContent = `Kasus sementara ${monthLabel(meta.monitoring_period)}`;
      if ((meta.monitoring_districts_reported || 0) > 0) setMetric(elements.caseMetric, meta.monitoring_case_total || 0);
      else elements.caseMetric.textContent = "—";
      setMetric(elements.alertMetric, meta.alert_districts || 0);
      setMetric(elements.districtMetric, meta.matched_districts || features.length);
      elements.topMetric.textContent = top.kecamatan_name || "—";
      elements.caseMetricNote.textContent = (meta.monitoring_districts_reported || 0) > 0 ? `${meta.monitoring_districts_reported}/16 kecamatan melapor` : "belum ada data bulan berjalan";
      elements.alertMetricNote.textContent = "kecamatan melewati threshold";
      elements.districtMetricNote.textContent = "kecamatan tercakup";
      elements.topMetricNote.textContent = `skor ${formatDecimal(top.rt_risk_score, 4)}`;
      return;
    }

    if (state.mode === "annual") {
      const features = (state.history?.annual_geojson?.features || []).map(feature => feature.properties);
      const meta = state.history?.metadata || {};
      const top = [...features].sort((a, b) => Number(b.history_mean_score) - Number(a.history_mean_score))[0] || {};
      if (elements.caseMetricLabel) elements.caseMetricLabel.textContent = "Kasus tercatat";
      setMetric(elements.caseMetric, meta.total_cases || 0);
      setMetric(elements.alertMetric, meta.total_alert_months || 0);
      setMetric(elements.districtMetric, meta.districts_with_cases || 0);
      elements.topMetric.textContent = top.kecamatan_name || "—";
      elements.caseMetricNote.textContent = "kasus surveilans";
      elements.alertMetricNote.textContent = "kecamatan-bulan";
      elements.districtMetricNote.textContent = "kecamatan dengan kasus";
      elements.topMetricNote.textContent = `skor ${formatDecimal(top.history_mean_score, 3)}`;
      return;
    }

    if (elements.caseMetricLabel) elements.caseMetricLabel.textContent = "Kasus tercatat";
    const records = selectedMonthRecords();
    const top = [...records].sort((a, b) => Number(b.model_score) - Number(a.model_score))[0] || {};
    setMetric(elements.caseMetric, sum(records, "target_case_next_month"));
    setMetric(elements.alertMetric, sum(records, "prediction"));
    setMetric(elements.districtMetric, records.filter(item => Number(item.target_occurrence_next_month) === 1).length);
    elements.topMetric.textContent = top.kecamatan_name || "—";
    elements.caseMetricNote.textContent = "kasus pada bulan target";
    elements.alertMetricNote.textContent = "kecamatan diperingatkan";
    elements.districtMetricNote.textContent = "kecamatan dengan kasus";
    elements.topMetricNote.textContent = `skor ${formatDecimal(top.model_score, 3)}`;
  }

  function setMetric(element, value) {
    element.textContent = formatInteger(value);
  }

  function updateRanking() {
    let items;
    if (state.mode === "realtime") items = (state.realtime?.features || []).map(feature => feature.properties).sort((a, b) => Number(b.rt_risk_score) - Number(a.rt_risk_score));
    else if (state.mode === "annual") items = (state.history?.annual_geojson?.features || []).map(feature => feature.properties).sort((a, b) => Number(b.history_mean_score) - Number(a.history_mean_score));
    else items = selectedMonthRecords().sort((a, b) => Number(b.model_score) - Number(a.model_score));

    elements.rankingList.innerHTML = items.slice(0, 8).map((item, index) => {
      const riskClass = getRiskClass(item);
      const score = getScore(item);
      return `
        <li><button class="ranking-item" type="button" data-district-code="${escapeHTML(String(item.kecamatan_code))}">
          <span class="ranking-number">${index + 1}</span>
          <span class="ranking-name"><strong>${escapeHTML(item.kecamatan_name)}</strong><span>Skor ${formatDecimal(score, state.mode === "realtime" ? 4 : 3)}</span></span>
          <span class="risk-pill" style="--pill-color:${COLORS[riskClass]}">${escapeHTML(riskClass)}</span>
        </button></li>
      `;
    }).join("");
  }

  function updateLegend() {
    elements.legend.innerHTML = `
      <h4>${state.mode === "annual" ? "Prioritas relatif" : "Kelas skor relatif"}</h4>
      ${CLASS_ORDER.map(item => `<div class="legend-item"><span class="legend-swatch" style="background:${COLORS[item]}"></span><span>${item}</span></div>`).join("")}
    `;
  }

  function updateSourceStatus() {
    if (!elements.sourceStatus) return;
    if (state.mode === "realtime") {
      const meta = state.realtime?.metadata || {};
      const weatherOk = ["live", "cache_fresh"].includes(meta.weather_status);
      const casesOk = meta.case_status === "operator_current";
      const currentWeatherReady = meta.current_temperature_c != null || meta.current_humidity_pct != null;
      const modelWeather = weatherOk
        ? `${formatDecimal(meta.model_weather_rainfall_mm, 1)} mm hujan · RH ${formatDecimal(meta.model_weather_humidity_pct, 1)}% · ${formatDecimal(meta.model_weather_temperature_c, 1)} °C`
        : "Data cuaca model belum mutakhir";
      const currentWeatherGrid = currentWeatherReady ? `
        <div class="live-weather-title"><span>Cuaca terkini</span><small>rerata 16 titik kecamatan</small></div>
        <div class="live-weather-grid">
          <div><span>Suhu</span><strong>${formatDecimal(meta.current_temperature_c, 1)} °C</strong></div>
          <div><span>Kelembapan</span><strong>${formatDecimal(meta.current_humidity_pct, 0)}%</strong></div>
          <div><span>Presipitasi</span><strong>${formatDecimal(meta.current_precipitation_mm, 2)} mm</strong></div>
          <div><span>Angin</span><strong>${formatDecimal(meta.current_wind_speed_kmh, 1)} km/jam</strong></div>
        </div>
      ` : `<div class="live-weather-unavailable">Cuaca terkini belum tersedia. Klik <strong>Perbarui data pemantauan</strong> ketika internet aktif.</div>`;
      elements.sourceStatus.innerHTML = `
        <div class="source-status-head"><span class="source-dot ${weatherOk ? "ok" : "warn"}"></span><strong>${escapeHTML(meta.readiness || "Status sumber data")}</strong></div>
        ${currentWeatherGrid}
        ${sourceRow("Observasi cuaca", currentWeatherReady ? formatDateTime(meta.current_weather_time) : "—")}
        ${sourceRow(`Cuaca model ${monthLabel(meta.model_input_period)}`, modelWeather)}
       
${sourceRow("Data kasus model",
  casesOk
    ? `Data terkini · ${monthLabel(meta.model_input_period)}`
    : `Data belum lengkap · ${meta.case_valid_slots || 0} dari ${meta.case_required_slots || 64} entri`
)}

        ${sourceRow("Kasus berjalan", (meta.monitoring_districts_reported || 0) > 0 ? `${monthLabel(meta.monitoring_period)} · ${meta.monitoring_districts_reported}/16 kecamatan · ${formatInteger(meta.monitoring_case_total)} kasus sementara` : `${monthLabel(meta.monitoring_period)} · belum ada laporan`)}
        ${sourceRow("Target peringatan", dateMonthLabel(meta.prediction_target))}
        ${sourceRow("Penduduk", "BPS 2025 · estimasi 2026")}
        <small>Cuaca: Open-Meteo · nilai saat ini = rerata centroid kecamatan. Sistem diperbarui ${formatDateTime(meta.monitoring_updated_at || meta.generated_at)}.</small>
      `;
    } else {
      const meta = state.history?.metadata || {};
      elements.sourceStatus.innerHTML = `
        <div class="source-status-head"><span class="source-dot ok"></span><strong>Seri historis ${state.year}</strong></div>
        ${sourceRow("Cakupan", meta.complete_year ? "Januari–Desember" : "Mei–Desember")}
        ${sourceRow("Wilayah", `${meta.matched_districts || 16} kecamatan`)}
        ${sourceRow("Status", "evaluasi historis")}
      `;
    }
  }

  function sourceRow(label, value) {
    return `<div class="source-row"><span>${escapeHTML(label)}</span><strong>${escapeHTML(value)}</strong></div>`;
  }

  function updateUploadCard() {
    if (!elements.liveUploadCard || state.mode !== "realtime") return;
    const meta = state.realtime?.metadata || {};
    const reported = Number(meta.monitoring_districts_reported || 0);
    const modelReady = meta.case_status === "operator_current";
    elements.liveUploadBadge.textContent = modelReady ? "Input model lengkap" : reported > 0 ? "Monitoring aktif" : "Belum ada data";
    elements.liveUploadBadge.className = `live-upload-badge ${modelReady ? "is-ready" : reported > 0 ? "is-partial" : ""}`;
    elements.liveUploadSummary.textContent = reported > 0
      ? `${monthLabel(meta.monitoring_period)}: ${formatInteger(meta.monitoring_case_total)} kasus dari ${reported}/16 kecamatan. Input model ${modelReady ? "lengkap" : `belum lengkap (${meta.case_valid_slots || 0}/${meta.case_required_slots || 64} slot)`}.`
      : `Belum ada data kasus bulan berjalan ${monthLabel(meta.monitoring_period)}. Input model ${modelReady ? "sudah lengkap" : "masih memakai fallback historis"}.`;
  }

  function resetUploadDialog(clearFile = true) {
    if (clearFile && elements.caseFileInput) elements.caseFileInput.value = "";
    if (clearFile) state.uploadFile = null;
    state.uploadValidation = null;
    if (elements.caseFileName) elements.caseFileName.textContent = state.uploadFile?.name || "Belum ada file dipilih";
    if (elements.validateUploadButton) elements.validateUploadButton.disabled = !state.uploadFile;
    if (elements.applyUploadButton) elements.applyUploadButton.disabled = true;
    clearUploadResults();
  }

  function clearUploadResults() {
    if (elements.uploadValidationState) { elements.uploadValidationState.hidden = true; elements.uploadValidationState.innerHTML = ""; }
    if (elements.uploadSummaryGrid) { elements.uploadSummaryGrid.hidden = true; elements.uploadSummaryGrid.innerHTML = ""; }
    if (elements.uploadIssues) { elements.uploadIssues.hidden = true; elements.uploadIssues.innerHTML = ""; }
    if (elements.uploadPreviewWrap) elements.uploadPreviewWrap.hidden = true;
    if (elements.uploadPreviewBody) elements.uploadPreviewBody.innerHTML = "";
  }

  async function postRawFile(path, file) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
      cache: "no-store"
    });
    let body = null;
    try { body = await response.json(); } catch (_) { body = { detail: await response.text() }; }
    if (!response.ok) throw new Error(body?.detail || `HTTP ${response.status}`);
    return body;
  }

  async function validateSelectedUpload() {
    const file = state.uploadFile;
    if (!file) return;
    elements.validateUploadButton.disabled = true;
    elements.validateUploadButton.textContent = "Memvalidasi…";
    elements.applyUploadButton.disabled = true;
    clearUploadResults();
    try {
      const result = await postRawFile(API.validateUpload(file.name), file);
      state.uploadValidation = result;
      renderUploadValidation(result);
      elements.applyUploadButton.disabled = !result.can_apply;
    } catch (error) {
      elements.uploadValidationState.hidden = false;
      elements.uploadValidationState.className = "upload-validation-state is-error";
      elements.uploadValidationState.innerHTML = `<strong>File belum dapat divalidasi</strong><span>${escapeHTML(error.message)}</span>`;
    } finally {
      elements.validateUploadButton.disabled = false;
      elements.validateUploadButton.textContent = "Validasi file";
    }
  }

  function renderUploadValidation(result) {
    const summary = result.summary || {};
    elements.uploadValidationState.hidden = false;
    elements.uploadValidationState.className = `upload-validation-state ${result.can_apply ? "is-ok" : "is-error"}`;
    elements.uploadValidationState.innerHTML = result.can_apply
      ? `<strong>File valid dan dapat diterapkan</strong><span>${formatInteger(result.uploaded_valid_rows)} nilai kasus akan memperbarui data aktif.</span>`
      : `<strong>File belum dapat diterapkan</strong><span>Perbaiki masalah yang ditandai lalu validasi ulang.</span>`;

    elements.uploadSummaryGrid.hidden = false;
    elements.uploadSummaryGrid.innerHTML = `
      <div><span>Input model</span><strong>${summary.model_valid_slots || 0}/${summary.model_required_slots || 64}</strong><small>${summary.model_ready ? "Lengkap" : "Belum lengkap"}</small></div>
      <div><span>Monitoring ${escapeHTML(summary.monitoring_period_label || "")}</span><strong>${summary.monitoring_districts_reported || 0}/16</strong><small>${formatInteger(summary.monitoring_total_cases || 0)} kasus</small></div>
      <div><span>Target model</span><strong>${escapeHTML(summary.prediction_target_label || "—")}</strong><small>rolling otomatis</small></div>
      <div><span>Baris upload</span><strong>${formatInteger(result.uploaded_valid_rows || 0)}</strong><small>nilai terisi</small></div>
    `;

    const messages = [...(result.errors || []), ...(result.warnings || [])];
    if (messages.length) {
      elements.uploadIssues.hidden = false;
      elements.uploadIssues.innerHTML = `<strong>Catatan validasi</strong><ul>${messages.map(item => `<li>${escapeHTML(item)}</li>`).join("")}</ul>`;
    }
    const preview = result.uploaded_preview || [];
    if (preview.length) {
      elements.uploadPreviewWrap.hidden = false;
      elements.uploadPreviewBody.innerHTML = preview.map(item => `
        <tr><td>${formatInteger(item.row)}</td><td>${escapeHTML(item.period)}</td><td>${escapeHTML(item.kecamatan)}</td><td>${item.case_count == null || item.case_count === "" ? "—" : escapeHTML(String(item.case_count))}</td><td><span class="preview-status ${item.status === "Valid" ? "ok" : item.status === "Kosong" ? "empty" : "bad"}">${escapeHTML(item.status)}</span></td></tr>
      `).join("");
    }
  }

  async function applySelectedUpload() {
    const file = state.uploadFile;
    if (!file || !state.uploadValidation?.can_apply) return;
    elements.applyUploadButton.disabled = true;
    elements.applyUploadButton.textContent = "Menerapkan…";
    try {
      const result = await postRawFile(API.applyUpload(file.name), file);
      elements.uploadValidationState.hidden = false;
      elements.uploadValidationState.className = "upload-validation-state is-ok";
      elements.uploadValidationState.innerHTML = `<strong>Data berhasil diterapkan</strong><span>${formatInteger(result.active_rows || 0)} catatan aktif tersimpan. Peta dan peringatan sedang diperbarui.</span>`;
      await refreshRealtime(true);
      renderDashboard(false);
      window.setTimeout(() => elements.uploadDialog?.close(), 900);
    } catch (error) {
      elements.uploadValidationState.hidden = false;
      elements.uploadValidationState.className = "upload-validation-state is-error";
      elements.uploadValidationState.innerHTML = `<strong>Data gagal diterapkan</strong><span>${escapeHTML(error.message)}</span>`;
      elements.applyUploadButton.disabled = false;
    } finally {
      elements.applyUploadButton.textContent = "Terapkan & perbarui peta";
    }
  }

  function createTrendChart() {
    if (typeof Chart === "undefined") {
      elements.chartFallback.hidden = false;
      return;
    }
    const context = document.getElementById("trendChart").getContext("2d");
    state.trendChart = new Chart(context, {
      data: {
        labels: [],
        datasets: [
          { type: "line", label: "Kasus", data: [], borderColor: "#ff655b", backgroundColor: "rgba(255,101,91,.14)", borderWidth: 2.2, pointRadius: 2.5, pointHoverRadius: 4, tension: 0.35, fill: true },
          { type: "bar", label: "Peringatan", data: [], backgroundColor: "rgba(25,167,127,.58)", borderColor: "#19a77f", borderWidth: 1, borderRadius: 4, maxBarThickness: 18 }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { position: "bottom", labels: { color: "#586b70", usePointStyle: true, boxWidth: 8, padding: 14, font: { size: 10 } } },
          tooltip: { backgroundColor: "#0d2d36", padding: 10, titleColor: "#fff", bodyColor: "#d9e6e3" }
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: "#6e7f83", font: { size: 9 } } },
          y: { beginAtZero: true, ticks: { color: "#6e7f83", precision: 0, font: { size: 9 } }, grid: { color: "rgba(13,45,54,.08)" } }
        }
      }
    });
  }

  function updateTrendChart() {
    if (!state.trendChart || !state.history) return;
    let records = state.history.monthly_records || [];
    if (state.district !== "all") records = records.filter(item => String(item.kecamatan_code) === state.district);
    const months = [...new Set(records.map(item => item.target_month))].sort();
    state.trendChart.data.labels = months.map(shortMonthLabel);
    state.trendChart.data.datasets[0].data = months.map(month => sum(records.filter(item => item.target_month === month), "target_case_next_month"));
    state.trendChart.data.datasets[1].data = months.map(month => sum(records.filter(item => item.target_month === month), "prediction"));
    state.trendChart.update();
  }

  function createFacilityLayer() {
    if (!state.facilities) {
      elements.facilityToggle.disabled = true;
      return;
    }
    state.facilityLayer = L.geoJSON(state.facilities, {
      pointToLayer: (feature, latlng) => L.marker(latlng, {
        icon: L.divIcon({ className: "facility-marker", html: "+", iconSize: [25, 25], iconAnchor: [12, 12] })
      }),
      onEachFeature: (feature, layer) => {
        const properties = feature.properties || {};
        layer.bindPopup(`<strong>${escapeHTML(properties.name || "Fasilitas kesehatan")}</strong><br><span>${escapeHTML(properties.facility_type || "Fasilitas kesehatan")}</span>`);
      }
    });
  }

  function updateModelMetrics() {
    const metrics = state.modelMetadata?.test_metrics || state.modelMetadata?.metrics || state.modelMetadata || {};
    const realtimeThreshold = state.realtime?.metadata?.threshold;
    document.getElementById("rocMetric").textContent = formatDecimal(metrics.roc_auc ?? 0.749, 3);
    document.getElementById("prMetric").textContent = formatDecimal(metrics.pr_auc ?? 0.271, 3);
    document.getElementById("recallMetric").textContent = `${formatDecimal((metrics.recall ?? 0.92) * 100, 0)}%`;
    document.getElementById("thresholdMetric").textContent = formatDecimal(realtimeThreshold ?? metrics.threshold ?? 0.045, 3);
  }

  function selectedMonthRecords() {
    return (state.history?.monthly_records || []).filter(record => record.target_month === state.month);
  }

  function toggleMobilePanel(open) {
    elements.analysisPanel.classList.toggle("open", open);
    elements.mobilePanelButton.setAttribute("aria-expanded", String(open));
    window.setTimeout(() => map.invalidateSize(), 240);
  }

  function setBusy(busy, message = "Memuat data…") {
    if (busy) {
      elements.loading.querySelector("p").textContent = message;
      elements.loading.hidden = false;
    } else {
      elements.loading.hidden = true;
    }
  }

  function showTransientError(message) {
    elements.error.querySelector("p").textContent = message;
    elements.error.hidden = false;
    window.setTimeout(() => { elements.error.hidden = true; }, 4500);
  }

  function monthLabel(value) {
    if (!value) return "—";
    const [year, month] = value.split("-").map(Number);
    return new Intl.DateTimeFormat("id-ID", { month: "long", year: "numeric" }).format(new Date(year, month - 1, 1));
  }

  function shortMonthLabel(value) {
    const [year, month] = value.split("-").map(Number);
    return new Intl.DateTimeFormat("id-ID", { month: "short" }).format(new Date(year, month - 1, 1)).replace(".", "");
  }

  function dateMonthLabel(value) {
    if (!value) return "bulan berikutnya";
    const date = new Date(`${value}T00:00:00`);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat("id-ID", { month: "long", year: "numeric" }).format(date);
  }

  function formatDate(value) {
    if (!value) return "belum tersedia";
    const date = new Date(String(value).length === 10 ? `${value}T00:00:00` : value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat("id-ID", { day: "2-digit", month: "short", year: "numeric" }).format(date);
  }

  function formatDateTime(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat("id-ID", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
  }

  function sum(items, key) {
    return items.reduce((total, item) => total + Number(item[key] || 0), 0);
  }

  function formatInteger(value) {
    return new Intl.NumberFormat("id-ID", { maximumFractionDigits: 0 }).format(Number(value || 0));
  }

  function formatDecimal(value, digits = 2) {
    return new Intl.NumberFormat("id-ID", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(Number(value || 0));
  }

  function formatSigned(value, digits = 3) {
    const number = Number(value || 0);
    return `${number > 0 ? "+" : ""}${formatDecimal(number, digits)}`;
  }

  function escapeHTML(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function showFatalError(message) {
    elements.loading.hidden = true;
    elements.error.hidden = false;
    elements.error.querySelector("p").textContent = message;
  }
})();
