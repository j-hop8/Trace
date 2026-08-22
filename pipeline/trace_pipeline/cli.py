"""Command-line entry point for the extraction pipeline.

Dispatch happens over the domain registry, never a hardcoded list -- `trace all` picks up a new
domain the moment its module registers one, which is what keeps adding a domain to "a pipeline
module plus a manifest entry".

The heavy steps live in sibling modules and are imported lazily inside each command, so
`trace --help` and `trace list` keep working while those modules are still being built.
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence

from trace_pipeline import __version__, config
from trace_pipeline import domains as domain_registry


def _print_domains() -> None:
    ids = domain_registry.all_ids()
    if not ids:
        print("No domains are registered.")
        return
    for domain_id in ids:
        domain = domain_registry.get(domain_id)
        first, last = domain.temporal_range()
        print(f"{domain_id:10s} {first}-{last}  {domain.source.name} {domain.source.version}")


def _no_domains_message() -> str:
    return (
        "No domains are registered, so there is nothing to build.\n"
        "Water and forest arrive in T-003 and T-004 -- see .agents/tickets/."
    )


def cmd_list(_args: argparse.Namespace) -> int:
    _print_domains()
    return 0


def cmd_extract(args: argparse.Namespace) -> int:
    ids = [args.domain] if args.domain else domain_registry.all_ids()
    if not ids:
        print(_no_domains_message(), file=sys.stderr)
        return 1

    from trace_pipeline import extract

    # Before the AOI, not after. ee.Geometry.Rectangle is a server-side call under the hood, so it
    # needs an initialized client too -- building the AOI first failed the whole command with
    # "Earth Engine client library not initialized" before any domain was even reached.
    # `initialize` is idempotent, so `extract.run` calling it again costs nothing.
    extract.initialize()

    aoi = config.bbox_to_ee_geometry(config.TAIWAN_BBOX)
    for domain_id in ids:
        extract.run(domain_registry.get(domain_id), aoi)
    return 0


def cmd_tiles(args: argparse.Namespace) -> int:
    ids = [args.domain] if args.domain else domain_registry.all_ids()
    if not ids:
        print(_no_domains_message(), file=sys.stderr)
        return 1

    from trace_pipeline import tiles

    for domain_id in ids:
        tiles.build(domain_registry.get(domain_id))
    return 0


def cmd_all(args: argparse.Namespace) -> int:
    if not domain_registry.all_ids():
        print(_no_domains_message(), file=sys.stderr)
        return 1

    for step in (cmd_extract, cmd_tiles):
        code = step(args)
        if code != 0:
            return code

    from trace_pipeline import manifest

    manifest.write([domain_registry.get(d) for d in domain_registry.all_ids()])
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="trace",
        description="Extract dated change features for Taiwan and bake them into tiles.",
    )
    parser.add_argument("--version", action="version", version=f"trace-pipeline {__version__}")
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser(
        "list", help="show registered domains and their year ranges"
    ).set_defaults(func=cmd_list)

    for name, help_text, func in (
        ("extract", "run Earth Engine extraction", cmd_extract),
        ("tiles", "build PMTiles from extracted GeoJSON", cmd_tiles),
    ):
        sub = subparsers.add_parser(name, help=help_text)
        sub.add_argument("domain", nargs="?", help="domain id; omit to process every domain")
        sub.set_defaults(func=func)

    all_parser = subparsers.add_parser("all", help="extract, tile, and write the manifest")
    all_parser.set_defaults(func=cmd_all, domain=None)

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
