"""The cohort naming rule -- the pipeline's copy of the web's layer model.

What matters here is not that the functions run but that they agree with `layerSpec.ts` node for
node, because a name the web never asks for is data that never draws. The tree shape and the
canonical decomposition are pinned against values worked out by hand, and the web's own tests pin
the same values from its side; `layerSpec.tiles.test.ts` closes the loop against real archives.
"""

import pytest

from trace_pipeline import cohorts
from trace_pipeline.cohorts import Cohorts

FOREST = Cohorts(2001, 2025)


# --- the tree ----------------------------------------------------------------------------------


def test_tree_has_2n_minus_1_nodes_over_the_half_open_range():
    nodes = FOREST.nodes

    assert len(nodes) == 2 * 25 - 1
    assert (nodes[0].start, nodes[0].end, nodes[0].parent) == (2001, 2026, None)
    assert sum(1 for n in nodes if n.end - n.start == 1) == 25


def test_tree_splits_at_the_floor_midpoint_like_the_web():
    """`intervalNodes` splits at `Math.floor((start + end) / 2)`; another split is another tree."""
    root, left, *_ = FOREST.nodes
    assert (left.start, left.end) == (2001, 2013)
    right = next(n for n in FOREST.nodes if n.parent is root and n is not left)
    assert (right.start, right.end) == (2013, 2026)


def test_tree_is_pre_order_so_a_role_keeps_its_layers_contiguous():
    nodes = FOREST.nodes
    for child in nodes[1:]:
        assert nodes.index(child.parent) < nodes.index(child)


# --- the canonical decomposition ---------------------------------------------------------------


def claimed_years(names: list[str]) -> list[int]:
    years: list[int] = []
    for name in names:
        start, end = (int(part) for part in name.split(":")[1].split("-"))
        years.extend(range(start, end))
    return sorted(years)


@pytest.mark.parametrize(
    ("valid_from", "valid_to", "expected_years"),
    [
        (2000, None, list(range(2001, 2026))),  # open, from before the range: the root alone
        (2000, 2014, list(range(2001, 2014))),  # closed, from before the range
        (2005, 2009, [2005, 2006, 2007, 2008]),  # closed, inside the range
        (2013, 2014, [2013]),  # a single year
        (2024, None, [2024, 2025]),  # open, from near the end
        (2000, 2030, list(range(2001, 2026))),  # closed after the range ends
    ],
)
def test_cover_is_claimed_for_exactly_its_years_each_once(valid_from, valid_to, expected_years):
    names = FOREST.layers_for(
        {"change_type": "cover", "valid_from": valid_from, "valid_to": valid_to}
    )
    assert claimed_years(names) == expected_years


def test_open_ended_cover_is_the_root_alone():
    assert FOREST.layers_for({"change_type": "cover", "valid_from": 2000, "valid_to": None}) == [
        "cover:2001-2026"
    ]


def test_a_closed_stretch_is_at_most_two_log_n_copies():
    """The bound the design rests on: copies cost tile bytes, and this is what keeps them few."""
    worst = max(
        len(FOREST.layers_for({"change_type": "cover", "valid_from": f, "valid_to": t}))
        for f in range(2001, 2026)
        for t in range(f + 1, 2027)
    )
    assert worst <= 2 * 5  # ceil(log2 25) = 5


# --- change cohorts ----------------------------------------------------------------------------


def test_change_is_one_layer_named_for_its_year():
    assert FOREST.layers_for({"change_type": "loss", "valid_from": 2013, "valid_to": None}) == [
        "loss:2013"
    ]


def test_change_before_the_range_lands_in_the_first_cohort():
    """The web's first cohort takes everything from its year back (`cohortFilter`)."""
    assert FOREST.layers_for({"change_type": "loss", "valid_from": 1999, "valid_to": None}) == [
        "loss:2001"
    ]


# --- refusals ----------------------------------------------------------------------------------


def test_change_after_the_range_is_refused_not_dropped():
    with pytest.raises(cohorts.CohortError, match="after the domain's last year"):
        FOREST.layers_for({"change_type": "loss", "valid_from": 2026, "valid_to": None})


def test_cover_that_ended_before_the_range_has_no_cohort():
    """Forest's `[2000, 2001)`: in the baseline year, gone by the first year the slider shows."""
    assert FOREST.layers_for({"change_type": "cover", "valid_from": 2000, "valid_to": 2001}) == []


def test_cover_beginning_after_the_range_is_refused_not_dropped():
    with pytest.raises(cohorts.CohortError, match="after the domain's last year"):
        FOREST.layers_for({"change_type": "cover", "valid_from": 2026, "valid_to": None})


# --- the names, read back ----------------------------------------------------------------------


def test_every_layer_the_web_builds_is_recognised():
    for name in FOREST.all_layers(("cover", "loss")):
        assert FOREST.is_layer(name), name


def test_all_layers_counts_one_per_year_and_one_per_node():
    assert len(FOREST.all_layers(("cover", "loss"))) == (2 * 25 - 1) + 25


@pytest.mark.parametrize(
    "name",
    [
        "forest",  # the pre-cohort layer name
        "loss:2000",  # a year before the range
        "loss:2026",  # a year after it
        "cover:2001",  # cover is never a year cohort
        "loss:2001-2013",  # change is never a node
        "cover:2002-2013",  # not a node of this tree
        "cover:2001-2025",  # closed at the last year rather than past it
        "extent:2013",  # not a state the schema knows
    ],
)
def test_names_that_are_not_cohorts_are_rejected(name):
    assert not FOREST.is_layer(name)


def test_a_tree_for_another_range_names_different_nodes():
    """What lets the manifest refuse tiles built for a range the domain no longer reports."""
    other = Cohorts(2001, 2024)
    assert not other.is_layer("cover:2001-2026")
    assert not FOREST.is_layer("cover:2001-2025")


def test_change_type_is_read_off_the_name():
    assert cohorts.change_type_of("loss:2013") == "loss"
    assert cohorts.change_type_of("cover:2001-2026") == "cover"
    assert cohorts.change_type_of("forest") is None


def test_partition_yields_one_line_per_copy_in_input_order():
    features = [
        {"properties": {"change_type": "loss", "valid_from": 2013, "valid_to": None}},
        {"properties": {"change_type": "cover", "valid_from": 2000, "valid_to": 2014}},
        {"properties": {"change_type": "cover", "valid_from": 2000, "valid_to": 2001}},
    ]
    lines = list(cohorts.partition(features, FOREST))

    assert [layer for layer, _ in lines] == ["loss:2013", "cover:2001-2013", "cover:2013-2014"]
    assert lines[1][1] is features[1] and lines[2][1] is features[1]


# --- level: the interval tree, one year at a time ----------------------------------------------


def test_a_level_lands_in_the_leaf_for_its_year():
    """A level is `[Y, Y + 1)`, which the tree holds in exactly one node: the leaf for Y."""
    assert FOREST.layers_for({"change_type": "level", "valid_from": 2013, "valid_to": 2014}) == [
        "level:2013-2014"
    ]


def test_level_layers_are_the_tree_under_their_own_name():
    """Every node, like cover -- the web builds the same tree for both -- but named for level, so
    a style layer drawing one kind never reads the other's features."""
    names = FOREST.all_layers(("level",))
    assert len(names) == 2 * 25 - 1
    assert all(name.startswith("level:") for name in names)
    assert all(FOREST.is_layer(name) for name in names)


@pytest.mark.parametrize("name", ["level:2013", "level:2002-2013", "level:2001-2025"])
def test_a_level_is_never_a_year_cohort_or_a_foreign_node(name):
    assert not FOREST.is_layer(name)


def test_every_kind_the_schema_knows_has_a_cohort_model():
    """A new kind in the schema is refused here until someone decides how it is cut."""
    from trace_pipeline import schema

    assert set(schema.kind_of().values()) == set(cohorts.MODEL_OF_KIND)
