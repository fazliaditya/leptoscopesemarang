"""Annual scenario engine for LeptoScope WebGIS v4."""

from copy import deepcopy
from datetime import datetime, timezone, timedelta

import numpy as np
import pandas as pd


RISK_CLASS_ORDER = [
    "Rendah",
    "Sedang",
    "Tinggi",
    "Sangat Tinggi",
]


def normalize_code(value):
    return str(value or "").strip().replace(" ", "")


def normalize_name(value):
    return " ".join(str(value or "").lower().strip().split())


def safe_float(value, digits=6):
    if pd.isna(value) or not np.isfinite(float(value)):
        return 0.0
    return round(float(value), digits)


def risk_class(score, breaks):
    q1, q2, q3 = breaks
    if score <= q1:
        return "Rendah"
    if score <= q2:
        return "Sedang"
    if score <= q3:
        return "Tinggi"
    return "Sangat Tinggi"


def apply_sustained_scenario(
    baseline,
    rainfall_change_percent,
    humidity_change_point,
    temperature_change_c,
    additional_cases,
):
    """Apply a sustained change to current, lagged, and rolling inputs."""
    scenario = baseline.copy()
    rainfall_factor = 1 + rainfall_change_percent / 100

    for column in [
        "rainfall_mm",
        "rainfall_lag_1",
        "rainfall_lag_2",
        "rainfall_3m_mean",
    ]:
        if column in scenario.columns:
            scenario[column] = (
                pd.to_numeric(scenario[column], errors="coerce")
                * rainfall_factor
            ).clip(lower=0)

    for column in [
        "humidity_pct",
        "humidity_lag_1",
        "humidity_3m_mean",
    ]:
        if column in scenario.columns:
            scenario[column] = (
                pd.to_numeric(scenario[column], errors="coerce")
                + humidity_change_point
            ).clip(lower=0, upper=100)

    for column in [
        "temperature_c",
        "temperature_lag_1",
        "temperature_3m_mean",
    ]:
        if column in scenario.columns:
            scenario[column] = (
                pd.to_numeric(scenario[column], errors="coerce")
                + temperature_change_c
            )

    for column in [
        "case_count",
        "case_lag_1",
        "case_lag_2",
        "case_lag_3",
    ]:
        if column in scenario.columns:
            scenario[column] = (
                pd.to_numeric(scenario[column], errors="coerce")
                + additional_cases
            ).clip(lower=0)

    return scenario


def build_annual_rows(
    get_month_baseline,
    model,
    feature_names,
    positive_index,
    threshold,
    rainfall_change_percent,
    humidity_change_point,
    temperature_change_c,
    additional_cases,
):
    monthly_results = []

    for target_month in range(1, 13):
        baseline = get_month_baseline(target_month)
        scenario = apply_sustained_scenario(
            baseline,
            rainfall_change_percent,
            humidity_change_point,
            temperature_change_c,
            additional_cases,
        )
        scenario["scenario_risk_score"] = model.predict_proba(
            scenario[feature_names]
        )[:, positive_index]
        scenario["baseline_alert"] = (
            scenario["baseline_risk_score"] >= threshold
        ).astype(int)
        scenario["scenario_alert"] = (
            scenario["scenario_risk_score"] >= threshold
        ).astype(int)
        monthly_results.append(scenario)

    monthly = pd.concat(monthly_results, ignore_index=True)
    annual = (
        monthly.groupby(
            ["kecamatan_code", "kecamatan_name"],
            as_index=False,
        )
        .agg(
            baseline_score=("baseline_risk_score", "mean"),
            scenario_score=("scenario_risk_score", "mean"),
            baseline_max_score=("baseline_risk_score", "max"),
            scenario_max_score=("scenario_risk_score", "max"),
            baseline_alert_months=("baseline_alert", "sum"),
            scenario_alert_months=("scenario_alert", "sum"),
            rainfall_mean_mm=("rainfall_mm", "mean"),
            humidity_mean_pct=("humidity_pct", "mean"),
            temperature_mean_c=("temperature_c", "mean"),
            case_mean=("case_count", "mean"),
        )
    )

    annual["risk_delta"] = (
        annual["scenario_score"] - annual["baseline_score"]
    )
    denominator = annual["baseline_score"].abs().clip(lower=0.01)
    annual["risk_change_percent"] = (
        annual["risk_delta"] / denominator * 100
    )
    annual["alert_month_delta"] = (
        annual["scenario_alert_months"]
        - annual["baseline_alert_months"]
    )

    breaks = (
        annual["baseline_score"]
        .quantile([0.25, 0.50, 0.75])
        .astype(float)
        .tolist()
    )
    annual["baseline_class"] = annual["baseline_score"].map(
        lambda value: risk_class(value, breaks)
    )
    annual["scenario_class"] = annual["scenario_score"].map(
        lambda value: risk_class(value, breaks)
    )
    class_index = {
        label: index for index, label in enumerate(RISK_CLASS_ORDER)
    }
    annual["class_shift"] = (
        annual["scenario_class"].map(class_index)
        - annual["baseline_class"].map(class_index)
    )
    annual["risk_rank"] = (
        annual["scenario_score"]
        .rank(ascending=False, method="min")
        .astype(int)
    )
    return annual, breaks


def attach_annual_properties(base_geojson, annual):
    by_code = {
        normalize_code(row["kecamatan_code"]): row
        for _, row in annual.iterrows()
    }
    by_name = {
        normalize_name(row["kecamatan_name"]): row
        for _, row in annual.iterrows()
    }
    output = deepcopy(base_geojson)
    matched = 0

    for feature in output.get("features", []):
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
            properties.update(
                {
                    "sim_baseline_score": safe_float(
                        row["baseline_score"]
                    ),
                    "sim_risk_score": safe_float(
                        row["scenario_score"]
                    ),
                    "sim_baseline_max_score": safe_float(
                        row["baseline_max_score"]
                    ),
                    "sim_scenario_max_score": safe_float(
                        row["scenario_max_score"]
                    ),
                    "sim_risk_delta": safe_float(row["risk_delta"]),
                    "sim_change_percent": safe_float(
                        row["risk_change_percent"], 2
                    ),
                    "sim_baseline_class": str(row["baseline_class"]),
                    "sim_risk_class": str(row["scenario_class"]),
                    "sim_class_shift": int(row["class_shift"]),
                    "sim_rank": int(row["risk_rank"]),
                    "sim_impact_rank": int(row["impact_rank"]),
                    "sim_baseline_alert_months": int(
                        row["baseline_alert_months"]
                    ),
                    "sim_alert_months": int(
                        row["scenario_alert_months"]
                    ),
                    "sim_alert_month_delta": int(
                        row["alert_month_delta"]
                    ),
                    "sim_status": (
                        "Waspada"
                        if int(row["scenario_alert_months"]) > 0
                        else "Normal"
                    ),
                    "sim_rainfall_mm": safe_float(
                        row["rainfall_mean_mm"], 2
                    ),
                    "sim_humidity_pct": safe_float(
                        row["humidity_mean_pct"], 2
                    ),
                    "sim_temperature_c": safe_float(
                        row["temperature_mean_c"], 2
                    ),
                    "sim_case_count": safe_float(row["case_mean"], 2),
                }
            )

        feature["properties"] = properties

    return output, matched


def build_annual_simulation(
    *,
    get_month_baseline,
    model,
    feature_names,
    positive_index,
    threshold,
    base_geojson,
    rainfall_change_percent=0,
    humidity_change_point=0,
    temperature_change_c=0,
    additional_cases=0,
):
    """Return annual GeoJSON and scenario diagnostics."""
    annual, breaks = build_annual_rows(
        get_month_baseline,
        model,
        feature_names,
        positive_index,
        threshold,
        rainfall_change_percent,
        humidity_change_point,
        temperature_change_c,
        additional_cases,
    )
    mean_baseline = float(annual["baseline_score"].mean())
    mean_scenario = float(annual["scenario_score"].mean())
    mean_delta = mean_scenario - mean_baseline
    average_change = (
        mean_delta / max(abs(mean_baseline), 0.01) * 100
    )

    has_change = bool((annual["risk_delta"].abs() >= 1e-8).any())
    direction = 1 if mean_delta >= 0 else -1

    # Impact priority is not the same as the highest absolute risk. It
    # prioritizes movement between classes, added/removed alert months, and
    # relative response. This prevents one high-baseline district from being
    # reported as the impact leader for every possible scenario.
    annual["impact_class_component"] = (
        annual["class_shift"] * direction
    )
    annual["impact_alert_component"] = (
        annual["alert_month_delta"] * direction
    )
    annual["impact_percent_component"] = (
        annual["risk_change_percent"] * direction
    )
    impact_order = annual.sort_values(
        [
            "impact_class_component",
            "impact_alert_component",
            "impact_percent_component",
            "risk_delta",
        ],
        ascending=[False, False, False, direction < 0],
        kind="stable",
    ).copy()
    impact_order["impact_rank"] = np.arange(1, len(impact_order) + 1)
    annual = annual.merge(
        impact_order[["kecamatan_code", "impact_rank"]],
        on="kecamatan_code",
        how="left",
    )

    impact_row = None
    if has_change:
        impact_row = impact_order.iloc[0]

    risk_leader = annual.sort_values(
        "scenario_score", ascending=False
    ).iloc[0]

    output, matched = attach_annual_properties(base_geojson, annual)

    output["metadata"] = {
        "mode": "Simulasi skenario tahunan historis",
        "api_version": "4.0.0",
        "last_updated": datetime.now(
            timezone(timedelta(hours=7))
        ).isoformat(),
        "target_year": 2023,
        "aggregation": "Rata-rata 12 bulan tahun 2023",
        "threshold": threshold,
        "class_breaks": breaks,
        "baseline_breaks": breaks,
        "breaks_source": "Kuantil baseline tahunan 2023 (tetap)",
        "matched_districts": matched,
        "mean_baseline_score": round(mean_baseline, 6),
        "mean_scenario_score": round(mean_scenario, 6),
        "mean_risk_delta": round(mean_delta, 6),
        "average_change_percent": round(average_change, 2),
        "changed_class_districts": int(
            (annual["class_shift"] != 0).sum()
        ),
        "increased_class_districts": int(
            (annual["class_shift"] > 0).sum()
        ),
        "alert_districts": int(
            (annual["scenario_alert_months"] > 0).sum()
        ),
        "total_alert_months": int(
            annual["scenario_alert_months"].sum()
        ),
        "impact_district": (
            str(impact_row["kecamatan_name"])
            if impact_row is not None
            else "Belum ada perubahan"
        ),
        "impact_delta": (
            round(float(impact_row["risk_delta"]), 6)
            if impact_row is not None
            else 0.0
        ),
        "impact_basis": (
            "Perubahan kelas, perubahan bulan peringatan, dan "
            "respons relatif terhadap baseline"
        ),
        "highest_risk_district": str(risk_leader["kecamatan_name"]),
        "highest_risk_score": round(
            float(risk_leader["scenario_score"]), 6
        ),
        "parameters": {
            "rainfall_change_percent": rainfall_change_percent,
            "humidity_change_point": humidity_change_point,
            "temperature_change_c": temperature_change_c,
            "additional_cases": additional_cases,
        },
        "important_note": (
            "Skenario menerapkan perubahan berkelanjutan pada "
            "prediktor saat ini, lag, dan rata-rata bergerak. "
            "Kelas memakai batas baseline tetap. Skor merupakan "
            "peringatan relatif, bukan probabilitas klinis."
        ),
    }
    return output
