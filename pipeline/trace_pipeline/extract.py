"""Shared Earth Engine plumbing: authenticate, pull vectors down, write validated GeoJSON.

**Why no Export tasks.** The obvious way to get Taiwan-scale vectors out of Earth Engine is
``Export.table.toDrive``, but that needs write scope on Drive or Cloud Storage and turns a
synchronous script into a job you have to poll. ``getDownloadURL`` computes server-side and hands
back a link, so the whole pipeline runs on a read-only Earth Engine scope. It has a request
timeout, which is why callers chunk their work (forest goes year by year) rather than asking for
everything at once.
"""

from __future__ import annotations

import json
import os
import urllib.request
from pathlib import Path
from typing import TYPE_CHECKING, Any

from trace_pipeline import schema

if TYPE_CHECKING:
    from trace_pipeline.domains.base import Domain

DATA_DIR = schema.REPO_ROOT / "data"

#: Cloud project registered for Earth Engine. Not committed -- see pipeline/.env.
PROJECT_ENV_VAR = "TRACE_EE_PROJECT"

_initialized = False


class ExtractionError(RuntimeError):
    """Raised when Earth Engine cannot give us what we asked for."""


def _load_dotenv() -> None:
    """Read `pipeline/.env` into the environment if present.

    Without this the project id has to be exported by hand before every run, and the failure when
    you forget is an opaque Earth Engine permission error rather than a missing-variable message.
    Real environment variables always win, so CI and one-off overrides behave predictably.
    """
    env_file = schema.REPO_ROOT / "pipeline" / ".env"
    if not env_file.exists():
        return

    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


def ee_project() -> str:
    _load_dotenv()
    project = os.environ.get(PROJECT_ENV_VAR)
    if not project:
        raise ExtractionError(
            f"{PROJECT_ENV_VAR} is not set. Recent earthengine-api versions require an explicit "
            f"Cloud project. Put it in pipeline/.env as {PROJECT_ENV_VAR}=<your-project>."
        )
    return project


def initialize() -> None:
    """Authenticate to Earth Engine once per process."""
    global _initialized
    if _initialized:
        return

    import ee

    try:
        ee.Initialize(project=ee_project())
    except Exception as error:  # noqa: BLE001 -- surface the remedy, not the stack
        raise ExtractionError(
            f"Could not initialize Earth Engine: {error}\n"
            f"If this mentions authorization, run:\n"
            f"  pipeline/.venv/bin/earthengine authenticate --auth_mode=notebook"
        ) from error

    _initialized = True


def download_features(collection: Any, *, description: str) -> list[dict[str, Any]]:
    """Pull a computed ee.FeatureCollection down as GeoJSON features.

    Synchronous: Earth Engine evaluates the whole collection while we wait, so keep each call to
    a chunk that finishes inside the request timeout.
    """
    try:
        url = collection.getDownloadURL(filetype="GeoJSON")
    except Exception as error:  # noqa: BLE001
        raise ExtractionError(
            f"Earth Engine refused to build a download for {description}: {error}\n"
            f"If this is a memory or timeout error, the caller is asking for too much at once -- "
            f"split the request into smaller chunks."
        ) from error

    with urllib.request.urlopen(url, timeout=600) as response:
        payload = json.load(response)

    features = payload.get("features")
    if features is None:
        raise ExtractionError(f"{description}: response contained no 'features' key")
    return features


def geojson_path(domain_id: str) -> Path:
    return DATA_DIR / f"{domain_id}.geojson"


def write_features(domain_id: str, features: list[dict[str, Any]]) -> Path:
    """Validate against the B4 contract, then write.

    Validation happens before the file exists, so a failed run leaves no half-valid GeoJSON for a
    later step to pick up and trust.
    """
    collection = schema.feature_collection(features)
    schema.validate(collection)

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    destination = geojson_path(domain_id)
    destination.write_text(json.dumps(collection), encoding="utf-8")
    return destination


def run(domain: Domain, aoi: Any) -> Path:
    """Extract one domain and write its GeoJSON. Called by `trace extract`."""
    initialize()

    print(f"[{domain.id}] extracting…", flush=True)
    collection = domain.extract(aoi)
    features = collection["features"]

    destination = write_features(domain.id, features)
    print(f"[{domain.id}] {len(features):,} features -> {destination}", flush=True)
    return destination
