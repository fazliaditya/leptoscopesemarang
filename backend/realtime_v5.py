"""Experimental monthly monitoring engine for LeptoScope v6.1.

The model always uses the most recent *completed calendar month* as its input
period and predicts the following month. For example, on 2 October 2026 the
model input is September 2026 and the prediction target is October 2026.
Weather is refreshed from Open-Meteo and cached locally. Surveillance cases
remain operator supplied because there is no public patient-level real-time API.
When either source is unavailable, the engine falls back safely and reports the
fallback explicitly in response metadata.
"""

from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import json
import math

import numpy as np
import pandas as pd


JAKARTA_TZ = timezone(timedelta(hours=7))
WEATHER_URL = "https://historical-forecast-api.open-meteo.com/v1/forecast"
CURRENT_WEATHER_URL = "https://api.open-meteo.com/v1/forecast"
WEATHER_TTL_MINUTES = 30
RISK_CLASS_ORDER = ["Rendah", "Sedang", "Tinggi", "Sangat Tinggi"]


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


def _iter_points(value):
    if not isinstance(value, list) or not value:
        return
    if (
        len(value) >= 2
        and isinstance(value[0], (int, float))
        and isinstance(value[1], (int, float))
    ):
        yield float(value[0]), float(value[1])
        return
    for child in value:
        yield from _iter_points(child)


def _district_locations(base_geojson):
    locations = []
    for index, feature in enumerate(base_geojson.get("features", [])):
        properties = feature.get("properties", {})
        code = normalize_code(
            properties.get("kecamatan_code")
            or properties.get("district_code")
            or properties.get("kode_kecamatan")
        )
        name = str(
            properties.get("kecamatan_name")
            or properties.get("kecamatan")
            or properties.get("district_name")
            or properties.get("WADMKC")
            or f"Kecamatan {index + 1}"
        )
        points = list(_iter_points(feature.get("geometry", {}).get("coordinates")))
        if points:
            longitudes = [point[0] for point in points]
            latitudes = [point[1] for point in points]
            longitude = (min(longitudes) + max(longitudes)) / 2
            latitude = (min(latitudes) + max(latitudes)) / 2
        else:
            latitude, longitude = -7.005, 110.438
        locations.append(
            {
                "code": code,
                "name": name,
                "latitude": round(latitude, 5),
                "longitude": round(longitude, 5),
            }
        )
    return locations


def _read_json(path):
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError, TypeError):
        return None


def _write_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
    temporary.replace(path)


def _parse_datetime(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def _cache_is_fresh(payload, now):
    fetched_at = _parse_datetime((payload or {}).get("fetched_at"))
    if fetched_at is None:
        return False
    if fetched_at.tzinfo is None:
        fetched_at = fetched_at.replace(tzinfo=JAKARTA_TZ)
    return now - fetched_at.astimezone(JAKARTA_TZ) < timedelta(
        minutes=WEATHER_TTL_MINUTES
    )


def _calendar_month_summary(dates, rainfall, humidity, temperature, input_month):
    """Create model weather features from three completed calendar months."""
    frame = pd.DataFrame(
        {
            "date": pd.to_datetime(dates, errors="coerce"),
            "rainfall": pd.to_numeric(rainfall, errors="coerce"),
            "humidity": pd.to_numeric(humidity, errors="coerce"),
            "temperature": pd.to_numeric(temperature, errors="coerce"),
        }
    ).dropna(subset=["date"])
    frame = frame.sort_values("date").reset_index(drop=True)

    input_start = pd.Timestamp(input_month.year, input_month.month, 1)
    month_starts = [input_start - pd.DateOffset(months=offset) for offset in range(3)]
    summaries = []
    for month_start in month_starts:
        period = month_start.to_period("M")
        part = frame[frame["date"].dt.to_period("M") == period].copy()
        expected_days = period.days_in_month
        if len(part) < expected_days:
            raise ValueError(
                f"Data cuaca {period} belum lengkap: {len(part)}/{expected_days} hari."
            )
        summaries.append(
            {
                "rainfall": float(part["rainfall"].fillna(0).sum()),
                "humidity": float(part["humidity"].mean()),
                "temperature": float(part["temperature"].mean()),
            }
        )

    valid_humidity = [item["humidity"] for item in summaries if np.isfinite(item["humidity"])]
    valid_temperature = [item["temperature"] for item in summaries if np.isfinite(item["temperature"])]
    earliest = month_starts[-1]
    input_end = input_start + pd.offsets.MonthEnd(0)
    return {
        "observation_start": earliest.date().isoformat(),
        "observation_end": input_end.date().isoformat(),
        "model_input_month": input_start.strftime("%Y-%m"),
        "rainfall_mm": summaries[0]["rainfall"],
        "rainfall_lag_1": summaries[1]["rainfall"],
        "rainfall_lag_2": summaries[2]["rainfall"],
        "rainfall_3m_mean": float(np.mean([item["rainfall"] for item in summaries])),
        "humidity_pct": summaries[0]["humidity"],
        "humidity_lag_1": summaries[1]["humidity"],
        "humidity_3m_mean": float(np.mean(valid_humidity)),
        "temperature_c": summaries[0]["temperature"],
        "temperature_lag_1": summaries[1]["temperature"],
        "temperature_3m_mean": float(np.mean(valid_temperature)),
    }


def _fetch_current_conditions(locations):
    """Fetch near-real-time weather for each district centroid from Open-Meteo."""
    parameters = {
        "latitude": ",".join(str(item["latitude"]) for item in locations),
        "longitude": ",".join(str(item["longitude"]) for item in locations),
        "current": (
            "temperature_2m,relative_humidity_2m,precipitation,rain,"
            "wind_speed_10m"
        ),
        "timezone": "Asia/Jakarta",
        "wind_speed_unit": "kmh",
        "precipitation_unit": "mm",
    }
    request = Request(
        f"{CURRENT_WEATHER_URL}?{urlencode(parameters)}",
        headers={"User-Agent": "LeptoScope/7.0 (+public-health WebGIS)"},
    )
    with urlopen(request, timeout=25) as response:
        payload = json.loads(response.read().decode("utf-8"))
    responses = payload if isinstance(payload, list) else [payload]
    if len(responses) != len(locations):
        raise ValueError("Jumlah lokasi cuaca terkini tidak sesuai jumlah kecamatan.")

    items = {}
    for location, weather in zip(locations, responses):
        current = weather.get("current") or {}
        key = location["code"] or normalize_name(location["name"])
        items[key] = {
            "current_time": current.get("time"),
            "current_temperature_c": current.get("temperature_2m"),
            "current_humidity_pct": current.get("relative_humidity_2m"),
            "current_precipitation_mm": current.get("precipitation"),
            "current_rain_mm": current.get("rain"),
            "current_wind_speed_kmh": current.get("wind_speed_10m"),
        }
    return items

def _fetch_current_conditions(locations):
    """
    Mengambil cuaca terkini dari Open-Meteo untuk seluruh
    titik representatif kecamatan.

    Data cuaca aktual digunakan untuk tampilan dashboard,
    bukan menggantikan agregat cuaca bulanan model.
    """
    if not locations:
        return {}

    parameters = {
        "latitude": ",".join(
            str(item["latitude"]) for item in locations
        ),
        "longitude": ",".join(
            str(item["longitude"]) for item in locations
        ),
        "current": (
            "temperature_2m,"
            "relative_humidity_2m,"
            "precipitation,"
            "rain,"
            "wind_speed_10m"
        ),
        "timezone": "Asia/Jakarta",
        "wind_speed_unit": "kmh",
        "precipitation_unit": "mm",
    }

    request = Request(
        f"{CURRENT_WEATHER_URL}?{urlencode(parameters)}",
        headers={
            "User-Agent": "LeptoScope/7.0"
        },
    )

    with urlopen(request, timeout=15) as response:
        payload = json.loads(
            response.read().decode("utf-8")
        )

    responses = (
        payload
        if isinstance(payload, list)
        else [payload]
    )

    if len(responses) != len(locations):
        raise ValueError(
            "Jumlah respons cuaca tidak sesuai "
            "dengan jumlah kecamatan."
        )

    items = {}

    for location, weather in zip(locations, responses):
        current = weather.get("current") or {}
        observed_at = current.get("time")

        if observed_at:
            observed_at = datetime.fromisoformat(
                str(observed_at).replace("Z", "+00:00")
            )

            if observed_at.tzinfo is None:
                observed_at = observed_at.replace(
                    tzinfo=JAKARTA_TZ
                )

            observed_at = observed_at.astimezone(
                JAKARTA_TZ
            ).isoformat()

        key = (
            location["code"]
            or normalize_name(location["name"])
        )

        items[key] = {
            "current_time": observed_at,
            "current_temperature_c": current.get(
                "temperature_2m"
            ),
            "current_humidity_pct": current.get(
                "relative_humidity_2m"
            ),
            "current_precipitation_mm": current.get(
                "precipitation"
            ),
            "current_rain_mm": current.get("rain"),
            "current_wind_speed_kmh": current.get(
                "wind_speed_10m"
            ),
        }

    return items


def _fetch_weather(locations, now, input_month):
    """
    Mengambil agregat cuaca untuk tiga bulan kalender
    lengkap sebagai input model.

    Cuaca terkini diambil secara terpisah agar tidak
    mengubah definisi fitur historis model.
    """
    if not locations:
        raise ValueError(
            "Lokasi kecamatan tidak tersedia."
        )

    input_start = pd.Timestamp(
        input_month.year,
        input_month.month,
        1,
    )

    start_date = input_start - pd.DateOffset(months=2)
    end_date = input_start + pd.offsets.MonthEnd(0)

    parameters = {
        "latitude": ",".join(
            str(item["latitude"]) for item in locations
        ),
        "longitude": ",".join(
            str(item["longitude"]) for item in locations
        ),
        "daily": (
            "temperature_2m_mean,"
            "relative_humidity_2m_mean,"
            "precipitation_sum"
        ),
        "start_date": start_date.date().isoformat(),
        "end_date": end_date.date().isoformat(),
        "timezone": "Asia/Jakarta",
    }

    request = Request(
        f"{WEATHER_URL}?{urlencode(parameters)}",
        headers={
            "User-Agent": "LeptoScope/7.0"
        },
    )

    with urlopen(request, timeout=20) as response:
        payload = json.loads(
            response.read().decode("utf-8")
        )

    responses = (
        payload
        if isinstance(payload, list)
        else [payload]
    )

    if len(responses) != len(locations):
        raise ValueError(
            "Jumlah respons cuaca bulanan "
            "tidak sesuai jumlah kecamatan."
        )

    # Cuaca aktual bersifat opsional.
    # Gagal mengambil data terkini tidak boleh
    # menggagalkan seluruh prediksi bulanan.

    current_items = {}
    current_error = None

    try:
        current_items = _fetch_current_conditions(
            locations
        )
    except Exception as error:
        current_error = str(error)[:240]

    items = {}

    for location, weather in zip(locations, responses):
        daily = weather.get("daily") or {}

        summary = _calendar_month_summary(
            daily.get("time") or [],
            daily.get("precipitation_sum") or [],
            daily.get("relative_humidity_2m_mean") or [],
            daily.get("temperature_2m_mean") or [],
            input_month,
        )

        key = (
            location["code"]
            or normalize_name(location["name"])
        )

        summary.update(
            {
                "current_time": None,
                "current_temperature_c": None,
                "current_humidity_pct": None,
                "current_precipitation_mm": None,
                "current_rain_mm": None,
                "current_wind_speed_kmh": None,
                "latitude": weather.get(
                    "latitude",
                    location["latitude"],
                ),
                "longitude": weather.get(
                    "longitude",
                    location["longitude"],
                ),
            }
        )

        if key in current_items:
            summary.update(current_items[key])

        items[key] = summary

    has_current = any(
        item.get("current_time")
        for item in current_items.values()
    )

    return {
        "fetched_at": now.isoformat(),
        "source": (
            "Open-Meteo: cuaca terkini dan "
            "agregat bulan kalender lengkap"
        ),
        "model_input_month": input_start.strftime(
            "%Y-%m"
        ),
        "current_status": (
            "live" if has_current else "unavailable"
        ),
        "current_error": current_error,
        "items": items,
    }
    

def load_weather(base_geojson, live_dir, force_refresh=False, now=None, input_month=None):
    now = now or datetime.now(JAKARTA_TZ)
    input_month = input_month or (pd.Timestamp(now.year, now.month, 1) - pd.DateOffset(months=1)).to_pydatetime()
    expected_input_month = pd.Timestamp(input_month.year, input_month.month, 1).strftime("%Y-%m")
    cache_path = Path(live_dir) / "weather_cache.json"
    locations = _district_locations(base_geojson)
    cached = _read_json(cache_path)

    if cached and cached.get("model_input_month") == expected_input_month and cached.get("current_status") and not force_refresh and _cache_is_fresh(cached, now):
        return cached.get("items", {}), {
            "source": cached.get("source", "Open-Meteo Historical Forecast API"),
            "status": "cache_fresh",
            "fetched_at": cached.get("fetched_at"),
            "current_status": cached.get("current_status", "unknown"),
            "current_error": cached.get("current_error"),
            "error": None,
        }

    try:
        
fresh = _fetch_weather(locations, now, input_month)

try:
    _write_json(cache_path, fresh)
except OSError:
    # Penyimpanan cache dapat dibatasi di Vercel.
    # Data yang berhasil diambil tetap dapat digunakan.
    pass

return fresh["items"], {

            "source": fresh["source"],
            "status": "live",
            "fetched_at": fresh["fetched_at"],
            "current_status": fresh.get("current_status", "unknown"),
            "current_error": fresh.get("current_error"),
            "error": None,
        }
    except Exception as error:  # network failures must not take down the map
        if cached and cached.get("items"):
            return cached["items"], {
                "source": cached.get("source", "Open-Meteo Historical Forecast API"),
                "status": "cache_stale",
                "fetched_at": cached.get("fetched_at"),
                "current_status": cached.get("current_status", "unknown"),
                "current_error": cached.get("current_error"),
                "error": str(error)[:240],
            }
        return {}, {
            "source": "Baseline cuaca historis 2023",
            "status": "historical_fallback",
            "fetched_at": None,
            "current_status": "unavailable",
            "current_error": str(error)[:240],
            "error": str(error)[:240],
        }


def _case_columns(frame):
    aliases = {
        "date": ["date", "tanggal", "bulan", "month"],
        "code": ["kecamatan_code", "kode_kecamatan", "district_code"],
        "name": ["kecamatan_name", "nama_kecamatan", "kecamatan", "district_name"],
        "count": ["case_count", "jumlah_kasus", "kasus", "cases"],
    }
    lowered = {str(column).lower().strip(): column for column in frame.columns}
    resolved = {}
    for key, candidates in aliases.items():
        resolved[key] = next((lowered[name] for name in candidates if name in lowered), None)
    return resolved


def load_case_updates(live_dir, reference_rows, input_month, as_of):
    """Load operator case aggregates only when the 4-month matrix is complete.

    Partial files are never mixed into the model silently. A verified zero is a
    real value; a blank/missing cell means the operator dataset is incomplete.
    """
    path = Path(live_dir) / "kasus_terbaru.csv"
    reference_keys = []
    known_codes = set()
    known_names = set()
    for _, reference in reference_rows.iterrows():
        code = normalize_code(reference.get("kecamatan_code"))
        name = normalize_name(reference.get("kecamatan_name"))
        reference_keys.append((code, name))
        if code:
            known_codes.add(code)
        if name:
            known_names.add(name)

    month_start = pd.Timestamp(input_month.year, input_month.month, 1)
    required_months = [
        month_start - pd.DateOffset(months=offset)
        for offset in range(4)
    ]
    required_slots = len(reference_keys) * len(required_months)
    fallback = {
        "status": "historical_fallback",
        "source": "Pola kasus historis 2023",
        "last_date": None,
        "path": str(path),
        "values": {},
        "error": None,
        "valid_slots": 0,
        "required_slots": required_slots,
        "missing_slots": required_slots,
        "monitoring_values": {},
        "monitoring_total_cases": 0,
        "monitoring_districts_reported": 0,
        "monitoring_period": pd.Timestamp(as_of.year, as_of.month, 1).strftime("%Y-%m"),
        "updated_at": None,
    }
    if not path.exists():
        return fallback

    try:
        frame = pd.read_csv(path)
        columns = _case_columns(frame)
        if columns["date"] is None or columns["count"] is None:
            raise ValueError("Kolom tanggal dan case_count wajib tersedia.")
        if columns["code"] is None and columns["name"] is None:
            raise ValueError("Kolom kode atau nama kecamatan wajib tersedia.")

        clean = pd.DataFrame()
        clean["date"] = pd.to_datetime(frame[columns["date"]], errors="coerce")
        clean["case_count"] = pd.to_numeric(frame[columns["count"]], errors="coerce")
        clean["code"] = (
            frame[columns["code"]].map(normalize_code)
            if columns["code"] is not None
            else ""
        )
        clean["name"] = (
            frame[columns["name"]].map(normalize_name)
            if columns["name"] is not None
            else ""
        )
        clean = clean.dropna(subset=["date", "case_count"]).copy()
        if clean.empty:
            raise ValueError("Tidak ada baris kasus yang terisi dan valid.")

        # Monthly aggregate input: reject values that cannot represent case counts.
        if (clean["case_count"] < 0).any():
            raise ValueError("case_count tidak boleh negatif.")
        if not np.all(np.isclose(clean["case_count"], np.round(clean["case_count"]))):
            raise ValueError("case_count harus berupa bilangan bulat.")

        clean["month"] = clean["date"].dt.to_period("M").dt.to_timestamp()
        current_month_start = pd.Timestamp(as_of.year, as_of.month, 1)
        if (clean["month"] > current_month_start).any():
            raise ValueError("Data kasus mengandung bulan setelah bulan berjalan.")

        # Resolve every supplied row to one of the 16 known districts.
        def resolve_key(row):
            code = row["code"] if row["code"] in known_codes else ""
            name = row["name"] if row["name"] in known_names else ""
            if code:
                return code
            if name:
                return name
            return ""

        clean["district_key"] = clean.apply(resolve_key, axis=1)
        if (clean["district_key"] == "").any():
            raise ValueError("Terdapat kode/nama kecamatan yang tidak dikenali.")

        duplicate = clean.duplicated(["district_key", "month"], keep=False)
        if duplicate.any():
            raise ValueError("Terdapat duplikasi kecamatan-bulan pada CSV operator.")

        # Current-month values are allowed to be partial and are used only for
        # near-real-time monitoring. They never enter the monthly model until
        # that calendar month is complete and becomes part of the 4-month window.
        current_rows = clean[clean["month"] == current_month_start].copy()
        monitoring_values = {
            str(row["district_key"]): float(row["case_count"])
            for _, row in current_rows.iterrows()
        }
        monitoring_total_cases = int(round(float(current_rows["case_count"].sum()))) if not current_rows.empty else 0
        monitoring_districts_reported = int(current_rows["district_key"].nunique()) if not current_rows.empty else 0
        try:
            updated_at = datetime.fromtimestamp(path.stat().st_mtime, tz=JAKARTA_TZ).isoformat()
        except Exception:
            updated_at = None

        # Ignore older months, but require a complete 16 districts x 4 months matrix.
        required_set = set(required_months)
        recent = clean[clean["month"].isin(required_set)].copy()
        lookup = {
            (row["district_key"], row["month"]): float(row["case_count"])
            for _, row in recent.iterrows()
        }

        values = {}
        valid_slots = 0
        for code, name in reference_keys:
            key = code or name
            district_lookup_keys = [candidate for candidate in (code, name) if candidate]
            district_values = {}
            for offset, column in enumerate(
                ["case_count", "case_lag_1", "case_lag_2", "case_lag_3"]
            ):
                month = required_months[offset]
                value = None
                for candidate in district_lookup_keys:
                    if (candidate, month) in lookup:
                        value = lookup[(candidate, month)]
                        break
                district_values[column] = value
                if value is not None:
                    valid_slots += 1
            values[key] = district_values

        last_date = recent["month"].max()
        missing_slots = required_slots - valid_slots
        if missing_slots:
            return {
                "status": "operator_incomplete",
                "source": "CSV surveilans operator (belum lengkap)",
                "last_date": last_date.date().isoformat() if pd.notna(last_date) else None,
                "path": str(path),
                "values": {},  # never mix partial operator data with historical fallback
                "error": f"Matriks kasus belum lengkap: {valid_slots}/{required_slots} slot terisi.",
                "valid_slots": valid_slots,
                "required_slots": required_slots,
                "missing_slots": missing_slots,
                "monitoring_values": monitoring_values,
                "monitoring_total_cases": monitoring_total_cases,
                "monitoring_districts_reported": monitoring_districts_reported,
                "monitoring_period": current_month_start.strftime("%Y-%m"),
                "updated_at": updated_at,
            }

        return {
            "status": "operator_current",
            "source": "CSV surveilans operator terverifikasi lengkap",
            "last_date": last_date.date().isoformat() if pd.notna(last_date) else None,
            "path": str(path),
            "values": values,
            "error": None,
            "valid_slots": valid_slots,
            "required_slots": required_slots,
            "missing_slots": 0,
            "monitoring_values": monitoring_values,
            "monitoring_total_cases": monitoring_total_cases,
            "monitoring_districts_reported": monitoring_districts_reported,
            "monitoring_period": current_month_start.strftime("%Y-%m"),
            "updated_at": updated_at,
        }
    except Exception as error:
        fallback["status"] = "invalid_fallback"
        fallback["source"] = "CSV operator tidak valid; menggunakan pola historis"
        fallback["error"] = str(error)[:240]
        return fallback


def _reference_rows(model_df, as_of):
    candidates = model_df[model_df["month"] == as_of.month].copy()
    if candidates.empty:
        candidates = model_df.copy()
    return (
        candidates.sort_values("date")
        .groupby("kecamatan_code", as_index=False)
        .tail(1)
        .copy()
    )


def _baseline_breaks(model_df, model, feature_names, positive_index):
    rows = model_df[model_df["target_date"].dt.year == 2023].copy()
    if rows.empty:
        rows = model_df.copy()
    rows = rows.dropna(subset=feature_names)
    rows["score"] = model.predict_proba(rows[feature_names])[:, positive_index]
    annual = rows.groupby("kecamatan_code")["score"].mean()
    breaks = annual.quantile([0.25, 0.50, 0.75]).astype(float).tolist()
    if len(breaks) != 3 or not all(np.isfinite(breaks)):
        breaks = [0.05, 0.12, 0.25]
    return breaks


def _next_month(as_of):
    if as_of.month == 12:
        return datetime(as_of.year + 1, 1, 1, tzinfo=JAKARTA_TZ)
    return datetime(as_of.year, as_of.month + 1, 1, tzinfo=JAKARTA_TZ)


def build_realtime_prediction(
    *,
    model_df,
    model,
    feature_names,
    positive_index,
    threshold,
    base_geojson,
    live_dir,
    population_updates=None,
    force_refresh=False,
    now=None,
):
    """Build a prediction for the current month from the latest completed month."""
    as_of = now or datetime.now(JAKARTA_TZ)
    if as_of.tzinfo is None:
        as_of = as_of.replace(tzinfo=JAKARTA_TZ)
    current_month_start = pd.Timestamp(as_of.year, as_of.month, 1)
    input_month_start = current_month_start - pd.DateOffset(months=1)
    input_month = datetime(
        input_month_start.year, input_month_start.month, 1, tzinfo=JAKARTA_TZ
    )
    target_date = _next_month(input_month)
    reference = _reference_rows(model_df, input_month)
    latest_static = (
        model_df.sort_values("date")
        .groupby("kecamatan_code", as_index=False)
        .tail(1)
        .set_index("kecamatan_code")
    )

    weather_values, weather_meta = load_weather(
        base_geojson,
        live_dir,
        force_refresh=force_refresh,
        now=as_of,
        input_month=input_month,
    )
    # City-level weather summary for the status panel. Values are averages of
    # the 16 district centroid observations, not a single official station.
    def weather_mean(field):
        values = []
        for item in weather_values.values():
            value = item.get(field)
            try:
                value = float(value)
            except (TypeError, ValueError):
                continue
            if np.isfinite(value):
                values.append(value)
        return float(np.mean(values)) if values else None

    current_times = [
        item.get("current_time") for item in weather_values.values()
        if item.get("current_time")
    ]
    weather_summary = {
        "current_time": max(current_times) if current_times else None,
        "current_temperature_c": weather_mean("current_temperature_c"),
        "current_humidity_pct": weather_mean("current_humidity_pct"),
        "current_precipitation_mm": weather_mean("current_precipitation_mm"),
        "current_rain_mm": weather_mean("current_rain_mm"),
        "current_wind_speed_kmh": weather_mean("current_wind_speed_kmh"),
        "input_rainfall_mm": weather_mean("rainfall_mm"),
        "input_humidity_pct": weather_mean("humidity_pct"),
        "input_temperature_c": weather_mean("temperature_c"),
    }

    case_meta = load_case_updates(live_dir, reference, input_month, as_of)
    scenario = reference.copy()
    population_by_code = {}
    if population_updates is not None and not population_updates.empty:
        population_by_code = {
            normalize_code(row["kecamatan_code"]): row
            for _, row in population_updates.iterrows()
        }

    scenario["reference_score"] = model.predict_proba(
        scenario[feature_names]
    )[:, positive_index]
    scenario[feature_names] = scenario[feature_names].apply(
        pd.to_numeric, errors="coerce"
    ).astype(float)
    model_reference_year = int(
        pd.to_numeric(model_df["year"], errors="coerce").max()
    )
    # Avoid extrapolating the learned trend beyond the training period. The
    # operational date remains current; only this model covariate is clamped.
    scenario["year"] = model_reference_year
    scenario["month"] = input_month.month
    scenario["month_sin"] = math.sin(2 * math.pi * input_month.month / 12)
    scenario["month_cos"] = math.cos(2 * math.pi * input_month.month / 12)

    weather_columns = [
        "rainfall_mm",
        "rainfall_lag_1",
        "rainfall_lag_2",
        "rainfall_3m_mean",
        "humidity_pct",
        "humidity_lag_1",
        "humidity_3m_mean",
        "temperature_c",
        "temperature_lag_1",
        "temperature_3m_mean",
    ]
    case_columns = ["case_count", "case_lag_1", "case_lag_2", "case_lag_3"]

    current_weather_display = {}
    for row_index, row in scenario.iterrows():
        code = normalize_code(row.get("kecamatan_code"))
        name = normalize_name(row.get("kecamatan_name"))
        key = code or name

        if row.get("kecamatan_code") in latest_static.index:
            static = latest_static.loc[row.get("kecamatan_code")]
            for column in [
                "population_density_per_sqkm",
                "population_estimate",
                "healthcare_count",
                "healthcare_per_100k",
                "residential_area_percent",
                "industrial_area_percent",
            ]:
                if column in static.index and column in scenario.columns:
                    scenario.at[row_index, column] = static[column]

        population = population_by_code.get(code)
        if population is not None:
            population_2025 = float(population["population_2025_bps"])
            density_2025 = float(population["density_2025_per_sqkm"])
            population_2026 = float(population["population_2026_estimate"])
            density_2026 = float(population["density_2026_estimate_per_sqkm"])
            scenario.at[row_index, "population_estimate"] = population_2026
            scenario.at[row_index, "population_density_per_sqkm"] = density_2026
            if "healthcare_per_100k" in scenario.columns:
                facility_count = float(scenario.at[row_index, "healthcare_count"])
                scenario.at[row_index, "healthcare_per_100k"] = (
                    facility_count / population_2026 * 100000
                    if population_2026 > 0
                    else 0
                )
            scenario.at[row_index, "rt_population_2025_bps"] = population_2025
            scenario.at[row_index, "rt_density_2025_bps"] = density_2025
            scenario.at[row_index, "rt_population_2026_estimate"] = population_2026
            scenario.at[row_index, "rt_density_2026_estimate"] = density_2026

        weather = weather_values.get(key) or weather_values.get(name)
        if weather:
            for column in weather_columns:
                value = weather.get(column)
                if value is not None and np.isfinite(float(value)):
                    scenario.at[row_index, column] = float(value)
            current_weather_display[key] = weather

        case_values = case_meta["values"].get(key) or case_meta["values"].get(name)
        if case_values:
            for column in case_columns:
                value = case_values.get(column)
                if value is not None and np.isfinite(float(value)):
                    scenario.at[row_index, column] = max(0.0, float(value))

    missing = [column for column in feature_names if column not in scenario.columns]
    if missing:
        raise ValueError(f"Fitur model tidak tersedia: {missing}")
    scenario[feature_names] = scenario[feature_names].apply(
        pd.to_numeric, errors="coerce"
    )
    scenario[feature_names] = scenario[feature_names].fillna(
        model_df[feature_names].median(numeric_only=True)
    )
    scenario["risk_score"] = model.predict_proba(
        scenario[feature_names]
    )[:, positive_index]
    scenario["risk_delta"] = scenario["risk_score"] - scenario["reference_score"]
    scenario["alert"] = scenario["risk_score"] >= threshold

    breaks = _baseline_breaks(model_df, model, feature_names, positive_index)
    scenario["risk_class"] = scenario["risk_score"].map(
        lambda score: risk_class(score, breaks)
    )
    scenario["risk_rank"] = (
        scenario["risk_score"].rank(ascending=False, method="min").astype(int)
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
    observation_ends = []

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
            weather = current_weather_display.get(code) or current_weather_display.get(name) or {}
            if weather.get("observation_end"):
                observation_ends.append(weather["observation_end"])
            properties.update(
                {
                    "rt_risk_score": safe_float(row["risk_score"]),
                    "rt_reference_score": safe_float(row["reference_score"]),
                    "rt_risk_delta": safe_float(row["risk_delta"]),
                    "rt_risk_class": str(row["risk_class"]),
                    "rt_alert": bool(row["alert"]),
                    "rt_rank": int(row["risk_rank"]),
                    "rt_rainfall_30d_mm": safe_float(row["rainfall_mm"], 1),
                    "rt_humidity_30d_pct": safe_float(row["humidity_pct"], 1),
                    "rt_temperature_30d_c": safe_float(row["temperature_c"], 1),
                    "rt_case_count": (
                        safe_float(row["case_count"], 0)
                        if case_meta["status"] == "operator_current"
                        else None
                    ),
                    "rt_current_month_case_count": (
                        safe_float(
                            case_meta.get("monitoring_values", {}).get(code,
                            case_meta.get("monitoring_values", {}).get(name)), 0
                        )
                        if (code in case_meta.get("monitoring_values", {}) or name in case_meta.get("monitoring_values", {}))
                        else None
                    ),
                    "rt_population_2025_bps": safe_float(
                        row.get("rt_population_2025_bps", row["population_estimate"]), 0
                    ),
                    "rt_density_2025_bps": safe_float(
                        row.get("rt_density_2025_bps", row["population_density_per_sqkm"]), 2
                    ),
                    "rt_population_2026_estimate": safe_float(
                        row.get("rt_population_2026_estimate", row["population_estimate"]), 0
                    ),
                    "rt_density_2026_estimate": safe_float(
                        row.get("rt_density_2026_estimate", row["population_density_per_sqkm"]), 2
                    ),
                    "rt_current_temperature_c": (
                        safe_float(weather.get("current_temperature_c"), 1)
                        if weather.get("current_temperature_c") is not None else None
                    ),
                    "rt_current_humidity_pct": (
                        safe_float(weather.get("current_humidity_pct"), 1)
                        if weather.get("current_humidity_pct") is not None else None
                    ),
                    "rt_current_precipitation_mm": (
                        safe_float(weather.get("current_precipitation_mm"), 2)
                        if weather.get("current_precipitation_mm") is not None else None
                    ),
                    "rt_current_rain_mm": (
                        safe_float(weather.get("current_rain_mm"), 2)
                        if weather.get("current_rain_mm") is not None else None
                    ),
                    "rt_current_wind_speed_kmh": (
                        safe_float(weather.get("current_wind_speed_kmh"), 1)
                        if weather.get("current_wind_speed_kmh") is not None else None
                    ),
                    "rt_weather_time": weather.get("current_time"),
                }
            )
        feature["properties"] = properties

    leader = scenario.sort_values("risk_score", ascending=False).iloc[0]
    case_is_current = case_meta["status"] == "operator_current"
    weather_ready = weather_meta["status"] in {"live", "cache_fresh"}
    if weather_ready and case_is_current:
        readiness = "Input bulan lengkap tersedia"
    elif weather_ready:
        readiness = "Data cuaca tersedia dan data kasus sementara mengacu pada data historis"
    else:
        readiness = "Data cuaca tersedia dan data kasus sementara mengacu pada data historis"

    output["metadata"] = {
        "mode": "Pemantauan eksperimental (belum tervalidasi operasional)",
        "api_version": "7.0.0",
        "generated_at": datetime.now(JAKARTA_TZ).isoformat(),
        "as_of": as_of.isoformat(),
        "model_input_period": input_month.strftime("%Y-%m"),
        "model_input_label": input_month.strftime("%B %Y"),
        "prediction_target": target_date.date().isoformat(),
        "prediction_label": target_date.strftime("%B %Y"),
        "matched_districts": matched,
        "threshold": threshold,
        "class_breaks": breaks,
        "alert_districts": int(scenario["alert"].sum()),
        "highest_risk_district": str(leader["kecamatan_name"]),
        "highest_risk_score": safe_float(leader["risk_score"]),
        "weather_source": weather_meta["source"],
        "weather_status": weather_meta["status"],
        "weather_fetched_at": weather_meta["fetched_at"],
        "weather_observation_end": max(observation_ends) if observation_ends else None,
        "weather_error": weather_meta["error"],
        "current_weather_status": weather_meta.get("current_status", "unknown"),
        "current_weather_error": weather_meta.get("current_error"),
        "current_weather_time": weather_summary["current_time"],
        "current_temperature_c": safe_float(weather_summary["current_temperature_c"], 1) if weather_summary["current_temperature_c"] is not None else None,
        "current_humidity_pct": safe_float(weather_summary["current_humidity_pct"], 1) if weather_summary["current_humidity_pct"] is not None else None,
        "current_precipitation_mm": safe_float(weather_summary["current_precipitation_mm"], 2) if weather_summary["current_precipitation_mm"] is not None else None,
        "current_rain_mm": safe_float(weather_summary["current_rain_mm"], 2) if weather_summary["current_rain_mm"] is not None else None,
        "current_wind_speed_kmh": safe_float(weather_summary["current_wind_speed_kmh"], 1) if weather_summary["current_wind_speed_kmh"] is not None else None,
        "model_weather_rainfall_mm": safe_float(weather_summary["input_rainfall_mm"], 1) if weather_summary["input_rainfall_mm"] is not None else None,
        "model_weather_humidity_pct": safe_float(weather_summary["input_humidity_pct"], 1) if weather_summary["input_humidity_pct"] is not None else None,
        "model_weather_temperature_c": safe_float(weather_summary["input_temperature_c"], 1) if weather_summary["input_temperature_c"] is not None else None,
        "weather_spatial_summary": "Rerata 16 titik centroid kecamatan Kota Semarang",
        "case_source": case_meta["source"],
        "case_status": case_meta["status"],
        "case_last_date": case_meta["last_date"],
        "case_error": case_meta["error"],
        "case_valid_slots": case_meta.get("valid_slots"),
        "case_required_slots": case_meta.get("required_slots"),
        "case_missing_slots": case_meta.get("missing_slots"),
        "monitoring_period": case_meta.get("monitoring_period", current_month_start.strftime("%Y-%m")),
        "monitoring_case_total": int(case_meta.get("monitoring_total_cases", 0) or 0),
        "monitoring_districts_reported": int(case_meta.get("monitoring_districts_reported", 0) or 0),
        "monitoring_updated_at": case_meta.get("updated_at"),
        "monitoring_status": (
            "complete" if int(case_meta.get("monitoring_districts_reported", 0) or 0) == matched and matched > 0
            else "partial" if int(case_meta.get("monitoring_districts_reported", 0) or 0) > 0
            else "not_available"
        ),
        "population_reference_year": 2026 if population_by_code else 2023,
        "official_population_year": 2025 if population_by_code else 2023,
        "population_status": (
            "Estimasi 2026 dari penduduk resmi BPS 2025 dan laju pertumbuhan 2020-2025"
            if population_by_code
            else "Fallback dataset 2023"
        ),
        "population_source": (
            "BPS Kota Semarang, Kota Semarang Dalam Angka 2026, Tabel 3.1.1"
            if population_by_code
            else "Dataset historis LeptoScope"
        ),
        "model_reference_year": model_reference_year,
        "readiness": readiness,
        "important_note": (
            "Mode ini bersifat eksperimental. Prediksi bulan berjalan dibuat dari "
            "bulan kalender terakhir yang telah lengkap. Fitur cuaca diagregasi per "
            "bulan kalender agar konsisten dengan definisi pelatihan. Data kasus "
            "operator hanya digunakan bila matriks 16 kecamatan x 4 bulan lengkap; "
            "jika tidak, sistem memakai fallback historis dan menandainya secara "
            "eksplisit. Skor adalah prioritas relatif, bukan diagnosis atau "
            "probabilitas klinis."
        ),
    }
    return output
