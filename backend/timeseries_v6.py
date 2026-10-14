"""Historical annual and monthly time-series engine for LeptoScope v6."""

from copy import deepcopy

import numpy as np
import pandas as pd


RISK_CLASSES = ["Rendah", "Sedang", "Tinggi", "Sangat Tinggi"]


def normalize_code(value):
    return str(value or "").strip().replace(" ", "")


def normalize_name(value):
    return " ".join(str(value or "").lower().strip().split())


def safe_float(value, digits=6):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    if not np.isfinite(number):
        return 0.0
    return round(number, digits)


def risk_class(score, breaks):
    q1, q2, q3 = breaks
    if score <= q1:
        return "Rendah"
    if score <= q2:
        return "Sedang"
    if score <= q3:
        return "Tinggi"
    return "Sangat Tinggi"


def quantile_breaks(values, fallback=None):
    fallback = fallback or [0.05, 0.12, 0.25]
    series = pd.to_numeric(values, errors="coerce").dropna()
    if series.empty:
        return list(fallback)
    breaks = series.quantile([0.25, 0.50, 0.75]).astype(float).tolist()
    if len(breaks) != 3 or not all(np.isfinite(breaks)):
        return list(fallback)
    return breaks


def available_history_years(model_df):
    years = (
        pd.to_datetime(model_df["target_date"], errors="coerce")
        .dt.year
        .dropna()
        .astype(int)
        .sort_values()
        .unique()
        .tolist()
    )
    return years


def _monthly_records(rows, threshold):
    records = []
    for target_month, month_rows in rows.groupby("target_month", sort=True):
        breaks = quantile_breaks(month_rows["model_score"])
        month_rows = month_rows.copy()
        month_rows["relative_score_class"] = month_rows["model_score"].map(
            lambda value: risk_class(value, breaks)
        )
        month_rows["month_rank"] = (
            month_rows["model_score"]
            .rank(ascending=False, method="min")
            .astype(int)
        )
        for _, row in month_rows.sort_values("kecamatan_code").iterrows():
            records.append(
                {
                    "kecamatan_code": str(row["kecamatan_code"]),
                    "kecamatan_name": str(row["kecamatan_name"]),
                    "date": row["date"].date().isoformat(),
                    "target_date": row["target_date"].date().isoformat(),
                    "target_month": str(target_month),
                    "target_year": int(row["target_date"].year),
                    "target_case_next_month": int(
                        round(float(row.get("target_case_next_month", 0)))
                    ),
                    "target_occurrence_next_month": int(
                        round(float(row.get("target_occurrence_next_month", 0)))
                    ),
                    "model_score": safe_float(row["model_score"]),
                    "threshold": safe_float(threshold),
                    "prediction": int(row["prediction"]),
                    "prediction_label": (
                        "Peringatan Kasus" if int(row["prediction"]) else "Tidak Ada Peringatan"
                    ),
                    "correct_alert": int(row["correct_alert"]),
                    "false_alert": int(row["false_alert"]),
                    "missed_case": int(row["missed_case"]),
                    "relative_score_class": str(row["relative_score_class"]),
                    "month_rank": int(row["month_rank"]),
                    "population_estimate": safe_float(
                        row.get("population_estimate"), 0
                    ),
                    "population_density_per_sqkm": safe_float(
                        row.get("population_density_per_sqkm"), 1
                    ),
                    "rainfall_mm": safe_float(row.get("rainfall_mm"), 1),
                    "humidity_pct": safe_float(row.get("humidity_pct"), 1),
                    "temperature_c": safe_float(row.get("temperature_c"), 1),
                }
            )
    return records


def _annual_rows(rows):
    annual = (
        rows.groupby(["kecamatan_code", "kecamatan_name"], as_index=False)
        .agg(
            history_mean_score=("model_score", "mean"),
            history_max_score=("model_score", "max"),
            history_cases=("target_case_next_month", "sum"),
            history_case_months=("target_occurrence_next_month", "sum"),
            history_alert_months=("prediction", "sum"),
            history_correct_alerts=("correct_alert", "sum"),
            history_false_alerts=("false_alert", "sum"),
            history_missed_cases=("missed_case", "sum"),
            history_rainfall_mm=("rainfall_mm", "sum"),
            history_humidity_pct=("humidity_pct", "mean"),
            history_temperature_c=("temperature_c", "mean"),
        )
    )

    latest = (
        rows.sort_values("date")
        .groupby("kecamatan_code", as_index=False)
        .tail(1)
        .set_index("kecamatan_code")
    )
    for column in [
        "population_estimate",
        "population_density_per_sqkm",
        "healthcare_count",
        "healthcare_per_100k",
    ]:
        annual[column] = annual["kecamatan_code"].map(
            latest[column] if column in latest.columns else {}
        )

    breaks = quantile_breaks(annual["history_mean_score"])
    annual["history_priority_class"] = annual["history_mean_score"].map(
        lambda value: risk_class(value, breaks)
    )
    annual["history_rank"] = (
        annual["history_mean_score"]
        .rank(ascending=False, method="min")
        .astype(int)
    )
    denominator = pd.to_numeric(
        annual["population_estimate"], errors="coerce"
    ).replace(0, np.nan)
    annual["history_incidence_per_100k"] = (
        annual["history_cases"] / denominator * 100000
    ).fillna(0)
    return annual, breaks


def _attach_geometry(base_geojson, annual, year):
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
                    "history_year": int(year),
                    "history_mean_score": safe_float(row["history_mean_score"]),
                    "history_max_score": safe_float(row["history_max_score"]),
                    "history_cases": int(round(float(row["history_cases"]))),
                    "history_case_months": int(row["history_case_months"]),
                    "history_alert_months": int(row["history_alert_months"]),
                    "history_correct_alerts": int(row["history_correct_alerts"]),
                    "history_false_alerts": int(row["history_false_alerts"]),
                    "history_missed_cases": int(row["history_missed_cases"]),
                    "history_priority_class": str(row["history_priority_class"]),
                    "history_rank": int(row["history_rank"]),
                    "history_incidence_per_100k": safe_float(
                        row["history_incidence_per_100k"], 2
                    ),
                    "history_rainfall_mm": safe_float(
                        row["history_rainfall_mm"], 1
                    ),
                    "history_humidity_pct": safe_float(
                        row["history_humidity_pct"], 1
                    ),
                    "history_temperature_c": safe_float(
                        row["history_temperature_c"], 1
                    ),
                    "population_estimate": safe_float(
                        row.get("population_estimate"), 0
                    ),
                    "population_density_per_sqkm": safe_float(
                        row.get("population_density_per_sqkm"), 1
                    ),
                    "healthcare_count": safe_float(
                        row.get("healthcare_count"), 0
                    ),
                    "healthcare_per_100k": safe_float(
                        row.get("healthcare_per_100k"), 2
                    ),
                }
            )
        feature["properties"] = properties
    return output, matched


def build_history_payload(
    *,
    year,
    model_df,
    model,
    feature_names,
    positive_index,
    threshold,
    base_geojson,
):
    years = available_history_years(model_df)
    if int(year) not in years:
        raise ValueError(f"Tahun {year} tidak tersedia. Pilihan: {years}")

    rows = model_df[model_df["target_date"].dt.year == int(year)].copy()
    rows = rows.dropna(subset=feature_names)
    if rows.empty:
        raise ValueError(f"Data tahun {year} kosong.")

    rows["model_score"] = model.predict_proba(
        rows[feature_names]
    )[:, positive_index]
    rows["prediction"] = (rows["model_score"] >= threshold).astype(int)
    rows["correct_alert"] = (
        (rows["prediction"] == 1)
        & (rows["target_occurrence_next_month"] == 1)
    ).astype(int)
    rows["false_alert"] = (
        (rows["prediction"] == 1)
        & (rows["target_occurrence_next_month"] == 0)
    ).astype(int)
    rows["missed_case"] = (
        (rows["prediction"] == 0)
        & (rows["target_occurrence_next_month"] == 1)
    ).astype(int)
    rows["target_month"] = rows["target_date"].dt.strftime("%Y-%m")

    monthly = _monthly_records(rows, threshold)
    annual, annual_breaks = _annual_rows(rows)
    annual_geojson, matched = _attach_geometry(base_geojson, annual, year)
    available_months = sorted(rows["target_month"].unique().tolist())
    leader = annual.sort_values("history_mean_score", ascending=False).iloc[0]

    return {
        "annual_geojson": annual_geojson,
        "monthly_records": monthly,
        "metadata": {
            "mode": "Time-series historis",
            "api_version": "6.0.0",
            "year": int(year),
            "available_years": years,
            "available_months": available_months,
            "complete_year": len(available_months) == 12,
            "matched_districts": matched,
            "threshold": safe_float(threshold),
            "annual_class_breaks": annual_breaks,
            "total_cases": int(round(float(annual["history_cases"].sum()))),
            "total_alert_months": int(annual["history_alert_months"].sum()),
            "districts_with_cases": int((annual["history_cases"] > 0).sum()),
            "highest_risk_district": str(leader["kecamatan_name"]),
            "highest_risk_score": safe_float(leader["history_mean_score"]),
            "population_total": int(
                round(float(pd.to_numeric(annual["population_estimate"], errors="coerce").sum()))
            ),
            "note": (
                "2018 tersedia mulai Mei karena fitur lag tiga bulan. "
                "Tahun 2019-2023 memiliki 12 bulan target."
                if int(year) == 2018
                else "Tersedia 12 bulan target."
            ),
        },
    }
