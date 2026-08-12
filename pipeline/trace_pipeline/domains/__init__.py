"""Domain modules. Importing this package registers every domain."""

from trace_pipeline.domains.base import Domain, SourceInfo, all_ids, get, register

__all__ = ["Domain", "SourceInfo", "all_ids", "get", "register"]
