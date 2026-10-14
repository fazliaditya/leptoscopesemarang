
from pathlib import Path
from copy import deepcopy
from datetime import datetime, timezone, timedelta
import json

import joblib
import numpy as np
import pandas as pd
from fastapi import FastAPI, Query, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from backend.simulation_v4 import build_annual_simulation
from backend.realtime_v5 import build_realtime_prediction
from backend.timeseries_v6 import (
    available_history_years,
    build_history_payload,
)
from backend.live_data_upload import (
    validate_upload,
    apply_upload,
    live_status,
    build_template_xlsx,
    template_filename,
)

PROJECT_DIR = Path(__file__).resolve().parents[1]
DIST_DIR = PROJECT_DIR / "dist"
DATA_DIR = DIST_DIR / "data"
MODEL_DIR = PROJECT_DIR / "model"
DATASET_DIR = PROJECT_DIR / "data"
LIVE_DIR = PROJECT_DIR / "data_live"
STATIC_DIR = PROJECT_DIR / "data_static"

MODEL_PATH = MODEL_DIR / "leptoscope_selected_model.pkl"
DATASET_PATH = DATASET_DIR / "leptoscope_model_dataset.csv"

BASE_MAP_PATH = (
    DATA_DIR / "risk_kecamatan_2023.geojson"
)

POPULATION_PATH = (
    STATIC_DIR / "population_semarang_2025_2026.csv"
)

bundle = joblib.load(MODEL_PATH)
model_df = pd.read_csv(DATASET_PATH)
population_updates = (
    pd.read_csv(POPULATION_PATH)
    if POPULATION_PATH.exists()
    else pd.DataFrame()
)

if isinstance(bundle, dict):
    model = next(
        value for value in bundle.values()
        if hasattr(value, "predict_proba")
    )

    feature_names = None

    for key in [
        "features",
        "feature_names",
        "feature_columns",
        "predictors",
        "selected_features"
    ]:
        if key in bundle:
            feature_names = list(bundle[key])
            break
else:
    model = bundle
    feature_names = list(model.feature_names_in_)

if feature_names is None:
    feature_names = list(model.feature_names_in_)

threshold = 0.12

if isinstance(bundle, dict):
    for key, value in bundle.items():
        if "threshold" in key.lower() and np.isscalar(value):
            threshold = float(value)
            break

model_df["date"] = pd.to_datetime(
    model_df["date"],
    errors="coerce"
)

model_df["target_date"] = pd.to_datetime(
    model_df["target_date"],
    errors="coerce"
)

with open(BASE_MAP_PATH, encoding="utf-8") as file:
    base_geojson = json.load(file)

positive_index = list(model.classes_).index(1)

MONTH_NAMES = {
    1: "Januari",
    2: "Februari",
    3: "Maret",
    4: "April",
    5: "Mei",
    6: "Juni",
    7: "Juli",
    8: "Agustus",
    9: "September",
    10: "Oktober",
    11: "November",
    12: "Desember"
}

app = FastAPI(
    title="LeptoScope Simulation API",
    version="6.2.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"]
)

def normalize_code(value):
    return str(value or "").strip().replace(" ", "")

def normalize_name(value):
    return " ".join(
        str(value or "")
        .lower()
        .strip()
        .split()
    )

def get_month_baseline(target_month):
    rows = model_df[
        (model_df["target_date"].dt.year == 2023)
        & (model_df["target_date"].dt.month == target_month)
    ].copy()

    rows = (
        rows.sort_values("date")
        .groupby("kecamatan_code", as_index=False)
        .tail(1)
        .copy()
    )

    if rows.empty:
        raise HTTPException(
            status_code=404,
            detail="Data bulan target tidak ditemukan."
        )

    missing = [
        column for column in feature_names
        if column not in rows.columns
    ]

    if missing:
        raise HTTPException(
            status_code=500,
            detail=f"Fitur tidak tersedia: {missing}"
        )

    rows["baseline_risk_score"] = (
        model.predict_proba(
            rows[feature_names]
        )[:, positive_index]
    )

    return rows

@app.get("/api/health")
def health():
    return {
        "status": "aktif",
        "version": "6.2.0",
        "model": type(model).__name__,
        "threshold": threshold,
        "mode": "evaluasi historis 2018-2023, simulasi, dan pemantauan eksperimental"
    }

@app.get("/api/simulate")
def simulate(
    target_month: int = Query(1, ge=1, le=12),
    target_district: str = Query("ALL"),
    rainfall_change_percent: float = Query(
        0, ge=-50, le=100
    ),
    humidity_change_point: float = Query(
        0, ge=-20, le=20
    ),
    temperature_change_c: float = Query(
        0, ge=-3, le=3
    ),
    additional_cases: int = Query(
        0, ge=0, le=20
    )
):
    scenario = get_month_baseline(target_month)

    district_names = (
        scenario["kecamatan_name"]
        .dropna()
        .astype(str)
        .sort_values()
        .unique()
        .tolist()
    )

    target_normalized = normalize_name(target_district)

    if target_normalized in {
        "",
        "all",
        "semua",
        "semua kecamatan"
    }:
        mask = pd.Series(
            True,
            index=scenario.index
        )
        target_label = "Semua Kecamatan"
    else:
        name_mask = (
            scenario["kecamatan_name"]
            .map(normalize_name)
            == target_normalized
        )

        code_mask = (
            scenario["kecamatan_code"]
            .map(normalize_code)
            == normalize_code(target_district)
        )

        mask = name_mask | code_mask

        if not mask.any():
            raise HTTPException(
                status_code=404,
                detail="Kecamatan target tidak ditemukan."
            )

        target_label = str(
            scenario.loc[mask, "kecamatan_name"].iloc[0]
        )

    # Curah hujan hanya pada wilayah target
    if "rainfall_mm" in scenario.columns:
        rainfall_initial = scenario.loc[
            mask, "rainfall_mm"
        ].copy()

        rainfall_new = (
            rainfall_initial
            * (1 + rainfall_change_percent / 100)
        ).clip(lower=0)

        scenario.loc[mask, "rainfall_mm"] = rainfall_new

        if "rainfall_3m_mean" in scenario.columns:
            scenario.loc[mask, "rainfall_3m_mean"] += (
                rainfall_new - rainfall_initial
            ) / 3

    # Kelembapan hanya pada wilayah target
    if "humidity_pct" in scenario.columns:
        scenario.loc[mask, "humidity_pct"] = (
            scenario.loc[mask, "humidity_pct"]
            + humidity_change_point
        ).clip(0, 100)

        if "humidity_3m_mean" in scenario.columns:
            scenario.loc[mask, "humidity_3m_mean"] = (
                scenario.loc[mask, "humidity_3m_mean"]
                + humidity_change_point / 3
            ).clip(0, 100)

    # Suhu hanya pada wilayah target
    if "temperature_c" in scenario.columns:
        scenario.loc[mask, "temperature_c"] += (
            temperature_change_c
        )

        if "temperature_3m_mean" in scenario.columns:
            scenario.loc[mask, "temperature_3m_mean"] += (
                temperature_change_c / 3
            )

    # Tambahan kasus hanya pada wilayah target
    if "case_count" in scenario.columns:
        scenario.loc[mask, "case_count"] += (
            additional_cases
        )

    scenario["risk_score"] = (
        model.predict_proba(
            scenario[feature_names]
        )[:, positive_index]
    )

    scenario["risk_delta"] = (
        scenario["risk_score"]
        - scenario["baseline_risk_score"]
    )

    denominator = (
        scenario["baseline_risk_score"]
        .replace(0, np.nan)
    )

    scenario["risk_change_percent"] = (
        scenario["risk_delta"]
        / denominator
        * 100
    ).fillna(0)

    scenario["status_peringatan"] = np.where(
        scenario["risk_score"] >= threshold,
        "Waspada",
        "Normal"
    )

    baseline_breaks = (
        scenario["baseline_risk_score"]
        .quantile([0.25, 0.50, 0.75])
        .astype(float)
        .tolist()
    )

    q1, q2, q3 = baseline_breaks

    scenario["prioritas_skenario"] = np.select(
        [
            scenario["risk_score"] <= q1,
            scenario["risk_score"] <= q2,
            scenario["risk_score"] <= q3
        ],
        [
            "Rendah",
            "Sedang",
            "Tinggi"
        ],
        default="Sangat Tinggi"
    )

    scenario["ranking_skenario"] = (
        scenario["risk_score"]
        .rank(
            ascending=False,
            method="min"
        )
        .astype(int)
    )

    top_row = scenario.sort_values(
        "risk_score",
        ascending=False
    ).iloc[0]

    changed_count = int(
        (
            scenario["risk_change_percent"]
            .abs() >= 1
        ).sum()
    )

    by_code = {
        normalize_code(row["kecamatan_code"]): row
        for _, row in scenario.iterrows()
    }

    by_name = {
        normalize_name(row["kecamatan_name"]): row
        for _, row in scenario.iterrows()
    }

    output = deepcopy(base_geojson)
    matched = 0

    for feature in output["features"]:
        properties = feature.get("properties", {})

        code = normalize_code(
            properties.get("kecamatan_code")
            or properties.get("district_code")
            or properties.get("kode_kecamatan")
        )

        name = normalize_name(
            properties.get("kecamatan_name")
            or properties.get("kecamatan")
            or properties.get("district_name")
            or properties.get("WADMKC")
        )

        row = by_code.get(code)

        if row is None:
            row = by_name.get(name)

        if row is not None:
            matched += 1

            properties.update({
                "sim_baseline_score": round(
                    float(row["baseline_risk_score"]), 6
                ),
                "sim_risk_score": round(
                    float(row["risk_score"]), 6
                ),
                "sim_risk_delta": round(
                    float(row["risk_delta"]), 6
                ),
                "sim_change_percent": round(
                    float(row["risk_change_percent"]), 2
                ),
                "sim_status": str(
                    row["status_peringatan"]
                ),
                "sim_priority": str(
                    row["prioritas_skenario"]
                ),
                "sim_rank": int(
                    row["ranking_skenario"]
                ),
                "sim_rainfall_mm": round(
                    float(row["rainfall_mm"]), 2
                ),
                "sim_temperature_c": round(
                    float(row["temperature_c"]), 2
                ),
                "sim_humidity_pct": round(
                    float(row["humidity_pct"]), 2
                ),
                "sim_case_count": int(
                    round(float(row["case_count"]))
                ),
                "sim_is_target": bool(mask.loc[row.name])
            })

        feature["properties"] = properties

    output["metadata"] = {
        "mode": "Simulasi spasial-musiman historis",
        "last_updated": datetime.now(
            timezone(timedelta(hours=7))
        ).isoformat(),
        "target_year": 2023,
        "target_month": target_month,
        "target_month_name": MONTH_NAMES[target_month],
        "target_district": target_label,
        "district_names": district_names,
        "baseline_breaks": baseline_breaks,
        "threshold": threshold,
        "changed_districts": changed_count,
        "matched_districts": matched,
        "highest_risk_district": str(
            top_row["kecamatan_name"]
        ),
        "highest_risk_score": round(
            float(top_row["risk_score"]), 6
        ),
        "rainfall_change_percent": (
            rainfall_change_percent
        ),
        "humidity_change_point": (
            humidity_change_point
        ),
        "temperature_change_c": (
            temperature_change_c
        ),
        "additional_cases": additional_cases,
        "important_note": (
            "Simulasi menggunakan pola historis 2023. "
            "Skor adalah peringatan relatif, bukan "
            "probabilitas klinis."
        )
    }

    return output


@app.get("/api/simulate/annual")
def simulate_annual(
    rainfall_change_percent: float = Query(0, ge=-50, le=100),
    humidity_change_point: float = Query(0, ge=-20, le=20),
    temperature_change_c: float = Query(0, ge=-3, le=3),
    additional_cases: int = Query(0, ge=0, le=20)
):
    return build_annual_simulation(
        get_month_baseline=get_month_baseline,
        model=model,
        feature_names=feature_names,
        positive_index=positive_index,
        threshold=threshold,
        base_geojson=base_geojson,
        rainfall_change_percent=rainfall_change_percent,
        humidity_change_point=humidity_change_point,
        temperature_change_c=temperature_change_c,
        additional_cases=additional_cases
    )


@app.get("/api/realtime")
def realtime_prediction(
    refresh: bool = Query(False)
):
    try:
        return build_realtime_prediction(
            model_df=model_df,
            model=model,
            feature_names=feature_names,
            positive_index=positive_index,
            threshold=threshold,
            base_geojson=base_geojson,
            live_dir=LIVE_DIR,
            population_updates=population_updates,
            force_refresh=refresh
        )
    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=f"Prediksi terkini gagal dihitung: {error}"
        ) from error


@app.get("/api/live-data/status")
def live_data_status():
    try:
        return live_status(model_df, LIVE_DIR)
    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=f"Status data kasus gagal dibaca: {error}"
        ) from error


@app.get("/api/live-data/template")
def live_data_template():
    try:
        content = build_template_xlsx(model_df)
        filename = template_filename()
        return Response(
            content=content,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"',
                "Cache-Control": "no-store",
            },
        )
    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=f"Template gagal dibuat: {error}"
        ) from error


async def _read_upload_body(request: Request, filename: str):
    content = await request.body()
    if len(content) > 8 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Ukuran file maksimal 8 MB.")
    suffix = Path(filename or "").suffix.lower()
    if suffix not in {".xlsx", ".csv"}:
        raise HTTPException(status_code=400, detail="Format file harus .xlsx atau .csv.")
    return content


@app.post("/api/live-data/validate")
async def validate_live_data(request: Request, filename: str = Query(..., min_length=1, max_length=180)):
    try:
        content = await _read_upload_body(request, filename)
        result, _ = validate_upload(filename, content, model_df, LIVE_DIR)
        return result
    except HTTPException:
        raise
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"Validasi file gagal: {error}") from error


@app.post("/api/live-data/apply")
async def apply_live_data(request: Request, filename: str = Query(..., min_length=1, max_length=180)):
    try:
        content = await _read_upload_body(request, filename)
        return apply_upload(filename, content, model_df, LIVE_DIR)
    except HTTPException:
        raise
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"Penerapan data gagal: {error}") from error


@app.get("/api/history/years")
def history_years():
    years = available_history_years(model_df)
    return {
        "years": years,
        "default_year": max(years),
        "note": "2018 tersedia mulai Mei; 2019-2023 tersedia 12 bulan."
    }


@app.get("/api/history")
def history(
    year: int = Query(2023, ge=2018, le=2023)
):
    try:
        return build_history_payload(
            year=year,
            model_df=model_df,
            model=model,
            feature_names=feature_names,
            positive_index=positive_index,
            threshold=threshold,
            base_geojson=base_geojson
        )
    except ValueError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=f"Time-series gagal dihitung: {error}"
        ) from error


app.mount(
    "/",
    StaticFiles(
        directory=str(DIST_DIR),
        html=True
    ),
    name="webgis"
)
