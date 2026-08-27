# Loads PSGC (Philippine Standard Geographic Code) reference data for the
# Region -> Province -> City/Municipality -> Barangay pickers on Add Farm.
# Source: isaacdarcilla/philippine-addresses (PSGC-based, MIT licensed).
# Region/province/city are small (~1750 records total) and cached in full.
# Barangay is ~42k records/4.6MB -- too big to ship to the browser, so it's
# indexed by city_code once and only ever queried for one city at a time.

import json
from functools import lru_cache
from pathlib import Path

Path(__file__).resolve().parent.parent / "static" / "js"


@lru_cache(maxsize=1)
def _load(name):
    with open(DATA_DIR / name, encoding="utf-8") as f:
        return json.load(f)


@lru_cache(maxsize=1)
def get_regions():
    return sorted(
        [{"code": r["region_code"], "name": r["region_name"]} for r in _load("region.json")],
        key=lambda r: r["name"],
    )


@lru_cache(maxsize=1)
def _provinces_by_region():
    index = {}
    for p in _load("province.json"):
        index.setdefault(p["region_code"], []).append({"code": p["province_code"], "name": p["province_name"]})
    for lst in index.values():
        lst.sort(key=lambda p: p["name"])
    return index


def get_provinces(region_code):
    return _provinces_by_region().get(region_code, [])


@lru_cache(maxsize=1)
def _cities_by_province():
    index = {}
    for c in _load("city.json"):
        index.setdefault(c["province_code"], []).append({"code": c["city_code"], "name": c["city_name"]})
    for lst in index.values():
        lst.sort(key=lambda c: c["name"])
    return index


def get_cities(province_code):
    return _cities_by_province().get(province_code, [])


@lru_cache(maxsize=1)
def _barangays_by_city():
    # One index built once (lazily, on first barangay request), then
    # every later lookup is an O(1) dict access -- avoids re-scanning the
    # full 42k-row file per request.
    index = {}
    for b in _load("barangay.json"):
        index.setdefault(b["city_code"], []).append({"code": b["brgy_code"], "name": b["brgy_name"]})
    for lst in index.values():
        lst.sort(key=lambda b: b["name"])
    return index


def get_barangays(city_code):
    return _barangays_by_city().get(city_code, [])
