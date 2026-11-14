(function () {
  "use strict";

  const DATA = window.FIELD_SHIFT_DATA;
  const STORAGE_KEY = "field_shift_fields_v2";
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const SCLEROTINIA_GROUP = new Set(["sunflower", "soybean", "rapeseed", "chickpea", "lentil", "field_pea"]);
  const CEREAL_GROUP = new Set(["winter_wheat", "winter_barley", "corn", "sorghum", "millet"]);
  const UK_ALIAS_MAP = {
    "черкаси": "Cherkasy",
    "одеса": "Odesa",
    "київ": "Kyiv Ukraine",
    "полтава": "Poltava Ukraine",
    "вінниця": "Vinnytsia Ukraine",
    "харків": "Kharkiv Ukraine",
    "дніпро": "Dnipro Ukraine",
    "львів": "Lviv Ukraine",
    "миколаїв": "Mykolaiv Ukraine",
    "херсон": "Kherson Ukraine",
    "канзас": "Kansas",
    "андалусія": "Andalusia",
    "бразилія": "Mato Grosso",
    "кенія": "Nakuru Kenya"
  };

  const EXTRA_NASA_ZONES = [
    { name: "Poltava Loam Belt", lat: 49.58, lon: 34.55, moisturePct: 33, balanceMm: -58, risk: "mod" },
    { name: "Saskatchewan Prairies", lat: 50.45, lon: -104.61, moisturePct: 26, balanceMm: -135, risk: "high" },
    { name: "Castilla y Leon Dryland", lat: 41.65, lon: -4.72, moisturePct: 21, balanceMm: -210, risk: "high" },
    { name: "Pampas Pergamino", lat: -33.89, lon: -60.57, moisturePct: 39, balanceMm: 45, risk: "low" },
    { name: "Murray-Darling Basin", lat: -34.18, lon: 142.16, moisturePct: 19, balanceMm: -245, risk: "high" },
    { name: "Punjab Alluvial Plain", lat: 30.90, lon: 75.85, moisturePct: 29, balanceMm: -120, risk: "mod" }
  ];

  const state = {
    fields: [],
    activeFieldId: null,
    activeTab: "climate",
    sortBy: "default",
    basemap: "sat",
    showLabels: true,
    showZones: true,
    isDrawing: false,
    redrawTargetId: null,
    drawPoints: [],
    priorityMode: "water_first",
    weights: { water: 45, soil: 30, profit: 25 },
    useCoverCrop: true,
    coverCropId: "rye_vetch",
    useNoTill: true,
    planSequence: ["winter_wheat", "chickpea", "sorghum", "winter_barley"],
    overrides: null,
    telemetryLoading: false,
    activeRequestSeq: 0,
    liveForecast: null,
    liveCurrent: null,
    liveSoilGrids: null,
    livePowerStats: null,
    nasaCache: new Map(),
    toastTimer: null
  };

  let map = null;
  let layerSat = null;
  let layerTer = null;
  let layerLabels = null;
  let fieldsLayerGroup = null;
  let zonesLayerGroup = null;
  let drawLayerGroup = null;
  let searchDebounce = null;
  let mapClickLocked = false;

  const $ = (id) => document.getElementById(id);

  function clamp(val, min, max) {
    return Math.min(max, Math.max(min, val));
  }

  function deepClone(obj) {
    if (obj === undefined || obj === null) return obj;
    return JSON.parse(JSON.stringify(obj));
  }

  function getPresetSequence(field, modeId) {
    const modeObj = DATA.priorityModes[modeId];
    const targetKey = modeObj?.targetPresetKey || modeId;
    const seq = field?.presets?.[targetKey] || field?.presets?.water_saver || Object.values(field?.presets || {})[0];
    return seq ? deepClone(seq) : ["winter_wheat", "chickpea", "sorghum", "winter_barley"];
  }

  function showToast(msg) {
    const toast = $("appToast");
    toast.textContent = msg;
    toast.classList.remove("is-hidden");
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      toast.classList.add("is-hidden");
    }, 3200);
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function computePolygonAreaHa(latlngs) {
    if (!Array.isArray(latlngs) || latlngs.length < 3) return 0;
    const R = 6378137;
    const rad = Math.PI / 180;
    let total = 0;
    for (let i = 0; i < latlngs.length; i += 1) {
      const p1 = latlngs[i];
      const p2 = latlngs[(i + 1) % latlngs.length];
      const lat1 = p1[0] * rad;
      const lat2 = p2[0] * rad;
      const dLon = (p2[1] - p1[1]) * rad;
      total += dLon * (2 + Math.sin(lat1) + Math.sin(lat2));
    }
    const sqm = Math.abs(total * R * R / 2);
    return Math.max(0.5, Number((sqm / 10000).toFixed(1)));
  }

  function computePolygonCentroid(latlngs) {
    if (!Array.isArray(latlngs) || latlngs.length === 0) return [49.38, 31.95];
    let sumLat = 0;
    let sumLon = 0;
    for (const pt of latlngs) {
      sumLat += pt[0];
      sumLon += pt[1];
    }
    return [
      Number((sumLat / latlngs.length).toFixed(5)),
      Number((sumLon / latlngs.length).toFixed(5))
    ];
  }

  function createRectPolygon(lat, lon, targetHa) {
    const sideMeters = Math.sqrt(Math.max(4, targetHa) * 10000);
    const halfLat = (sideMeters * 0.5) / 111320;
    const cosLat = Math.max(0.25, Math.cos((lat * Math.PI) / 180));
    const halfLon = (sideMeters * 0.5) / (111320 * cosLat);
    return [
      [Number((lat + halfLat).toFixed(5)), Number((lon - halfLon).toFixed(5))],
      [Number((lat + halfLat).toFixed(5)), Number((lon + halfLon).toFixed(5))],
      [Number((lat - halfLat).toFixed(5)), Number((lon + halfLon).toFixed(5))],
      [Number((lat - halfLat).toFixed(5)), Number((lon - halfLon).toFixed(5))]
    ];
  }

  function buildFieldThumbSvg(polygon) {
    if (!Array.isArray(polygon) || polygon.length < 3) {
      return "<svg viewBox=\"0 0 40 40\" width=\"34\" height=\"34\"><rect x=\"8\" y=\"8\" width=\"24\" height=\"24\" rx=\"3\" fill=\"rgba(34,197,94,0.25)\" stroke=\"#4ADE80\" stroke-width=\"2\"/></svg>";
    }
    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLon = Infinity;
    let maxLon = -Infinity;
    for (const [lat, lon] of polygon) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }
    const spanLat = Math.max(0.0001, maxLat - minLat);
    const spanLon = Math.max(0.0001, maxLon - minLon);
    const span = Math.max(spanLat, spanLon);
    const padX = (span - spanLon) * 0.5;
    const padY = (span - spanLat) * 0.5;
    const pts = polygon
      .map(([lat, lon]) => {
        const x = 6 + ((lon - minLon + padX) / span) * 28;
        const y = 34 - ((lat - minLat + padY) / span) * 28;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
    return `<svg viewBox="0 0 40 40" width="36" height="36" aria-hidden="true"><polygon points="${pts}" fill="rgba(34,197,94,0.28)" stroke="#4ADE80" stroke-width="2" stroke-linejoin="round"/></svg>`;
  }

  function loadStoredFields() {
    const demos = DATA.globalLocations.map((loc) => ({
      ...deepClone(loc),
      isDemo: true,
      selectedPlan: getPresetSequence(loc, state.priorityMode),
      coverCropId: "rye_vetch",
      useCoverCrop: true,
      useNoTill: true
    }));

    let custom = [];
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          custom = parsed.filter((f) => f && f.id && Array.isArray(f.polygon));
        }
      }
    } catch (_err) {
      custom = [];
    }

    const demoOverrides = {};
    try {
      const rawOv = localStorage.getItem(`${STORAGE_KEY}_overrides`);
      if (rawOv) Object.assign(demoOverrides, JSON.parse(rawOv));
    } catch (_err) {
      Object.keys(demoOverrides).forEach((k) => delete demoOverrides[k]);
    }

    const mergedDemos = demos.map((d) => {
      const saved = demoOverrides[d.id];
      return saved ? { ...d, ...saved, isDemo: true } : d;
    });

    state.fields = [...custom, ...mergedDemos];
    state.activeFieldId = state.fields[0] ? state.fields[0].id : null;
  }

  function saveFieldsToStorage() {
    try {
      const customFields = state.fields.filter((f) => !f.isDemo);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(customFields));

      const demoMeta = {};
      for (const f of state.fields) {
        if (f.isDemo) {
          demoMeta[f.id] = {
            selectedPlan: f.selectedPlan,
            coverCropId: f.coverCropId,
            useCoverCrop: f.useCoverCrop,
            useNoTill: f.useNoTill,
            polygon: f.polygon,
            lat: f.lat,
            lon: f.lon,
            defaultAreaHa: f.defaultAreaHa,
            defaultSoilType: f.defaultSoilType,
            defaultPrevCrop: f.defaultPrevCrop,
            defaultSomPct: f.defaultSomPct,
            defaultSoilPh: f.defaultSoilPh
          };
        }
      }
      localStorage.setItem(`${STORAGE_KEY}_overrides`, JSON.stringify(demoMeta));
    } catch (_err) {
      showToast("Browser storage quota reached");
    }
  }

  function getActiveField() {
    return state.fields.find((f) => f.id === state.activeFieldId) || state.fields[0];
  }

  function getEffectiveSoilAndField(field) {
    const soilTypeId = state.overrides?.soilTypeId || field.defaultSoilType || "chernozem";
    const somPct = state.overrides?.somPct ?? field.defaultSomPct ?? 3.2;
    const ph = state.overrides?.ph ?? field.defaultSoilPh ?? 6.6;
    const prevCrop = state.overrides?.prevCrop || field.defaultPrevCrop || "corn";
    const areaHa = state.overrides?.areaHa ?? field.defaultAreaHa ?? 40;
    const soil = DATA.soilTypes[soilTypeId] || DATA.soilTypes.chernozem;
    return { soilTypeId, soil, somPct, ph, prevCrop, areaHa };
  }

  function buildDynamicBaseline(lat, lon, powerData, soilGridsData) {
    const absLat = Math.abs(lat);
    let annualPrecipMm = 540;
    let annualEtDemandMm = 820;
    let monthlyPrecipMm = [36, 34, 38, 44, 58, 66, 56, 48, 45, 42, 39, 34];
    let monthlyTempMaxC = [0, 2, 8, 15, 22, 26, 29, 28, 22, 14, 7, 2];
    let rootMoisturePct = 28;
    let deepMoisturePct = 36;
    let sourceTag = "NASA POWER + Model";

    if (powerData && powerData.PRECTOTCORR) {
      const mKeys = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
      const daysInMo = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      monthlyPrecipMm = mKeys.map((mk, idx) => {
        const val = powerData.PRECTOTCORR[mk];
        return val != null && val >= 0 ? Math.round(val * daysInMo[idx]) : monthlyPrecipMm[idx];
      });
      annualPrecipMm = monthlyPrecipMm.reduce((a, b) => a + b, 0);

      if (powerData.T2M_MAX) {
        monthlyTempMaxC = mKeys.map((mk, idx) => {
          const t = powerData.T2M_MAX[mk];
          return t != null && t > -60 ? Number(t.toFixed(1)) : monthlyTempMaxC[idx];
        });
      }
      if (powerData.GWETROOT) {
        const vals = mKeys.map((mk) => powerData.GWETROOT[mk]).filter((v) => v != null && v >= 0);
        if (vals.length) {
          const avgRoot = vals.reduce((a, b) => a + b, 0) / vals.length;
          rootMoisturePct = clamp(Math.round(avgRoot * 62), 14, 52);
        }
      }
      if (powerData.GWETPROF) {
        const vals = mKeys.map((mk) => powerData.GWETPROF[mk]).filter((v) => v != null && v >= 0);
        if (vals.length) {
          const avgProf = vals.reduce((a, b) => a + b, 0) / vals.length;
          deepMoisturePct = clamp(Math.round(avgProf * 68), 18, 56);
        }
      }
      sourceTag = "NASA POWER Live";
    } else {
      const latFactor = clamp((48 - absLat) / 48, 0, 1);
      annualPrecipMm = Math.round(420 + (1 - latFactor) * 260);
      monthlyPrecipMm = monthlyPrecipMm.map((v) => Math.round((v / 540) * annualPrecipMm));
    }

    const monthlyEtMm = monthlyTempMaxC.map((tMax, i) => {
      const baseEt = Math.max(12, (tMax + 4) * 3.9 + (absLat < 35 ? 25 : 8));
      const seasonBoost = i >= 4 && i <= 7 ? 1.24 : 0.85;
      return Math.round(baseEt * seasonBoost);
    });
    annualEtDemandMm = monthlyEtMm.reduce((a, b) => a + b, 0);

    const growPrecip = monthlyPrecipMm.slice(3, 9).reduce((a, b) => a + b, 0);
    const growEt = monthlyEtMm.slice(3, 9).reduce((a, b) => a + b, 0);
    const seasonalWaterBalanceMm = Math.round(growPrecip - growEt * 0.78);
    const hotMonths = monthlyTempMaxC.filter((t) => t >= 28).length;
    const extremeHeatDays = clamp(hotMonths * 7 + (seasonalWaterBalanceMm < -120 ? 12 : 3), 5, 62);
    const warmingAnomalyC = Number((1.15 + clamp((absLat - 20) / 50, 0.1, 0.7)).toFixed(1));
    const droughtRiskScore = clamp(
      Math.round(52 - seasonalWaterBalanceMm * 0.18 + (30 - rootMoisturePct) * 1.1 + extremeHeatDays * 0.25),
      20,
      94
    );

    let defaultSoilType = absLat > 44 ? "chernozem" : absLat < 24 ? "oxisol" : "silt_loam";
    let defaultSomPct = absLat > 44 ? 3.5 : 2.3;
    let defaultSoilPh = 6.7;

    if (soilGridsData) {
      if (soilGridsData.somPct != null) defaultSomPct = soilGridsData.somPct;
      if (soilGridsData.ph != null) defaultSoilPh = soilGridsData.ph;
      if (soilGridsData.clayPct != null && soilGridsData.sandPct != null) {
        if (soilGridsData.clayPct >= 34 && defaultSomPct >= 3.2) defaultSoilType = "chernozem";
        else if (soilGridsData.clayPct >= 32) defaultSoilType = "calcareous_clay";
        else if (soilGridsData.sandPct >= 54) defaultSoilType = "sandy_clay";
        else defaultSoilType = "silt_loam";
      }
    }

    const climateZone = absLat < 23.5 ? "Tropical / Cerrado" : absLat < 38 ? "Mediterranean / Semi-Arid" : "Temperate Continental";

    return {
      climateZone,
      defaultSoilType,
      defaultSomPct,
      defaultSoilPh,
      sourceTag,
      nasaBaseline: {
        rootMoisturePct,
        deepMoisturePct,
        rootAvailableWaterMm: Math.round(rootMoisturePct * 3.1),
        annualPrecipMm,
        annualEtDemandMm,
        seasonalWaterBalanceMm,
        warmingAnomalyC,
        extremeHeatDays,
        ndviBaseline: Number(clamp(0.45 + rootMoisturePct * 0.008, 0.35, 0.82).toFixed(2)),
        droughtRiskScore,
        monthlyPrecipMm,
        monthlyEtMm,
        monthlyTempMaxC
      }
    };
  }

  function buildCustomFieldObject(name, lat, lon, polygon, telemetryBundle) {
    const areaHa = computePolygonAreaHa(polygon);
    const dyn = buildDynamicBaseline(lat, lon, telemetryBundle?.power, telemetryBundle?.soilGrids);
    const dryBias = dyn.nasaBaseline.seasonalWaterBalanceMm < -90;
    const seqWater = dryBias
      ? ["winter_barley", "chickpea", "sorghum", "lentil"]
      : ["winter_wheat", "chickpea", "corn", "soybean"];
    const seqSoil = ["alfalfa", "winter_wheat", "field_pea", "winter_barley"];
    const seqProfit = dryBias
      ? ["rapeseed", "winter_wheat", "chickpea", "sorghum"]
      : ["soybean", "winter_wheat", "rapeseed", "corn"];

    return {
      id: `custom_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      name,
      region: `${lat.toFixed(2)}°, ${lon.toFixed(2)}°`,
      country: dyn.climateZone,
      iso: "USER",
      isDemo: false,
      lat,
      lon,
      zoom: 14,
      polygon,
      climateZone: dyn.climateZone,
      defaultSoilType: dyn.defaultSoilType,
      defaultSomPct: dyn.defaultSomPct,
      defaultSoilPh: dyn.defaultSoilPh,
      defaultPrevCrop: dryBias ? "sunflower" : "corn",
      defaultAreaHa: areaHa,
      nasaBaseline: dyn.nasaBaseline,
      humanDiagnosis: `Live telemetry sampled at ${lat.toFixed(3)}, ${lon.toFixed(3)} (${dyn.sourceTag}). Seasonal balance is ${dyn.nasaBaseline.seasonalWaterBalanceMm >= 0 ? "+" : ""}${dyn.nasaBaseline.seasonalWaterBalanceMm} mm with ${dyn.nasaBaseline.extremeHeatDays} annual heat-stress days.`,
      traditionalRotation: dryBias
        ? ["sunflower", "winter_wheat", "sunflower", "corn"]
        : ["corn", "corn", "soybean", "corn"],
      presets: {
        water_saver: seqWater,
        soil_builder: seqSoil,
        balanced: seqProfit,
        low_input: ["winter_barley", "field_pea", "millet", "chickpea"]
      },
      selectedPlan: seqWater,
      coverCropId: "rye_vetch",
      useCoverCrop: true,
      useNoTill: true
    };
  }

  function simulateRotation(field, sequence, useCoverCrop, coverCropId, useNoTill) {
    const { soil, somPct, ph, prevCrop } = getEffectiveSoilAndField(field);
    const base = field.nasaBaseline;
    const cover = DATA.coverCropBridges[coverCropId] || DATA.coverCropBridges.rye_vetch;
    const maxHoldingMm = soil.waterHoldingMmPerM + (somPct - 2.0) * 6.5;

    let rootWater = clamp(base.rootAvailableWaterMm, 32, maxHoldingMm * 0.92);
    let nitrogenCarryKg = 14;
    let currentSom = somPct;
    let prev = prevCrop;
    const history = [prevCrop];

    let totalMarginUsdHa = 0;
    let totalStressScore = 0;
    const yearly = [];
    const alerts = [];

    const maxPeakTemp = Math.max(...(base.monthlyTempMaxC || [28]));
    const siteWetness = clamp(base.annualPrecipMm / 560, 0.55, 1.35);

    for (let yr = 0; yr < 4; yr += 1) {
      const cropId = sequence[yr] || "winter_wheat";
      const crop = DATA.crops[cropId] || DATA.crops.winter_wheat;

      const infMmHr = parseFloat(String(soil.infiltrationRate).match(/\d+/)?.[0] || 22);
      const coverWaterGain = useCoverCrop ? (cover.waterRetentionBonusMm || 0) * siteWetness : 0;
      const tillWaterGain = useNoTill ? (14 * infMmHr) / 24 : 0;
      const effectivePrecip = base.annualPrecipMm * (0.64 + (useCoverCrop ? 0.05 : 0) + (useNoTill ? 0.05 : 0));
      const rootReachBonus = (crop.rootDepthCm - 85) * 0.16;

      const availableWater = Math.min(maxHoldingMm, rootWater + effectivePrecip + coverWaterGain + tillWaterGain + rootReachBonus);
      const waterRatio = clamp(availableWater / crop.waterNeedMm, 0.42, 1.18);

      const heatOvershoot = Math.max(0, maxPeakTemp - crop.heatLimitC);
      const heatPenalty = heatOvershoot * 0.032 + (base.extremeHeatDays > 28 && crop.droughtTolerance < 65 ? 0.08 : 0);

      let rotationMod = 1.0;
      const prevCropObj = DATA.crops[prev];

      if (prev === cropId) {
        rotationMod -= 0.16;
        if (yr < 3) alerts.push({ level: "bad", text: `Year ${2027 + yr} repeats ${crop.name} back-to-back, sharply raising root disease and yield loss.` });
      } else if (SCLEROTINIA_GROUP.has(prev) && SCLEROTINIA_GROUP.has(cropId)) {
        rotationMod -= 0.09;
        alerts.push({ level: "warn", text: `${2027 + yr}: ${crop.name} follows ${prevCropObj?.name || prev} — shared Sclerotinia pathogen risk.` });
      } else if (crop.badPredecessors.includes(prev)) {
        rotationMod -= 0.07;
        alerts.push({ level: "warn", text: `${2027 + yr}: Sub-optimal transition after ${prevCropObj?.name || prev}.` });
      } else if (crop.greatPredecessors.includes(prev)) {
        rotationMod += 0.06;
        if (yr === 0) alerts.push({ level: "good", text: `Strong opening: ${crop.name} pairs well after ${prevCropObj?.name || prev} residue.` });
      }

      const repeatIdx = history.lastIndexOf(cropId);
      if (repeatIdx !== -1) {
        const gap = history.length - repeatIdx;
        if (gap < crop.minReturnYears) {
          rotationMod -= 0.08;
          alerts.push({ level: "warn", text: `${2027 + yr}: ${crop.name} returns in ${gap} yr (recommended min ${crop.minReturnYears} yr interval).` });
        }
      }

      if (crop.nitrogenBalanceKg > 30 && CEREAL_GROUP.has(sequence[yr + 1])) {
        if (yr < 3) alerts.push({ level: "good", text: `${2027 + yr} ${crop.name} supplies biological N carryover for ${2028 + yr} ${DATA.crops[sequence[yr + 1]].shortName}.` });
      }

      const phPenalty = ph < 5.3 || ph > 8.2 ? 0.05 : 0;
      const somYieldBoost = clamp((currentSom - 2.5) * 0.025, -0.05, 0.08);
      const tolNorm = (crop.droughtTolerance || 60) / 100;
      const droughtShield = waterRatio < 0.88 ? (0.88 - waterRatio) * (1 - tolNorm * 0.72) : 0;

      const yieldFactor = clamp((0.88 * Math.min(1.06, waterRatio) + somYieldBoost - heatPenalty - droughtShield - phPenalty) * rotationMod, 0.35, 1.15);

      const nFromCover = useCoverCrop ? (cover.nBonusKg || 0) : 0;
      const coverCost = useCoverCrop ? (cover.costUsdHa || 0) : 0;
      const fertCreditUsd = Math.min(nitrogenCarryKg + nFromCover, 65) * 0.95;
      const revenueUsdHa = Math.round(crop.baseRevenueUsdHa * yieldFactor);
      const costUsdHa = Math.round(crop.baseCostUsdHa - fertCreditUsd + coverCost - (useNoTill ? 24 : 0));
      const marginUsdHa = revenueUsdHa - costUsdHa;
      totalMarginUsdHa += marginUsdHa;

      const waterRemaining = clamp(availableWater - crop.waterNeedMm * 0.62, 18, maxHoldingMm);
      rootWater = waterRemaining;

      nitrogenCarryKg = clamp(nitrogenCarryKg * 0.35 + crop.nitrogenBalanceKg + nFromCover * 0.5, -10, 95);
      currentSom = clamp(currentSom + crop.somDeltaPct + (useCoverCrop ? (cover.somBonusPct || 0) : 0) + (useNoTill ? 0.04 : -0.02), 0.9, 7.2);

      const yrStress = clamp((waterRemaining / maxHoldingMm) * 55 + (crop.droughtTolerance / 10) * 3.8 - (heatOvershoot * 4), 10, 100);
      totalStressScore += yrStress;

      yearly.push({
        year: 2027 + yr,
        cropId,
        cropName: crop.name,
        shortName: crop.shortName,
        yieldFactor: Number(yieldFactor.toFixed(2)),
        waterEndMm: Math.round(waterRemaining),
        marginUsdHa,
        nCarryKg: Math.round(nitrogenCarryKg),
        somPct: Number(currentSom.toFixed(2))
      });

      prev = cropId;
      history.push(cropId);
    }

    const avgWaterEnd = yearly.reduce((s, y) => s + y.waterEndMm, 0) / 4;
    const somDelta = Number((currentSom - somPct).toFixed(2));
    const waterScore = clamp(Math.round((avgWaterEnd / Math.max(85, maxHoldingMm * 0.72)) * 85), 15, 100);
    const soilScore = clamp(Math.round(52 + somDelta * 95), 15, 100);
    const profitScore = clamp(Math.round((totalMarginUsdHa / 2100) * 85), 15, 100);

    const wSum = Math.max(1, state.weights.water + state.weights.soil + state.weights.profit);
    const compositeScore = clamp(
      Math.round(
        (waterScore * state.weights.water + soilScore * state.weights.soil + profitScore * state.weights.profit) / wSum
      ),
      18,
      98
    );

    const uniqueAlerts = [];
    const seenTexts = new Set();
    for (const a of alerts) {
      if (!seenTexts.has(a.text)) {
        seenTexts.add(a.text);
        uniqueAlerts.push(a);
      }
    }
    if (uniqueAlerts.length === 0) {
      uniqueAlerts.push({
        level: "good",
        text: "Balanced 4-year crop family diversity with zero consecutive pathogen overlaps."
      });
    }

    return {
      yearly,
      totalMarginUsdHa,
      finalWaterMm: yearly[3].waterEndMm,
      avgWaterMm: Math.round(avgWaterEnd),
      somDelta,
      endSomPct: yearly[3].somPct,
      waterScore,
      soilScore,
      profitScore,
      compositeScore,
      resilienceAvg: Math.round(totalStressScore / 4),
      alerts: uniqueAlerts.slice(0, 5),
      wiltingThresholdMm: Math.round(maxHoldingMm * 0.34)
    };
  }

  function autoOptimizeRotation() {
    const field = getActiveField();
    const candidates = Object.keys(DATA.crops).filter((cid) => {
      const c = DATA.crops[cid];
      if (state.weights.water >= 45 && field.nasaBaseline.seasonalWaterBalanceMm < -120 && c.waterNeedMm > 540) {
        return false;
      }
      return true;
    });
    const pool = candidates.length >= 6 ? candidates : Object.keys(DATA.crops);
    let bestSeq = [...state.planSequence];
    let bestScore = -1;

    const topRated = [...pool]
      .sort((a, b) => {
        const ca = DATA.crops[a];
        const cb = DATA.crops[b];
        const sA = ca.droughtTolerance * state.weights.water + (ca.somDeltaPct * 120 + ca.nitrogenBalanceKg) * (state.weights.soil / 4) + (ca.baseRevenueUsdHa - ca.baseCostUsdHa) * 0.08 * state.weights.profit;
        const sB = cb.droughtTolerance * state.weights.water + (cb.somDeltaPct * 120 + cb.nitrogenBalanceKg) * (state.weights.soil / 4) + (cb.baseRevenueUsdHa - cb.baseCostUsdHa) * 0.08 * state.weights.profit;
        return sB - sA;
      })
      .slice(0, 8);

    for (let a = 0; a < topRated.length; a += 1) {
      for (let b = 0; b < topRated.length; b += 1) {
        if (b === a) continue;
        for (let c = 0; c < topRated.length; c += 1) {
          if (c === b || c === a) continue;
          for (let d = 0; d < topRated.length; d += 1) {
            if (d === c || d === b) continue;
            const seq = [topRated[a], topRated[b], topRated[c], topRated[d]];
            const sim = simulateRotation(field, seq, state.useCoverCrop, state.coverCropId, state.useNoTill);
            if (sim.compositeScore > bestScore) {
              bestScore = sim.compositeScore;
              bestSeq = seq;
            }
          }
        }
      }
    }

    state.planSequence = bestSeq;
    field.selectedPlan = [...bestSeq];
    saveFieldsToStorage();
    renderAll();
    showToast(`Optimized 4-yr plan (Score ${bestScore}/100)`);
  }

  async function fetchWithTimeout(url, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchRawBundle(lat, lon) {
    const cacheKey = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    if (state.nasaCache.has(cacheKey)) {
      return state.nasaCache.get(cacheKey);
    }

    const meteoUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,wind_speed_10m,precipitation,soil_temperature_0cm,soil_moisture_0_to_1cm,soil_moisture_9_to_27cm,soil_moisture_27_to_81cm&daily=precipitation_sum,temperature_2m_max,et0_fao_evapotranspiration&forecast_days=7&timezone=auto`;
    const powerUrl = `https://power.larc.nasa.gov/api/temporal/climatology/point?parameters=T2M_MAX,PRECTOTCORR,GWETROOT,GWETPROF&community=AG&longitude=${lon}&latitude=${lat}&format=JSON`;
    const soilUrl = `https://rest.isric.org/soilgrids/v2.0/properties/query?lon=${lon}&lat=${lat}&property=clay&property=sand&property=phh2o&property=soc&depth=0-5cm&value=mean`;

    const [meteoRes, powerRes, soilRes] = await Promise.allSettled([
      fetchWithTimeout(meteoUrl, 7500),
      fetchWithTimeout(powerUrl, 8000),
      fetchWithTimeout(soilUrl, 7500)
    ]);

    let meteo = null;
    if (meteoRes.status === "fulfilled" && meteoRes.value) {
      meteo = meteoRes.value;
    }

    let power = null;
    if (powerRes.status === "fulfilled" && powerRes.value?.properties?.parameter) {
      power = powerRes.value.properties.parameter;
    }

    let soilGrids = null;
    if (soilRes.status === "fulfilled" && soilRes.value?.properties?.layers) {
      const parsed = { clayPct: null, sandPct: null, ph: null, somPct: null };
      for (const layer of soilRes.value.properties.layers) {
        const val = layer?.depths?.[0]?.values?.mean;
        if (val == null) continue;
        if (layer.name === "clay") parsed.clayPct = Number((val / 10).toFixed(1));
        if (layer.name === "sand") parsed.sandPct = Number((val / 10).toFixed(1));
        if (layer.name === "phh2o") parsed.ph = Number((val / 10).toFixed(1));
        if (layer.name === "soc") {
          const socPct = val / 100;
          parsed.somPct = Number(clamp(socPct * 1.724 * 0.48, 0.9, 6.2).toFixed(1));
        }
      }
      if (parsed.clayPct !== null || parsed.ph !== null || parsed.somPct !== null) {
        soilGrids = parsed;
      }
    }

    const bundle = { meteo, power, soilGrids, fetchedAt: Date.now() };
    if (meteo || power || soilGrids) {
      state.nasaCache.set(cacheKey, bundle);
    }
    return bundle;
  }

  async function syncActiveFieldTelemetry(forceRefresh) {
    const field = getActiveField();
    if (!field) return;

    const seq = ++state.activeRequestSeq;
    const cacheKey = `${field.lat.toFixed(2)},${field.lon.toFixed(2)}`;
    if (forceRefresh) state.nasaCache.delete(cacheKey);

    state.telemetryLoading = !state.nasaCache.has(cacheKey);
    renderTelemetryStatus();

    const bundle = await fetchRawBundle(field.lat, field.lon);
    if (seq !== state.activeRequestSeq) return;

    state.telemetryLoading = false;
    state.liveCurrent = bundle.meteo?.current || null;
    state.liveForecast = bundle.meteo?.daily || null;
    state.liveSoilGrids = bundle.soilGrids || null;
    state.livePowerStats = bundle.power || null;

    if (!field.isDemo && (bundle.power || bundle.soilGrids)) {
      const updated = buildDynamicBaseline(field.lat, field.lon, bundle.power, bundle.soilGrids);
      field.nasaBaseline = updated.nasaBaseline;
      field.climateZone = updated.climateZone;
      if (!state.overrides) {
        field.defaultSoilType = updated.defaultSoilType;
        field.defaultSomPct = updated.defaultSomPct;
        field.defaultSoilPh = updated.defaultSoilPh;
      }
      saveFieldsToStorage();
    }

    renderAll();
  }

  function renderTelemetryStatus() {
    const badge = $("hudSyncBadge");
    const weatherBadge = $("liveWeatherBadge");
    const stripStatus = $("stripSourcesStatus");
    if (state.telemetryLoading) {
      badge.textContent = "Syncing...";
      badge.classList.add("is-syncing");
      weatherBadge.textContent = "Syncing Open-Meteo...";
      stripStatus.textContent = "SYNCING NASA POWER + OPEN-METEO ECMWF + SOILGRIDS v2.0...";
      return;
    }
    badge.classList.remove("is-syncing");
    const parts = [];
    if (state.livePowerStats || getActiveField()?.isDemo) parts.push("NASA");
    if (state.liveCurrent) parts.push("Meteo");
    if (state.liveSoilGrids) parts.push("SoilGrids");
    badge.textContent = parts.length ? parts.join(" + ") : "Benchmark";
    weatherBadge.textContent = state.liveForecast ? "Live ECMWF 7-Day" : "Offline Forecast";
    stripStatus.textContent = "NASA POWER \u00B7 SMAP L4 \u00B7 OPEN-METEO ECMWF \u00B7 SOILGRIDS v2.0";
  }

  function updateMicroStripCoords(lat, lon) {
    if (!map) return;
    const c = lat != null && lon != null ? { lat, lng: lon } : map.getCenter();
    const latNs = c.lat >= 0 ? "N" : "S";
    const lonEw = c.lng >= 0 ? "E" : "W";
    $("hudCoordLat").textContent = `${Math.abs(c.lat).toFixed(4)}\u00B0 ${latNs}`;
    $("hudCoordLon").textContent = `${Math.abs(c.lng).toFixed(4)}\u00B0 ${lonEw}`;
    $("hudMapZoom").textContent = map.getZoom().toFixed(1);
  }

  function initMap() {
    map = L.map("globalMap", {
      zoomControl: false,
      attributionControl: false
    }).setView([49.38, 31.95], 13);

    L.control.zoom({ position: "bottomright" }).addTo(map);

    layerSat = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 18
    });
    layerTer = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 18
    });
    layerLabels = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 18,
      opacity: 0.85
    });

    layerSat.addTo(map);
    layerLabels.addTo(map);

    fieldsLayerGroup = L.layerGroup().addTo(map);
    zonesLayerGroup = L.layerGroup().addTo(map);
    drawLayerGroup = L.layerGroup().addTo(map);

    map.on("mousemove", (ev) => {
      updateMicroStripCoords(ev.latlng.lat, ev.latlng.lng);
    });

    map.on("moveend zoomend", () => {
      updateMicroStripCoords();
      if (state.showZones) renderZonesOverlay();
    });

    map.on("click", (ev) => {
      if (state.isDrawing) {
        state.drawPoints.push([Number(ev.latlng.lat.toFixed(6)), Number(ev.latlng.lng.toFixed(6))]);
        renderDrawingOverlay();
        return;
      }
      if (mapClickLocked) return;
      handleQuickMapSample(ev.latlng.lat, ev.latlng.lng);
    });

    map.on("dblclick", (ev) => {
      if (!state.isDrawing) return;
      L.DomEvent.stopPropagation(ev);
      if (state.drawPoints.length >= 3) {
        finishDrawingPolygon();
      }
    });

    map.on("zoomend", () => {
      renderFieldPolygons(false);
    });

    updateMicroStripCoords();
    renderZonesOverlay();
  }

  async function handleQuickMapSample(lat, lon) {
    const cleanLat = Number(lat.toFixed(4));
    const cleanLon = Number(lon.toFixed(4));
    const keepZoom = Math.max(map.getZoom(), 11);
    map.panTo([cleanLat, cleanLon], { animate: true });
    if (map.getZoom() < 11) map.setZoom(keepZoom);

    state.telemetryLoading = true;
    renderTelemetryStatus();

    const bundle = await fetchRawBundle(cleanLat, cleanLon);
    const poly = createRectPolygon(cleanLat, cleanLon, 36);
    const idxNum = state.fields.filter((f) => !f.isDemo).length + 1;
    const sampleField = buildCustomFieldObject(`Sample Parcel #${idxNum}`, cleanLat, cleanLon, poly, bundle);

    const existingSampleIdx = state.fields.findIndex((f) => f.id.startsWith("custom_sample_") && f.name.startsWith("Sample Parcel"));
    if (existingSampleIdx !== -1 && state.fields.length > 6) {
      sampleField.id = state.fields[existingSampleIdx].id;
      sampleField.name = state.fields[existingSampleIdx].name;
      state.fields[existingSampleIdx] = sampleField;
    } else {
      sampleField.id = `custom_sample_${Date.now()}`;
      state.fields.unshift(sampleField);
    }

    state.activeFieldId = sampleField.id;
    state.overrides = null;
    state.planSequence = [...sampleField.selectedPlan];
    state.telemetryLoading = false;
    state.liveCurrent = bundle.meteo?.current || null;
    state.liveForecast = bundle.meteo?.daily || null;
    state.liveSoilGrids = bundle.soilGrids || null;
    state.livePowerStats = bundle.power || null;

    saveFieldsToStorage();
    renderAll();
    renderFieldPolygons(false);
    showToast(`Sampled NASA + Open-Meteo telemetry at ${cleanLat.toFixed(2)}, ${cleanLon.toFixed(2)}`);
  }

  function startDrawingPolygon(redrawId) {
    state.isDrawing = true;
    state.redrawTargetId = redrawId || null;
    state.drawPoints = [];
    map.doubleClickZoom.disable();
    $("globalMap").classList.add("is-drawing");
    $("drawHud").classList.remove("is-hidden");
    $("mapIdleHint").classList.add("is-hidden");
    $("drawHudTitle").textContent = redrawId ? "Redrawing field boundary" : "Click vertices to map field boundary";
    renderDrawingOverlay();
  }

  function cancelDrawingPolygon() {
    state.isDrawing = false;
    state.redrawTargetId = null;
    state.drawPoints = [];
    map.doubleClickZoom.enable();
    $("globalMap").classList.remove("is-drawing");
    $("drawHud").classList.add("is-hidden");
    $("mapIdleHint").classList.remove("is-hidden");
    drawLayerGroup.clearLayers();
  }

  function renderDrawingOverlay() {
    drawLayerGroup.clearLayers();
    const pts = state.drawPoints;
    const areaHa = pts.length >= 3 ? computePolygonAreaHa(pts) : 0;

    $("drawVertexCount").textContent = String(pts.length);
    $("drawAreaReadout").textContent = `${areaHa.toFixed(1)} ha`;
    $("drawFinishBtn").disabled = pts.length < 3;

    if (pts.length >= 3) {
      L.polygon(pts, {
        color: "#22C55E",
        weight: 2.5,
        fillColor: "#22C55E",
        fillOpacity: 0.22
      }).addTo(drawLayerGroup);
    } else if (pts.length === 2) {
      L.polyline(pts, { color: "#4ADE80", weight: 2.5, dashArray: "5, 5" }).addTo(drawLayerGroup);
    }

    for (let i = 0; i < pts.length; i += 1) {
      L.circleMarker(pts[i], {
        radius: 5.5,
        color: "#FFFFFF",
        weight: 2,
        fillColor: i === 0 ? "#F59E0B" : "#15803D",
        fillOpacity: 1
      }).addTo(drawLayerGroup);
    }
  }

  function finishDrawingPolygon() {
    const pts = [...state.drawPoints];
    if (pts.length < 3) return;
    const areaHa = computePolygonAreaHa(pts);
    const [centLat, centLon] = computePolygonCentroid(pts);
    const targetId = state.redrawTargetId;
    cancelDrawingPolygon();

    if (targetId) {
      const target = state.fields.find((f) => f.id === targetId);
      if (target) {
        target.polygon = pts;
        target.lat = centLat;
        target.lon = centLon;
        target.defaultAreaHa = areaHa;
        state.overrides = null;
        saveFieldsToStorage();
        renderAll();
        renderFieldPolygons(true);
        syncActiveFieldTelemetry(true);
        showToast(`Updated boundary (${areaHa.toFixed(1)} ha)`);
      }
      return;
    }

    pendingDrawnData = { pts, areaHa, centLat, centLon };
    const count = state.fields.filter((f) => !f.isDemo).length + 1;
    $("newFieldNameInput").value = `Field Parcel #${count}`;
    $("newFieldAreaBadge").textContent = `Geodesic polygon area: ${areaHa.toFixed(1)} ha (${pts.length} vertices)`;
    $("nameFieldModal").classList.remove("is-hidden");
    $("newFieldNameInput").focus();
    $("newFieldNameInput").select();
  }

  let pendingDrawnData = null;

  async function confirmSaveNewField() {
    if (!pendingDrawnData) return;
    const { pts, areaHa, centLat, centLon } = pendingDrawnData;
    const customName = $("newFieldNameInput").value.trim() || `Field Parcel #${state.fields.length + 1}`;
    const prevCrop = $("newFieldPrevCropSelect").value || "corn";
    pendingDrawnData = null;
    $("nameFieldModal").classList.add("is-hidden");

    const newField = buildCustomFieldObject(customName, centLat, centLon, pts, null);
    newField.defaultAreaHa = areaHa;
    newField.defaultPrevCrop = prevCrop;

    state.fields.unshift(newField);
    state.activeFieldId = newField.id;
    state.overrides = null;
    state.planSequence = [...newField.selectedPlan];
    saveFieldsToStorage();
    renderAll();
    renderFieldPolygons(true);
    await syncActiveFieldTelemetry(true);
    showToast(`Saved ${customName} (${areaHa.toFixed(1)} ha)`);
  }

  function renderFieldPolygons(fitToActive) {
    if (!fieldsLayerGroup) return;
    fieldsLayerGroup.clearLayers();
    const active = getActiveField();

    const zoom = map ? map.getZoom() : 13;
    const sidebarOpen = !$("appShell").classList.contains("sidebar-collapsed") && window.innerWidth > 1024;

    for (const f of state.fields) {
      if (!Array.isArray(f.polygon) || f.polygon.length < 3) continue;
      const isSelected = active && f.id === active.id;
      const poly = L.polygon(f.polygon, {
        color: isSelected ? "#FACC15" : "#4ADE80",
        weight: isSelected ? 2.8 : 1.6,
        dashArray: isSelected ? "6, 4" : null,
        fillColor: isSelected ? "#22C55E" : "#94A3B8",
        fillOpacity: isSelected ? 0.22 : 0.1
      });

      poly.on("click", (ev) => {
        if (state.isDrawing) return;
        L.DomEvent.stopPropagation(ev);
        mapClickLocked = true;
        setTimeout(() => { mapClickLocked = false; }, 120);
        selectField(f.id, true);
      });

      if (zoom >= 9) {
        poly.bindTooltip(`${Number(f.defaultAreaHa).toFixed(1)} ha`, {
          permanent: true,
          direction: "center",
          className: "parcel-ha-tag"
        });
      } else {
        poly.bindTooltip(`${f.name} (${f.defaultAreaHa} ha)`, {
          direction: "top",
          offset: [0, -4]
        });
      }

      poly.addTo(fieldsLayerGroup);

      if (isSelected && fitToActive && map) {
        map.fitBounds(poly.getBounds(), {
          paddingTopLeft: [sidebarOpen ? 312 : 40, 56],
          paddingBottomRight: [40, 68],
          maxZoom: 14,
          animate: true,
          duration: 0.55
        });
      }
    }
  }

  function renderZonesOverlay() {
    if (!zonesLayerGroup || !map) return;
    zonesLayerGroup.clearLayers();
    if (!state.showZones) return;

    const zoom = map.getZoom();
    const showPermanent = zoom <= 6;

    const zones = [
      ...state.fields.map((f) => ({
        id: f.id,
        name: f.name,
        lat: f.lat,
        lon: f.lon,
        moisturePct: f.nasaBaseline.rootMoisturePct,
        balanceMm: f.nasaBaseline.seasonalWaterBalanceMm,
        risk: f.nasaBaseline.droughtRiskScore >= 68 ? "high" : f.nasaBaseline.droughtRiskScore >= 45 ? "mod" : "low"
      })),
      ...EXTRA_NASA_ZONES.map((z) => ({ ...z, id: null }))
    ];

    for (const z of zones) {
      const color = z.risk === "high" ? "#EF4444" : z.risk === "mod" ? "#F59E0B" : "#22C55E";
      const marker = L.circleMarker([z.lat, z.lon], {
        radius: zoom <= 6 ? 7 : 5,
        color: "#FFFFFF",
        weight: 1.5,
        fillColor: color,
        fillOpacity: 0.85
      });

      const sign = z.balanceMm >= 0 ? "+" : "";
      const labelHtml = `<strong>${escapeHtml(z.name)}</strong><br>SMAP ${z.moisturePct}% &middot; Bal ${sign}${z.balanceMm} mm`;

      marker.bindTooltip(showPermanent ? `${z.moisturePct}% SMAP` : labelHtml, {
        permanent: showPermanent,
        direction: "right",
        offset: [6, 0]
      });

      marker.on("click", (ev) => {
        if (state.isDrawing) return;
        L.DomEvent.stopPropagation(ev);
        if (z.id) {
          selectField(z.id, true);
        } else {
          handleQuickMapSample(z.lat, z.lon);
        }
      });

      marker.addTo(zonesLayerGroup);
    }
  }

  function selectField(fieldId, fitMap) {
    const target = state.fields.find((f) => f.id === fieldId);
    if (!target) return;
    state.activeFieldId = target.id;
    state.overrides = null;
    state.planSequence = target.selectedPlan ? deepClone(target.selectedPlan) : getPresetSequence(target, state.priorityMode);
    state.useCoverCrop = target.useCoverCrop !== false;
    state.coverCropId = target.coverCropId || "rye_vetch";
    state.useNoTill = target.useNoTill !== false;

    renderAll();
    renderFieldPolygons(fitMap);
    syncActiveFieldTelemetry(false);
  }

  function renderSidebarFields() {
    const list = $("fieldList");
    const filterQ = $("locationSearchInput").value.trim().toLowerCase();
    let arr = [...state.fields];

    if (filterQ) {
      arr = arr.filter((f) =>
        `${f.name} ${f.region} ${f.country}`.toLowerCase().includes(filterQ)
      );
    }

    if (state.sortBy === "risk") {
      arr.sort((a, b) => b.nasaBaseline.droughtRiskScore - a.nasaBaseline.droughtRiskScore);
    } else if (state.sortBy === "area") {
      arr.sort((a, b) => b.defaultAreaHa - a.defaultAreaHa);
    } else if (state.sortBy === "name") {
      arr.sort((a, b) => a.name.localeCompare(b.name));
    }

    const totalHa = state.fields.reduce((s, f) => s + Number(f.defaultAreaHa || 0), 0);
    $("sidebarTotalHa").textContent = `${totalHa.toFixed(1)} ha \u00B7 ${state.fields.length} parcels`;
    $("headerParcelsLabel").textContent = `Parcels (${state.fields.length})`;

    if (!arr.length) {
      list.innerHTML = `<div class="panel-card" style="text-align:center;color:var(--ink-muted);">No matching local parcels. Pick a global place above or click the map.</div>`;
      return;
    }

    list.innerHTML = arr
      .map((f) => {
        const isActive = f.id === state.activeFieldId;
        const score = f.nasaBaseline.droughtRiskScore;
        const riskCls = score >= 68 ? "dot-high" : score >= 45 ? "dot-mod" : "dot-low";
        const prevCropName = DATA.crops[f.defaultPrevCrop]?.shortName || f.defaultPrevCrop;
        const badge = f.isDemo ? `<span class="tag-demo">Benchmark</span>` : `<span class="tag-custom">Saved</span>`;
        const delBtn = !f.isDemo
          ? `<button type="button" class="field-del-btn" data-del-id="${f.id}" title="Delete parcel">\u00D7</button>`
          : "";

        return `<div class="field-card ${isActive ? "is-active" : ""}" data-field-id="${f.id}" role="listitem" tabindex="0">
          <div class="field-thumb">${buildFieldThumbSvg(f.polygon)}</div>
          <div class="field-card-main">
            <div class="field-card-top">
              <span class="field-card-name">${escapeHtml(f.name)}</span>
              ${badge}
            </div>
            <div class="field-card-sub">${Number(f.defaultAreaHa).toFixed(1)} ha &middot; Prev: ${escapeHtml(prevCropName)}</div>
          </div>
          <div class="field-card-right">
            <span class="risk-dot-row" title="Drought risk ${score}/100"><i class="dot-risk ${riskCls}"></i>${score}</span>
            ${delBtn}
          </div>
        </div>`;
      })
      .join("");
  }

  function renderInspectorHeaderAndHud(field, recSim) {
    const eff = getEffectiveSoilAndField(field);
    const riskScore = field.nasaBaseline.droughtRiskScore;
    const riskBadge = $("inspectorRiskBadge");
    riskBadge.className = `risk-pill ${riskScore >= 68 ? "risk-high" : riskScore >= 45 ? "risk-mod" : "risk-low"}`;
    riskBadge.textContent = `Risk ${riskScore}/100`;

    $("inspectorFieldName").textContent = field.name;
    $("inspectorFieldMeta").textContent = `${Number(eff.areaHa).toFixed(1)} ha \u00B7 ${field.region}, ${field.country} \u00B7 ${eff.soil.shortName}`;

    $("hudFieldTitle").textContent = field.name;
    if (state.liveCurrent) {
      const t = state.liveCurrent.temperature_2m;
      const rain7d = state.liveForecast?.precipitation_sum
        ? state.liveForecast.precipitation_sum.reduce((a, b) => a + (b || 0), 0)
        : state.liveCurrent.precipitation || 0;
      const windMs = state.liveCurrent.wind_speed_10m != null ? (state.liveCurrent.wind_speed_10m / 3.6).toFixed(1) : "--";
      $("hudTempVal").textContent = `${t >= 0 ? "+" : ""}${Math.round(t)}\u00B0C`;
      $("hudPrecipVal").textContent = `${rain7d.toFixed(1)} mm`;
      $("hudWindVal").textContent = `${windMs} m/s`;
    } else {
      $("hudTempVal").textContent = state.telemetryLoading ? "..." : "--\u00B0C";
      $("hudPrecipVal").textContent = state.telemetryLoading ? "..." : "-- mm";
      $("hudWindVal").textContent = "-- m/s";
    }

    $("hudMoistureVal").textContent = `${field.nasaBaseline.rootMoisturePct}%`;
    $("hudSoilSummary").textContent = `AWC ${Math.round(eff.soil.waterHoldingMmPerM)} mm \u00B7 Plan ${recSim.compositeScore}/100`;
    renderTelemetryStatus();
  }

  function renderClimateTab(field) {
    const b = field.nasaBaseline;
    const eff = getEffectiveSoilAndField(field);

    $("kpiMoistureVal").textContent = state.telemetryLoading && !field.isDemo ? "..." : `${b.rootMoisturePct}%`;
    $("kpiMoistureSub").textContent = `${b.rootAvailableWaterMm} mm available / deep ${b.deepMoisturePct}%`;

    const balSign = b.seasonalWaterBalanceMm >= 0 ? "+" : "";
    $("kpiBalanceVal").textContent = state.telemetryLoading && !field.isDemo ? "..." : `${balSign}${b.seasonalWaterBalanceMm} mm`;
    $("kpiBalanceSub").textContent = `${b.annualPrecipMm} rain vs ${b.annualEtDemandMm} ET`;

    $("kpiAnomalyVal").textContent = `+${b.warmingAnomalyC}\u00B0C`;
    $("kpiAnomalySub").textContent = `${b.extremeHeatDays} days \u2265 30\u00B0C`;

    const fcStrip = $("liveForecastStrip");
    if (state.liveForecast?.time?.length) {
      fcStrip.innerHTML = state.liveForecast.time
        .slice(0, 7)
        .map((dateStr, i) => {
          const dt = new Date(`${dateStr}T12:00:00`);
          const dow = dt.toLocaleDateString("en-US", { weekday: "short" });
          const tmax = Math.round(state.liveForecast.temperature_2m_max[i] ?? 0);
          const pr = Number(state.liveForecast.precipitation_sum[i] ?? 0).toFixed(1);
          return `<div class="fc-day"><span class="fc-dow">${dow}</span><strong class="fc-temp">${tmax}\u00B0</strong><span class="fc-rain">${pr} mm</span></div>`;
        })
        .join("");
    } else {
      fcStrip.innerHTML = Array.from({ length: 7 }, (_, i) => `<div class="fc-day"><span class="fc-dow">D+${i + 1}</span><strong class="fc-temp">--\u00B0</strong><span class="fc-rain">-- mm</span></div>`).join("");
    }

    const sm0 = state.liveCurrent?.soil_moisture_0_to_1cm;
    const sm9 = state.liveCurrent?.soil_moisture_9_to_27cm;
    const sm27 = state.liveCurrent?.soil_moisture_27_to_81cm;
    $("soilDepthStrip").innerHTML = `
      <div class="depth-chip"><span>0\u20131 cm</span><strong>${sm0 != null ? Math.round(sm0 * 100) + "%" : "--"}</strong></div>
      <div class="depth-chip"><span>9\u201327 cm</span><strong>${sm9 != null ? Math.round(sm9 * 100) + "%" : "--"}</strong></div>
      <div class="depth-chip"><span>27\u201381 cm</span><strong>${sm27 != null ? Math.round(sm27 * 100) + "%" : "--"}</strong></div>
    `;

    const sg = state.liveSoilGrids;
    $("soilSourceTag").textContent = sg ? "SoilGrids v2.0 Live" : "Regional Reference";
    $("clayStatVal").textContent = `${sg?.clayPct ?? eff.soil.defaultClayPct}%`;
    $("sandStatVal").textContent = `${sg?.sandPct ?? eff.soil.defaultSandPct}%`;
    $("phStatVal").textContent = String(sg?.ph ?? eff.ph);
    $("somStatVal").textContent = `${sg?.somPct ?? eff.somPct}%`;

    $("soilTypeSelect").value = eff.soilTypeId;
    $("prevCropSelect").value = eff.prevCrop;
    $("fieldAreaInput").value = eff.areaHa;
    $("soilPhInput").value = eff.ph;
    $("somSlider").value = eff.somPct;
    $("somReadout").textContent = `${Number(eff.somPct).toFixed(1)}%`;

    $("fieldDiagnosisText").textContent = field.humanDiagnosis;
    drawClimateChart(field);
  }

  function renderRotationTab(field, recSim, tradSim) {
    $("rotationScoreBadge").textContent = `Plan Score ${recSim.compositeScore}/100`;

    const modeContainer = $("priorityModeGroup");
    modeContainer.innerHTML = Object.values(DATA.priorityModes)
      .map((m) => `<button type="button" class="preset-btn ${state.priorityMode === m.id ? "is-active" : ""}" data-mode="${m.id}">${escapeHtml(m.label)}</button>`)
      .join("");

    $("weightWaterSlider").value = state.weights.water;
    $("weightWaterVal").textContent = `${state.weights.water}%`;
    $("weightSoilSlider").value = state.weights.soil;
    $("weightSoilVal").textContent = `${state.weights.soil}%`;
    $("weightProfitSlider").value = state.weights.profit;
    $("weightProfitVal").textContent = `${state.weights.profit}%`;

    $("coverCropToggle").checked = state.useCoverCrop;
    $("coverCropSelect").value = state.coverCropId;
    $("coverCropSelect").disabled = !state.useCoverCrop;
    $("noTillToggle").checked = state.useNoTill;

    const waterDiff = recSim.avgWaterMm - tradSim.avgWaterMm;
    const profitDiff = recSim.totalMarginUsdHa - tradSim.totalMarginUsdHa;
    $("rotationDeltaNote").textContent = `vs. traditional (${tradSim.compositeScore}/100): ${waterDiff >= 0 ? "+" : ""}${waterDiff} mm root moisture avg \u00B7 ${profitDiff >= 0 ? "+" : ""}$${profitDiff}/ha over 4 years`;

    for (let yr = 0; yr < 4; yr += 1) {
      const sel = $(`year${yr + 1}Select`);
      const cropId = state.planSequence[yr] || "winter_wheat";
      sel.value = cropId;
      const crop = DATA.crops[cropId] || DATA.crops.winter_wheat;
      const simYr = recSim.yearly[yr];

      $(`ganttMeta${yr + 1}`).textContent = `${crop.rootDepthCm}cm \u00B7 ${crop.nitrogenBalanceKg >= 0 ? "+" : ""}${crop.nitrogenBalanceKg}kg N \u00B7 $${simYr.marginUsdHa}/ha`;

      const track = $(`ganttTrack${yr + 1}`);
      const grid = `<div class="gantt-grid-lines">${"<span></span>".repeat(12)}</div>`;
      const isCereal = crop.family.includes("Cereal") || crop.categoryBadge.includes("Cereal");
      const isLegume = crop.family.includes("Legume") || crop.categoryBadge.includes("Legume");
      const catCls = isCereal ? "cat-cereal" : isLegume ? "cat-legume" : "cat-oilseed";

      let barsHtml = "";
      if (!crop.overwinters) {
        const leftPct = ((crop.sowMonth - 1) / 12) * 100;
        const widthPct = ((crop.harvestMonth - crop.sowMonth + 1) / 12) * 100;
        barsHtml += `<div class="gantt-bar ${catCls}" style="left:${leftPct.toFixed(2)}%;width:${widthPct.toFixed(2)}%;" title="${escapeHtml(crop.shortName)} (${escapeHtml(crop.windowLabel)})">${escapeHtml(crop.shortName)}</div>`;
        if (state.useCoverCrop && crop.harvestMonth < 12) {
          const covLeft = (crop.harvestMonth / 12) * 100;
          const covW = ((12 - crop.harvestMonth) / 12) * 100;
          barsHtml += `<div class="gantt-bar cat-cover" style="left:${covLeft.toFixed(2)}%;width:${covW.toFixed(2)}%;" title="Winter Cover Crop">Cover</div>`;
        }
      } else {
        const springW = (crop.harvestMonth / 12) * 100;
        const fallLeft = ((crop.sowMonth - 1) / 12) * 100;
        const fallW = ((13 - crop.sowMonth) / 12) * 100;
        barsHtml += `<div class="gantt-bar ${catCls}" style="left:0%;width:${springW.toFixed(2)}%;" title="Harvest ${MONTHS[crop.harvestMonth - 1]}">${escapeHtml(crop.shortName)} Harvest</div>`;
        if (state.useCoverCrop && crop.harvestMonth + 1 < crop.sowMonth) {
          const gapLeft = (crop.harvestMonth / 12) * 100;
          const gapW = ((crop.sowMonth - 1 - crop.harvestMonth) / 12) * 100;
          barsHtml += `<div class="gantt-bar cat-cover" style="left:${gapLeft.toFixed(2)}%;width:${gapW.toFixed(2)}%;" title="Summer Catch Cover">Cover</div>`;
        }
        barsHtml += `<div class="gantt-bar ${catCls}" style="left:${fallLeft.toFixed(2)}%;width:${fallW.toFixed(2)}%;" title="Sow ${MONTHS[crop.sowMonth - 1]}">Sow</div>`;
      }

      track.innerHTML = grid + barsHtml;
    }

    $("agronomyAlerts").innerHTML = recSim.alerts
      .map((a) => `<div class="alert-row alert-${a.level}">${escapeHtml(a.text)}</div>`)
      .join("");
  }

  function renderImpactTab(field, recSim, tradSim) {
    const { areaHa } = getEffectiveSoilAndField(field);
    const waterDiffMm = recSim.avgWaterMm - tradSim.avgWaterMm;
    const marginDiffHa = recSim.totalMarginUsdHa - tradSim.totalMarginUsdHa;
    const totalParcelUsd = Math.round(marginDiffHa * areaHa);
    const somGainDiff = Number((recSim.somDelta - tradSim.somDelta).toFixed(2));
    const scoreDiff = recSim.compositeScore - tradSim.compositeScore;

    $("impactWaterDelta").textContent = `${waterDiffMm >= 0 ? "+" : ""}${waterDiffMm} mm`;
    $("impactWaterDelta").className = `kpi-val ${waterDiffMm >= 0 ? "kpi-green" : ""}`;
    $("impactWaterSub").textContent = `${recSim.avgWaterMm} mm vs ${tradSim.avgWaterMm} mm avg`;

    $("impactProfitDelta").textContent = `${marginDiffHa >= 0 ? "+" : ""}$${marginDiffHa}/ha`;
    $("impactProfitDelta").className = `kpi-val ${marginDiffHa >= 0 ? "kpi-green" : ""}`;
    $("impactProfitSub").textContent = `${totalParcelUsd >= 0 ? "+" : ""}$${totalParcelUsd.toLocaleString()} (${areaHa.toFixed(1)} ha)`;

    $("impactSomDelta").textContent = `${somGainDiff >= 0 ? "+" : ""}${somGainDiff}%`;
    $("impactSomSub").textContent = `End SOM ${recSim.endSomPct}% vs ${tradSim.endSomPct}%`;

    $("impactScoreDelta").textContent = `${scoreDiff >= 0 ? "+" : ""}${scoreDiff} pts`;
    $("impactScoreSub").textContent = `${recSim.compositeScore} vs ${tradSim.compositeScore} / 100`;

    $("comparisonTableBody").innerHTML = recSim.yearly
      .map((ry, i) => {
        const ty = tradSim.yearly[i];
        const mDiff = ry.marginUsdHa - ty.marginUsdHa;
        return `<tr>
          <td class="table-num">${ry.year}</td>
          <td><strong>${escapeHtml(ry.shortName)}</strong></td>
          <td style="color:var(--ink-muted)">${escapeHtml(ty.shortName)}</td>
          <td class="table-num">${ry.waterEndMm} mm <span style="color:var(--ink-muted)">(${ty.waterEndMm})</span></td>
          <td class="table-num"><strong>$${ry.marginUsdHa}</strong> <span style="color:${mDiff >= 0 ? "var(--accent)" : "var(--risk-red)"}">(${mDiff >= 0 ? "+" : ""}${mDiff})</span></td>
        </tr>`;
      })
      .join("");

    drawWaterChart(field, recSim, tradSim);
    drawProfitChart(recSim, tradSim);
  }

  function renderReportTab(field, recSim, tradSim) {
    const eff = getEffectiveSoilAndField(field);
    const cover = DATA.coverCropBridges[state.coverCropId];
    const modeObj = DATA.priorityModes[state.priorityMode];
    const waterDiff = recSim.avgWaterMm - tradSim.avgWaterMm;
    const marginDiffHa = recSim.totalMarginUsdHa - tradSim.totalMarginUsdHa;

    $("reportVerdictTitle").textContent = `${modeObj ? modeObj.label : "Custom"} — ${field.name}`;
    $("reportVerdictDesc").textContent = `Prescribed 4-year sequence improves root-zone moisture reserve by ${waterDiff >= 0 ? "+" : ""}${waterDiff} mm and delivers ${marginDiffHa >= 0 ? "+" : ""}$${marginDiffHa}/ha vs regional baseline.`;
    $("reportFieldMeta").textContent = `Parcel Area: ${eff.areaHa.toFixed(1)} ha \u00B7 Soil: ${eff.soil.name} (pH ${eff.ph}, SOM ${eff.somPct}%) \u00B7 Prev Crop: ${DATA.crops[eff.prevCrop]?.shortName}`;

    $("reportScheduleBody").innerHTML = recSim.yearly
      .map((ry) => {
        const c = DATA.crops[ry.cropId];
        return `<tr>
          <td class="table-num">${ry.year}</td>
          <td><strong>${escapeHtml(c.name)}</strong><br><span style="font-size:10.5px;color:var(--ink-muted)">${escapeHtml(c.windowLabel)}</span></td>
          <td>${state.useCoverCrop ? escapeHtml(cover.name) : "Bare fallow"}${state.useNoTill ? " + No-Till" : ""}</td>
          <td class="table-num">$${ry.marginUsdHa}</td>
          <td class="table-num">${ry.waterEndMm} mm</td>
        </tr>`;
      })
      .join("");

    const tasks = [
      `Establish ${DATA.crops[recSim.yearly[0].cropId].name} (${DATA.crops[recSim.yearly[0].cropId].windowLabel}) directly following ${DATA.crops[eff.prevCrop]?.name || eff.prevCrop} residue.`,
      state.useCoverCrop
        ? `Seed ${cover.name} immediately after harvest gaps to retain ~${cover.waterRetentionBonusMm || 20} mm moisture and supply +${cover.nBonusKg || 25} kg/ha N.`
        : "Monitor winter soil moisture evaporation monthly using NASA SMAP updates.",
      state.useNoTill
        ? "Maintain zero/strip-till stubble to shield topsoil temperature and boost rainwater infiltration."
        : "Minimize deep inversion passes prior to dry spring planting windows.",
      "Review Open-Meteo 7-day soil temperature before nitrogen side-dress applications."
    ];
    $("reportChecklist").innerHTML = tasks.map((t) => `<li>${escapeHtml(t)}</li>`).join("");
  }

  function buildPrintSheet() {
    const field = getActiveField();
    if (!field) return;
    const eff = getEffectiveSoilAndField(field);
    const recSim = simulateRotation(field, state.planSequence, state.useCoverCrop, state.coverCropId, state.useNoTill);
    const tradSim = simulateRotation(field, field.traditionalRotation, false, state.coverCropId, false);
    const cover = DATA.coverCropBridges[state.coverCropId];
    const totalUsd = Math.round((recSim.totalMarginUsdHa - tradSim.totalMarginUsdHa) * eff.areaHa);

    $("printSheet").innerHTML = `
      <div class="ps-header">
        <div>
          <h1 class="ps-title">Field Shift — 4-Year Agronomic Prescription</h1>
          <p class="ps-sub">${escapeHtml(field.name)} (${escapeHtml(field.region)}, ${escapeHtml(field.country)}) &middot; ${field.lat.toFixed(4)}, ${field.lon.toFixed(4)}</p>
        </div>
        <div style="text-align:right;font-size:10.5px;">
          <strong>Generated ${new Date().toISOString().slice(0, 10)}</strong><br>
          NASA POWER &amp; SMAP Verified
        </div>
      </div>

      <div class="ps-grid-4">
        <div class="ps-box"><span>Parcel Area</span><strong>${eff.areaHa.toFixed(1)} ha</strong></div>
        <div class="ps-box"><span>Soil Profile</span><strong>${escapeHtml(eff.soil.shortName)} (SOM ${eff.somPct}%)</strong></div>
        <div class="ps-box"><span>Avg Water Gain</span><strong>${recSim.avgWaterMm - tradSim.avgWaterMm >= 0 ? "+" : ""}${recSim.avgWaterMm - tradSim.avgWaterMm} mm</strong></div>
        <div class="ps-box"><span>4-Yr Parcel Profit &Delta;</span><strong>${totalUsd >= 0 ? "+" : ""}$${totalUsd.toLocaleString()}</strong></div>
      </div>

      <div class="ps-section-title">Prescribed Rotation Schedule (2027\u20132030)</div>
      <table class="ps-table">
        <thead>
          <tr><th>Season</th><th>Primary Crop</th><th>Sowing &amp; Harvest</th><th>Root Depth</th><th>Cover &amp; Practice</th><th>Water End</th><th>Net Margin / ha</th></tr>
        </thead>
        <tbody>
          ${recSim.yearly
            .map((ry, idx) => {
              const c = DATA.crops[ry.cropId];
              const ty = tradSim.yearly[idx];
              return `<tr>
                <td>${ry.year}</td>
                <td><strong>${escapeHtml(c.name)}</strong> (${c.family})</td>
                <td>${escapeHtml(c.windowLabel)}</td>
                <td>${c.rootDepthCm} cm</td>
                <td>${state.useCoverCrop ? escapeHtml(cover.name) : "None"}${state.useNoTill ? " / No-Till" : ""}</td>
                <td>${ry.waterEndMm} mm (vs ${ty.waterEndMm})</td>
                <td>$${ry.marginUsdHa} (vs $${ty.marginUsdHa})</td>
              </tr>`;
            })
            .join("")}
        </tbody>
      </table>

      <div class="ps-section-title">Agronomic Diagnostics &amp; Risk Controls</div>
      <ul style="margin:4px 0 10px;padding-left:16px;">
        ${recSim.alerts.map((a) => `<li>${escapeHtml(a.text)}</li>`).join("")}
      </ul>

      <div class="ps-footer">
        Field Shift Agronomic GIS Decision Support &middot; Models powered by NASA POWER Climatology, SMAP Root Moisture, Open-Meteo ECMWF &amp; ISRIC SoilGrids v2.0.
      </div>
    `;
  }

  function setupHiDPICanvas(canvas) {
    const rect = (canvas.parentElement || canvas).getBoundingClientRect();
    const cssW = Math.max(220, Math.floor(rect.width || 440));
    const cssH = Number(canvas.dataset.cssH) || 185;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;

    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w: cssW, h: cssH };
  }

  function attachChartHover(canvas, tooltipEl, formatter) {
    if (canvas._hoverBound) return;
    canvas._hoverBound = true;

    canvas.addEventListener("mousemove", (ev) => {
      const meta = canvas._chartMeta;
      if (!meta || !meta.items || !meta.items.length) return;
      const rect = canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left;

      let closest = null;
      let bestDist = Infinity;
      for (const item of meta.items) {
        const dist = Math.abs(x - item.x);
        if (dist < bestDist) {
          bestDist = dist;
          closest = item;
        }
      }
      if (!closest || bestDist > 42) {
        tooltipEl.classList.add("is-hidden");
        return;
      }
      tooltipEl.innerHTML = formatter(closest);
      tooltipEl.classList.remove("is-hidden");
      const tipX = clamp(closest.x - 45, 6, rect.width - 135);
      tooltipEl.style.left = `${tipX}px`;
      tooltipEl.style.top = "8px";
    });

    canvas.addEventListener("mouseleave", () => {
      tooltipEl.classList.add("is-hidden");
    });
  }

  function drawClimateChart(field) {
    const canvas = $("climateChart");
    if (!canvas || $("panelClimate").offsetParent === null) return;
    const { ctx, w, h } = setupHiDPICanvas(canvas);
    const pad = { top: 18, right: 12, bottom: 26, left: 36 };
    const cw = w - pad.left - pad.right;
    const ch = h - pad.top - pad.bottom;

    const rain = field.nasaBaseline.monthlyPrecipMm;
    const et = field.nasaBaseline.monthlyEtMm;
    const maxVal = Math.max(100, ...rain, ...et) * 1.12;

    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = "#E4E7EC";
    ctx.lineWidth = 1;
    ctx.font = "10px Inter, sans-serif";
    ctx.fillStyle = "#6B7280";

    for (let g = 0; g <= 3; g += 1) {
      const yVal = Math.round((maxVal * g) / 3);
      const y = pad.top + ch - (g / 3) * ch;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(w - pad.right, y);
      ctx.stroke();
      ctx.fillText(String(yVal), 4, y + 3);
    }

    const colW = cw / 12;
    const barW = Math.max(8, colW * 0.56);
    const hoverItems = [];
    const etPoints = [];

    for (let i = 0; i < 12; i += 1) {
      const cx = pad.left + i * colW + colW * 0.5;
      const barH = (rain[i] / maxVal) * ch;
      ctx.fillStyle = "rgba(14, 165, 233, 0.72)";
      ctx.beginPath();
      ctx.roundRect(cx - barW / 2, pad.top + ch - barH, barW, barH, [3, 3, 0, 0]);
      ctx.fill();

      const etY = pad.top + ch - (et[i] / maxVal) * ch;
      etPoints.push({ x: cx, y: etY });

      ctx.fillStyle = "#6B7280";
      ctx.textAlign = "center";
      ctx.fillText(MONTHS[i].slice(0, 1), cx, h - 8);

      hoverItems.push({ x: cx, label: MONTHS[i], rain: rain[i], et: et[i] });
    }
    ctx.textAlign = "left";

    ctx.strokeStyle = "#EA580C";
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    etPoints.forEach((p, idx) => {
      if (idx === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();

    for (const p of etPoints) {
      ctx.fillStyle = "#FFFFFF";
      ctx.strokeStyle = "#EA580C";
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    canvas._chartMeta = { items: hoverItems };
    attachChartHover(canvas, $("climateTooltip"), (it) => `<strong>${it.label}</strong><br>Rain: ${it.rain} mm &middot; ET: ${it.et} mm`);
  }

  function drawWaterChart(field, recSim, tradSim) {
    const canvas = $("waterChart");
    if (!canvas || $("panelImpact").offsetParent === null) return;
    const { ctx, w, h } = setupHiDPICanvas(canvas);
    const pad = { top: 18, right: 14, bottom: 26, left: 38 };
    const cw = w - pad.left - pad.right;
    const ch = h - pad.top - pad.bottom;

    const allVals = [
      field.nasaBaseline.rootAvailableWaterMm,
      ...recSim.yearly.map((y) => y.waterEndMm),
      ...tradSim.yearly.map((y) => y.waterEndMm)
    ];
    const maxVal = Math.max(120, ...allVals) * 1.12;
    const labels = ["Start", "2027", "2028", "2029", "2030"];
    const recSeries = [field.nasaBaseline.rootAvailableWaterMm, ...recSim.yearly.map((y) => y.waterEndMm)];
    const tradSeries = [field.nasaBaseline.rootAvailableWaterMm, ...tradSim.yearly.map((y) => y.waterEndMm)];

    ctx.clearRect(0, 0, w, h);
    ctx.font = "10px Inter, sans-serif";
    ctx.strokeStyle = "#E4E7EC";
    ctx.lineWidth = 1;

    for (let g = 0; g <= 3; g += 1) {
      const y = pad.top + ch - (g / 3) * ch;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(w - pad.right, y);
      ctx.stroke();
      ctx.fillStyle = "#6B7280";
      ctx.fillText(String(Math.round((maxVal * g) / 3)), 4, y + 3);
    }

    const stressY = pad.top + ch - (recSim.wiltingThresholdMm / maxVal) * ch;
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = "#DC2626";
    ctx.beginPath();
    ctx.moveTo(pad.left, stressY);
    ctx.lineTo(w - pad.right, stressY);
    ctx.stroke();
    ctx.fillStyle = "#DC2626";
    ctx.fillText("Stress floor", pad.left + 4, stressY - 4);
    ctx.restore();

    const stepX = cw / (labels.length - 1);
    const drawLine = (arr, stroke, width) => {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = width;
      ctx.beginPath();
      arr.forEach((v, idx) => {
        const px = pad.left + idx * stepX;
        const py = pad.top + ch - (v / maxVal) * ch;
        if (idx === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
    };

    drawLine(tradSeries, "#94A3B8", 2);
    drawLine(recSeries, "#15803D", 2.8);

    const hoverItems = [];
    labels.forEach((lbl, idx) => {
      const px = pad.left + idx * stepX;
      ctx.fillStyle = "#6B7280";
      ctx.textAlign = "center";
      ctx.fillText(lbl, px, h - 8);

      [
        { val: tradSeries[idx], c: "#94A3B8" },
        { val: recSeries[idx], c: "#15803D" }
      ].forEach((pt) => {
        const py = pad.top + ch - (pt.val / maxVal) * ch;
        ctx.fillStyle = pt.c;
        ctx.beginPath();
        ctx.arc(px, py, 3.5, 0, Math.PI * 2);
        ctx.fill();
      });

      hoverItems.push({ x: px, label: lbl, rec: recSeries[idx], trad: tradSeries[idx] });
    });
    ctx.textAlign = "left";

    canvas._chartMeta = { items: hoverItems };
    attachChartHover(canvas, $("waterTooltip"), (it) => `<strong>${it.label}</strong><br>Field Shift: ${it.rec} mm &middot; Trad: ${it.trad} mm`);
  }

  function drawProfitChart(recSim, tradSim) {
    const canvas = $("profitChart");
    if (!canvas || $("panelImpact").offsetParent === null) return;
    const { ctx, w, h } = setupHiDPICanvas(canvas);
    const pad = { top: 18, right: 14, bottom: 26, left: 42 };
    const cw = w - pad.left - pad.right;
    const ch = h - pad.top - pad.bottom;

    const recCum = [];
    const tradCum = [];
    let rAcc = 0;
    let tAcc = 0;
    for (let i = 0; i < 4; i += 1) {
      rAcc += recSim.yearly[i].marginUsdHa;
      tAcc += tradSim.yearly[i].marginUsdHa;
      recCum.push(rAcc);
      tradCum.push(tAcc);
    }

    const maxVal = Math.max(400, ...recCum, ...tradCum) * 1.15;
    ctx.clearRect(0, 0, w, h);
    ctx.font = "10px Inter, sans-serif";
    ctx.strokeStyle = "#E4E7EC";

    for (let g = 0; g <= 3; g += 1) {
      const y = pad.top + ch - (g / 3) * ch;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(w - pad.right, y);
      ctx.stroke();
      ctx.fillStyle = "#6B7280";
      ctx.fillText(`$${Math.round((maxVal * g) / 3)}`, 2, y + 3);
    }

    const colW = cw / 4;
    const barW = Math.min(26, colW * 0.3);
    const hoverItems = [];

    for (let i = 0; i < 4; i += 1) {
      const cx = pad.left + i * colW + colW * 0.5;
      const rH = Math.max(2, (recCum[i] / maxVal) * ch);
      const tH = Math.max(2, (tradCum[i] / maxVal) * ch);

      ctx.fillStyle = "#15803D";
      ctx.beginPath();
      ctx.roundRect(cx - barW - 2, pad.top + ch - rH, barW, rH, [3, 3, 0, 0]);
      ctx.fill();

      ctx.fillStyle = "#CBD5E1";
      ctx.beginPath();
      ctx.roundRect(cx + 2, pad.top + ch - tH, barW, tH, [3, 3, 0, 0]);
      ctx.fill();

      ctx.fillStyle = "#6B7280";
      ctx.textAlign = "center";
      ctx.fillText(String(2027 + i), cx, h - 8);

      hoverItems.push({ x: cx, year: 2027 + i, rec: recCum[i], trad: tradCum[i] });
    }
    ctx.textAlign = "left";

    canvas._chartMeta = { items: hoverItems };
    attachChartHover(canvas, $("profitTooltip"), (it) => `<strong>${it.year} Cumul.</strong><br>Field Shift: $${it.rec}/ha &middot; Trad: $${it.trad}/ha`);
  }

  function renderPortfolioModal() {
    let totalHa = 0;
    let totalMarginDeltaUsd = 0;
    let totalWaterGainWeighted = 0;

    const rowsHtml = state.fields
      .map((f) => {
        const plan = f.selectedPlan || getPresetSequence(f, state.priorityMode);
        const sim = simulateRotation(
          f,
          plan,
          f.useCoverCrop !== false,
          f.coverCropId || "rye_vetch",
          f.useNoTill !== false
        );
        const trad = simulateRotation(f, f.traditionalRotation, false, "rye_vetch", false);
        const area = Number(f.defaultAreaHa || 40);
        const wDiff = sim.avgWaterMm - trad.avgWaterMm;
        const pDiffTotal = Math.round((sim.totalMarginUsdHa - trad.totalMarginUsdHa) * area);
        totalHa += area;
        totalMarginDeltaUsd += pDiffTotal;
        totalWaterGainWeighted += wDiff * area;

        const seqNames = plan.map((id) => DATA.crops[id]?.shortName || id).join(" \u2192 ");
        return `<tr class="clickable-row" data-jump-field="${f.id}">
          <td><strong>${escapeHtml(f.name)}</strong></td>
          <td>${escapeHtml(f.country)}</td>
          <td class="table-num">${area.toFixed(1)}</td>
          <td class="table-num">${f.nasaBaseline.rootMoisturePct}%</td>
          <td style="font-size:11px;">${escapeHtml(seqNames)}</td>
          <td class="table-num" style="color:${wDiff >= 0 ? "var(--accent)" : "var(--risk-red)"}">${wDiff >= 0 ? "+" : ""}${wDiff} mm</td>
          <td class="table-num" style="color:${pDiffTotal >= 0 ? "var(--accent)" : "var(--risk-red)"}"><strong>${pDiffTotal >= 0 ? "+" : ""}$${pDiffTotal.toLocaleString()}</strong></td>
        </tr>`;
      })
      .join("");

    const avgWaterGain = totalHa ? Math.round(totalWaterGainWeighted / totalHa) : 0;
    $("portfolioSummaryStrip").innerHTML = `
      <div class="kpi-cell"><span class="kpi-label">Managed Area</span><strong class="kpi-val">${totalHa.toFixed(1)} ha</strong><span class="kpi-sub">${state.fields.length} parcels</span></div>
      <div class="kpi-cell"><span class="kpi-label">Weighted Water Gain</span><strong class="kpi-val kpi-green">${avgWaterGain >= 0 ? "+" : ""}${avgWaterGain} mm</strong><span class="kpi-sub">Root reserve delta</span></div>
      <div class="kpi-cell"><span class="kpi-label">4-Yr Portfolio Profit &Delta;</span><strong class="kpi-val kpi-green">${totalMarginDeltaUsd >= 0 ? "+" : ""}$${totalMarginDeltaUsd.toLocaleString()}</strong><span class="kpi-sub">Across all parcels</span></div>
      <div class="kpi-cell"><span class="kpi-label">Active Season</span><strong class="kpi-val">2027\u20132030</strong><span class="kpi-sub">Click any row to inspect</span></div>
    `;
    $("portfolioTableBody").innerHTML = rowsHtml;
  }

  function renderCropLibraryModal() {
    const q = $("cropSearchInput").value.trim().toLowerCase();
    const filter = $("cropSeasonFilter").value;
    const rows = Object.values(DATA.crops).filter((c) => {
      if (q && !`${c.name} ${c.family} ${c.summary}`.toLowerCase().includes(q)) return false;
      if (filter === "high" && c.droughtTolerance < 70) return false;
      if (filter === "winter" && !c.overwinters) return false;
      if (filter === "legume" && c.nitrogenBalanceKg <= 20) return false;
      return true;
    });

    $("cropMatrixTableBody").innerHTML = rows
      .map((c) => {
        const margin = c.baseRevenueUsdHa - c.baseCostUsdHa;
        return `<tr>
          <td><strong>${escapeHtml(c.name)}</strong><br><span style="font-size:10.5px;color:var(--ink-muted)">${escapeHtml(c.family)}</span></td>
          <td style="font-size:11px;">${escapeHtml(c.windowLabel)}</td>
          <td class="table-num">${c.waterNeedMm} mm</td>
          <td class="table-num">${c.rootDepthCm} cm</td>
          <td class="table-num">${c.nitrogenBalanceKg >= 0 ? "+" : ""}${c.nitrogenBalanceKg} kg</td>
          <td class="table-num">${c.heatLimitC}\u00B0C</td>
          <td class="table-num">${c.droughtTolerance}/100</td>
          <td class="table-num"><strong>$${margin}</strong></td>
        </tr>`;
      })
      .join("");
  }

  function renderScienceModal() {
    $("scienceSourcesGrid").innerHTML = DATA.nasaSources
      .map((s) => `<div class="science-card">
        <span class="science-code">${escapeHtml(s.code)} &middot; ${escapeHtml(s.resolution)}</span>
        <h4>${escapeHtml(s.title)}</h4>
        <p>${escapeHtml(s.parameter)} \u2014 ${escapeHtml(s.role)}</p>
      </div>`)
      .join("");
  }

  function renderAll() {
    const field = getActiveField();
    if (!field) return;
    const recSim = simulateRotation(field, state.planSequence, state.useCoverCrop, state.coverCropId, state.useNoTill);
    const tradSim = simulateRotation(field, field.traditionalRotation, false, state.coverCropId, false);

    renderSidebarFields();
    renderInspectorHeaderAndHud(field, recSim);
    renderClimateTab(field);
    renderRotationTab(field, recSim, tradSim);
    renderImpactTab(field, recSim, tradSim);
    renderReportTab(field, recSim, tradSim);
  }

  function setActiveTab(tabName) {
    state.activeTab = tabName;
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      const isMatch = btn.dataset.tab === tabName;
      btn.classList.toggle("is-active", isMatch);
      btn.setAttribute("aria-selected", String(isMatch));
    });
    document.querySelectorAll(".tab-panel").forEach((panel) => {
      panel.classList.toggle("is-active", panel.id === `panel${tabName.charAt(0).toUpperCase()}${tabName.slice(1)}`);
    });

    const field = getActiveField();
    if (!field) return;
    if (tabName === "climate") {
      requestAnimationFrame(() => drawClimateChart(field));
    } else if (tabName === "impact") {
      const recSim = simulateRotation(field, state.planSequence, state.useCoverCrop, state.coverCropId, state.useNoTill);
      const tradSim = simulateRotation(field, field.traditionalRotation, false, state.coverCropId, false);
      requestAnimationFrame(() => {
        drawWaterChart(field, recSim, tradSim);
        drawProfitChart(recSim, tradSim);
      });
    }
  }

  function populateStaticSelects() {
    const soilOpts = Object.values(DATA.soilTypes)
      .map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`)
      .join("");
    $("soilTypeSelect").innerHTML = soilOpts;

    const cropOpts = Object.values(DATA.crops)
      .map((c) => `<option value="${c.id}">${escapeHtml(c.name)} (${c.categoryBadge})</option>`)
      .join("");
    $("prevCropSelect").innerHTML = cropOpts;
    $("newFieldPrevCropSelect").innerHTML = cropOpts;
    for (let y = 1; y <= 4; y += 1) {
      $(`year${y}Select`).innerHTML = Object.values(DATA.crops)
        .map((c) => `<option value="${c.id}">${escapeHtml(c.shortName)} \u2014 ${c.categoryBadge}</option>`)
        .join("");
    }

    $("coverCropSelect").innerHTML = Object.values(DATA.coverCropBridges)
      .map((cb) => `<option value="${cb.id}">${escapeHtml(cb.name)}</option>`)
      .join("");
  }

  function handleGeoJsonImport(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const json = JSON.parse(String(ev.target.result));
        let coords = null;
        let propName = file.name.replace(/\.(geo)?json$/i, "");

        const extractRing = (geom) => {
          if (!geom) return null;
          if (geom.type === "Polygon" && geom.coordinates?.[0]) return geom.coordinates[0];
          if (geom.type === "MultiPolygon" && geom.coordinates?.[0]?.[0]) return geom.coordinates[0][0];
          return null;
        };

        if (json.type === "FeatureCollection" && json.features?.length) {
          const feat = json.features[0];
          coords = extractRing(feat.geometry);
          propName = feat.properties?.name || feat.properties?.title || propName;
        } else if (json.type === "Feature") {
          coords = extractRing(json.geometry);
          propName = json.properties?.name || propName;
        } else {
          coords = extractRing(json);
        }

        if (!coords || coords.length < 3) {
          showToast("No valid Polygon geometry found in GeoJSON");
          return;
        }

        const latlngs = coords.map(([lon, lat]) => [Number(lat), Number(lon)]);
        if (latlngs.length > 3) {
          const first = latlngs[0];
          const last = latlngs[latlngs.length - 1];
          if (Math.abs(first[0] - last[0]) < 1e-6 && Math.abs(first[1] - last[1]) < 1e-6) {
            latlngs.pop();
          }
        }

        const [centLat, centLon] = computePolygonCentroid(latlngs);
        const areaHa = computePolygonAreaHa(latlngs);
        const importedField = buildCustomFieldObject(propName, centLat, centLon, latlngs, null);
        importedField.defaultAreaHa = areaHa;

        state.fields.unshift(importedField);
        state.activeFieldId = importedField.id;
        state.overrides = null;
        state.planSequence = [...importedField.selectedPlan];
        saveFieldsToStorage();
        renderAll();
        renderFieldPolygons(true);
        await syncActiveFieldTelemetry(true);
        showToast(`Imported "${propName}" (${areaHa.toFixed(1)} ha)`);
      } catch (_err) {
        showToast("Invalid GeoJSON file");
      }
    };
    reader.readAsText(file);
  }

  async function runGlobalSearch(rawQuery) {
    const q = rawQuery.trim();
    const box = $("searchSuggestions");
    if (q.length < 2) {
      box.classList.add("is-hidden");
      return;
    }

    const lower = q.toLowerCase();
    const mappedQuery = UK_ALIAS_MAP[lower] || q;

    const localMatches = state.fields.filter((f) =>
      `${f.name} ${f.region} ${f.country}`.toLowerCase().includes(lower) ||
      `${f.name} ${f.region} ${f.country}`.toLowerCase().includes(mappedQuery.toLowerCase())
    );

    let itemsHtml = localMatches
      .slice(0, 4)
      .map((f) => `<button type="button" class="search-item" data-local-id="${f.id}">
        <span class="search-item-title">${escapeHtml(f.name)}</span>
        <span class="search-item-sub">Saved parcel &middot; ${escapeHtml(f.country)} (${f.defaultAreaHa} ha)</span>
      </button>`)
      .join("");

    try {
      const geoUrl = `https://nominatim.openstreetmap.org/search?format=json&accept-language=en,uk&limit=4&q=${encodeURIComponent(mappedQuery)}`;
      const results = await fetchWithTimeout(geoUrl, 4500);
      if (Array.isArray(results) && results.length) {
        itemsHtml += results
          .map((r) => {
            const label = r.display_name.split(",").slice(0, 2).join(", ");
            return `<button type="button" class="search-item" data-geo-lat="${r.lat}" data-geo-lon="${r.lon}" data-geo-name="${escapeHtml(label)}">
              <span class="search-item-title">${escapeHtml(label)}</span>
              <span class="search-item-sub">Sample Open-Meteo + NASA POWER here (${Number(r.lat).toFixed(2)}, ${Number(r.lon).toFixed(2)})</span>
            </button>`;
          })
          .join("");
      }
    } catch (_err) {
      if (!itemsHtml) {
        itemsHtml = `<div class="search-item"><span class="search-item-sub">Location lookup offline — try clicking map directly</span></div>`;
      }
    }

    if (!itemsHtml) {
      box.classList.add("is-hidden");
      return;
    }
    box.innerHTML = itemsHtml;
    box.classList.remove("is-hidden");
  }

  function exportPlanJson() {
    const field = getActiveField();
    const eff = getEffectiveSoilAndField(field);
    const recSim = simulateRotation(field, state.planSequence, state.useCoverCrop, state.coverCropId, state.useNoTill);
    const payload = {
      exportedAt: new Date().toISOString(),
      field: { name: field.name, lat: field.lat, lon: field.lon, areaHa: eff.areaHa, polygon: field.polygon },
      soil: eff.soil.name,
      somPct: eff.somPct,
      ph: eff.ph,
      planSequence: state.planSequence,
      coverCrop: state.useCoverCrop ? state.coverCropId : null,
      noTill: state.useNoTill,
      simulation: recSim
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${field.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-rotation.json`;
    a.click();
    showToast("Downloaded field rotation JSON");
  }

  function exportPlanCsv() {
    const field = getActiveField();
    const recSim = simulateRotation(field, state.planSequence, state.useCoverCrop, state.coverCropId, state.useNoTill);
    const lines = ["Year,Crop,Window,YieldFactor,WaterEndMm,NitrogenCarryKg,NetMarginUsdHa"];
    for (const ry of recSim.yearly) {
      const c = DATA.crops[ry.cropId];
      lines.push(`${ry.year},"${c.name}","${c.windowLabel}",${ry.yieldFactor},${ry.waterEndMm},${ry.nCarryKg},${ry.marginUsdHa}`);
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${field.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-schedule.csv`;
    a.click();
    showToast("Downloaded 4-year CSV schedule");
  }

  function triggerPrintReport() {
    buildPrintSheet();
    setTimeout(() => window.print(), 80);
  }

  function bindEvents() {
    const shell = $("appShell");

    const redrawVisibleCharts = () => {
      const f = getActiveField();
      if (!f) return;
      if (state.activeTab === "climate") drawClimateChart(f);
      else if (state.activeTab === "impact") {
        const recSim = simulateRotation(f, state.planSequence, state.useCoverCrop, state.coverCropId, state.useNoTill);
        const tradSim = simulateRotation(f, f.traditionalRotation, false, state.coverCropId, false);
        drawWaterChart(f, recSim, tradSim);
        drawProfitChart(recSim, tradSim);
      }
    };

    const setTopNavActive = (id) => {
      document.querySelectorAll(".top-nav-btn").forEach((b) => {
        b.classList.toggle("is-active", b.id === id);
      });
    };

    const toggleSidebar = (collapsed) => {
      shell.classList.toggle("sidebar-collapsed", collapsed);
      setTimeout(() => {
        if (map) map.invalidateSize();
      }, 210);
    };

    const toggleInspector = (collapsed) => {
      shell.classList.toggle("inspector-collapsed", collapsed);
      $("inspectorExpandTab").classList.toggle("is-hidden", !collapsed);
      setTimeout(() => {
        if (map) map.invalidateSize();
        redrawVisibleCharts();
      }, 210);
    };

    $("collapseSidebarBtn").addEventListener("click", () => toggleSidebar(true));
    $("sidebarExpandTab").addEventListener("click", () => {
      toggleSidebar(!shell.classList.contains("sidebar-collapsed"));
    });
    $("collapseInspectorBtn").addEventListener("click", () => toggleInspector(true));
    $("inspectorExpandTab").addEventListener("click", () => toggleInspector(false));

    $("railWorkspaceBtn").addEventListener("click", () => {
      toggleSidebar(!shell.classList.contains("sidebar-collapsed"));
    });
    $("railMapBtn").addEventListener("click", () => {
      document.querySelectorAll(".modal-backdrop").forEach((m) => m.classList.add("is-hidden"));
      setTopNavActive("railMapBtn");
    });
    $("railPortfolioBtn").addEventListener("click", () => {
      renderPortfolioModal();
      $("portfolioModal").classList.remove("is-hidden");
      setTopNavActive("railPortfolioBtn");
    });
    $("railCropsBtn").addEventListener("click", () => {
      renderCropLibraryModal();
      $("cropLibraryModal").classList.remove("is-hidden");
      setTopNavActive("railCropsBtn");
    });
    $("railScienceBtn").addEventListener("click", () => {
      renderScienceModal();
      $("scienceModal").classList.remove("is-hidden");
      setTopNavActive("railScienceBtn");
    });
    $("railPrintBtn").addEventListener("click", triggerPrintReport);

    const closeAllModals = () => {
      document.querySelectorAll(".modal-backdrop").forEach((m) => m.classList.add("is-hidden"));
      setTopNavActive("railMapBtn");
    };

    $("closePortfolioBtn").addEventListener("click", closeAllModals);
    $("closeCropLibraryBtn").addEventListener("click", closeAllModals);
    $("closeScienceBtn").addEventListener("click", closeAllModals);

    document.querySelectorAll(".modal-backdrop").forEach((backdrop) => {
      backdrop.addEventListener("click", (ev) => {
        if (ev.target === backdrop && backdrop.id !== "nameFieldModal") {
          closeAllModals();
        }
      });
    });

    $("portfolioTableBody").addEventListener("click", (ev) => {
      const tr = ev.target.closest("tr[data-jump-field]");
      if (!tr) return;
      closeAllModals();
      selectField(tr.dataset.jumpField, true);
    });

    $("cropSearchInput").addEventListener("input", renderCropLibraryModal);
    $("cropSeasonFilter").addEventListener("change", renderCropLibraryModal);

    $("fieldSortSelect").addEventListener("change", (ev) => {
      state.sortBy = ev.target.value;
      renderSidebarFields();
    });

    $("fieldList").addEventListener("click", (ev) => {
      const delBtn = ev.target.closest("[data-del-id]");
      if (delBtn) {
        ev.stopPropagation();
        const delId = delBtn.dataset.delId;
        state.fields = state.fields.filter((f) => f.id !== delId);
        if (state.activeFieldId === delId) {
          state.activeFieldId = state.fields[0]?.id || null;
        }
        saveFieldsToStorage();
        renderAll();
        renderFieldPolygons(true);
        showToast("Removed saved parcel");
        return;
      }
      const card = ev.target.closest("[data-field-id]");
      if (card) selectField(card.dataset.fieldId, true);
    });

    $("locationSearchInput").addEventListener("input", (ev) => {
      const val = ev.target.value;
      $("locationSearchClear").classList.toggle("is-hidden", !val);
      renderSidebarFields();
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => runGlobalSearch(val), 360);
    });

    $("locationSearchClear").addEventListener("click", () => {
      $("locationSearchInput").value = "";
      $("locationSearchClear").classList.add("is-hidden");
      $("searchSuggestions").classList.add("is-hidden");
      renderSidebarFields();
    });

    $("searchSuggestions").addEventListener("click", async (ev) => {
      const item = ev.target.closest(".search-item");
      if (!item) return;
      $("searchSuggestions").classList.add("is-hidden");
      if (item.dataset.localId) {
        selectField(item.dataset.localId, true);
      } else if (item.dataset.geoLat && item.dataset.geoLon) {
        const lat = Number(item.dataset.geoLat);
        const lon = Number(item.dataset.geoLon);
        const name = item.dataset.geoName || "Searched Site";
        map.setView([lat, lon], 12);
        const bundle = await fetchRawBundle(lat, lon);
        const poly = createRectPolygon(lat, lon, 38);
        const newField = buildCustomFieldObject(name, lat, lon, poly, bundle);
        state.fields.unshift(newField);
        state.activeFieldId = newField.id;
        state.overrides = null;
        state.planSequence = [...newField.selectedPlan];
        state.liveCurrent = bundle.meteo?.current || null;
        state.liveForecast = bundle.meteo?.daily || null;
        state.liveSoilGrids = bundle.soilGrids || null;
        state.livePowerStats = bundle.power || null;
        saveFieldsToStorage();
        renderAll();
        renderFieldPolygons(true);
      }
    });

    document.addEventListener("click", (ev) => {
      if (!ev.target.closest(".sidebar-search-wrap")) {
        $("searchSuggestions").classList.add("is-hidden");
      }
    });

    $("btnDrawField").addEventListener("click", () => startDrawingPolygon(null));
    $("redrawPolygonBtn").addEventListener("click", () => {
      const field = getActiveField();
      if (field) startDrawingPolygon(field.id);
    });
    $("drawUndoBtn").addEventListener("click", () => {
      state.drawPoints.pop();
      renderDrawingOverlay();
    });
    $("drawCancelBtn").addEventListener("click", cancelDrawingPolygon);
    $("drawFinishBtn").addEventListener("click", finishDrawingPolygon);

    $("confirmNewFieldBtn").addEventListener("click", confirmSaveNewField);
    $("cancelNewFieldBtn").addEventListener("click", () => {
      pendingDrawnData = null;
      $("nameFieldModal").classList.add("is-hidden");
    });

    $("btnImportGeo").addEventListener("click", () => $("geoImportInput").click());
    $("geoImportInput").addEventListener("change", (ev) => {
      handleGeoJsonImport(ev.target.files?.[0]);
      ev.target.value = "";
    });

    $("layerSatBtn").addEventListener("click", () => {
      state.basemap = "sat";
      $("layerSatBtn").classList.add("is-active");
      $("layerTerBtn").classList.remove("is-active");
      if (map.hasLayer(layerTer)) map.removeLayer(layerTer);
      if (!map.hasLayer(layerSat)) layerSat.addTo(map);
    });

    $("layerTerBtn").addEventListener("click", () => {
      state.basemap = "ter";
      $("layerTerBtn").classList.add("is-active");
      $("layerSatBtn").classList.remove("is-active");
      if (map.hasLayer(layerSat)) map.removeLayer(layerSat);
      if (!map.hasLayer(layerTer)) layerTer.addTo(map);
    });

    $("toggleLabelsBtn").addEventListener("click", () => {
      state.showLabels = !state.showLabels;
      $("toggleLabelsBtn").classList.toggle("is-active", state.showLabels);
      if (state.showLabels) layerLabels.addTo(map);
      else map.removeLayer(layerLabels);
    });

    $("toggleZonesBtn").addEventListener("click", () => {
      state.showZones = !state.showZones;
      $("toggleZonesBtn").classList.toggle("is-active", state.showZones);
      $("mapZonesLegend").classList.toggle("is-hidden", !state.showZones);
      renderZonesOverlay();
    });

    $("toggleAllFieldsBtn").addEventListener("click", () => {
      const coords = state.fields.map((f) => [f.lat, f.lon]);
      if (coords.length) map.fitBounds(coords, { padding: [50, 50], maxZoom: 6 });
    });

    $("editFieldNameBtn").addEventListener("click", () => {
      const field = getActiveField();
      if (!field) return;
      const next = window.prompt("Parcel name:", field.name);
      if (next && next.trim()) {
        field.name = next.trim();
        saveFieldsToStorage();
        renderAll();
        renderFieldPolygons(false);
      }
    });

    $("syncTelemetryBtn").addEventListener("click", () => {
      syncActiveFieldTelemetry(true);
      showToast("Refreshing live NASA POWER, Open-Meteo & SoilGrids...");
    });
    $("exportPlanBtn").addEventListener("click", exportPlanJson);
    $("reportExportJsonBtn").addEventListener("click", exportPlanJson);
    $("reportExportCsvBtn").addEventListener("click", exportPlanCsv);
    $("printPlanBtn").addEventListener("click", triggerPrintReport);
    $("reportPrintBtn").addEventListener("click", triggerPrintReport);

    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => setActiveTab(btn.dataset.tab));
    });

    const applyOverride = (key, val) => {
      if (!state.overrides) state.overrides = {};
      state.overrides[key] = val;
      renderAll();
    };

    $("soilTypeSelect").addEventListener("change", (ev) => applyOverride("soilTypeId", ev.target.value));
    $("prevCropSelect").addEventListener("change", (ev) => applyOverride("prevCrop", ev.target.value));
    $("fieldAreaInput").addEventListener("input", (ev) => applyOverride("areaHa", clamp(Number(ev.target.value) || 40, 0.5, 20000)));
    $("soilPhInput").addEventListener("input", (ev) => applyOverride("ph", clamp(Number(ev.target.value) || 6.6, 4.2, 8.8)));
    $("somSlider").addEventListener("input", (ev) => applyOverride("somPct", Number(ev.target.value)));
    $("resetOverridesBtn").addEventListener("click", () => {
      state.overrides = null;
      renderAll();
      showToast("Restored parcel SoilGrids defaults");
    });

    $("priorityModeGroup").addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-mode]");
      if (!btn) return;
      const modeId = btn.dataset.mode;
      const mode = DATA.priorityModes[modeId];
      if (!mode) return;
      state.priorityMode = modeId;
      state.weights = { ...mode.weights };
      const field = getActiveField();
      state.planSequence = getPresetSequence(field, modeId);
      field.selectedPlan = [...state.planSequence];
      saveFieldsToStorage();
      renderAll();
    });

    const onWeightChange = (key, val) => {
      state.weights[key] = Number(val);
      renderAll();
    };
    $("weightWaterSlider").addEventListener("input", (ev) => onWeightChange("water", ev.target.value));
    $("weightSoilSlider").addEventListener("input", (ev) => onWeightChange("soil", ev.target.value));
    $("weightProfitSlider").addEventListener("input", (ev) => onWeightChange("profit", ev.target.value));

    $("coverCropToggle").addEventListener("change", (ev) => {
      state.useCoverCrop = ev.target.checked;
      getActiveField().useCoverCrop = state.useCoverCrop;
      saveFieldsToStorage();
      renderAll();
    });
    $("coverCropSelect").addEventListener("change", (ev) => {
      state.coverCropId = ev.target.value;
      getActiveField().coverCropId = state.coverCropId;
      saveFieldsToStorage();
      renderAll();
    });
    $("noTillToggle").addEventListener("change", (ev) => {
      state.useNoTill = ev.target.checked;
      getActiveField().useNoTill = state.useNoTill;
      saveFieldsToStorage();
      renderAll();
    });

    for (let y = 0; y < 4; y += 1) {
      $(`year${y + 1}Select`).addEventListener("change", (ev) => {
        state.planSequence[y] = ev.target.value;
        getActiveField().selectedPlan = [...state.planSequence];
        saveFieldsToStorage();
        renderAll();
      });
    }

    $("autoOptimizeBtn").addEventListener("click", autoOptimizeRotation);
    $("saveFieldPlanBtn").addEventListener("click", () => {
      const f = getActiveField();
      f.selectedPlan = [...state.planSequence];
      f.coverCropId = state.coverCropId;
      f.useCoverCrop = state.useCoverCrop;
      f.useNoTill = state.useNoTill;
      if (state.overrides) {
        if (state.overrides.soilTypeId) f.defaultSoilType = state.overrides.soilTypeId;
        if (state.overrides.prevCrop) f.defaultPrevCrop = state.overrides.prevCrop;
        if (state.overrides.areaHa != null) f.defaultAreaHa = state.overrides.areaHa;
        if (state.overrides.somPct != null) f.defaultSomPct = state.overrides.somPct;
        if (state.overrides.ph != null) f.defaultSoilPh = state.overrides.ph;
        state.overrides = null;
      }
      saveFieldsToStorage();
      renderAll();
      showToast(`Saved 4-yr plan & overrides to ${f.name}`);
    });

    window.addEventListener("beforeprint", buildPrintSheet);
    window.addEventListener("resize", redrawVisibleCharts);
  }

  function init() {
    populateStaticSelects();
    loadStoredFields();
    initMap();
    bindEvents();
    selectField(state.activeFieldId, true);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
