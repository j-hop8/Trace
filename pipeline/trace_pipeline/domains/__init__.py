"""Domain modules. Importing this package registers every domain."""

# Import for side effect: each module's @register call is what puts it in the registry the CLI
# dispatches on. A domain that is never imported does not exist as far as `trace all` or the
# manifest are concerned. New domains go here.
from trace_pipeline.domains import forest, water  # noqa: E402,F401  (side-effecting)
from trace_pipeline.domains.base import Domain, SourceInfo, all_ids, get, register

__all__ = ["Domain", "SourceInfo", "all_ids", "get", "register", "forest", "water"]
