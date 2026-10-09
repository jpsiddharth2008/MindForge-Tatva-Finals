from reliability.rewordings import REWORDINGS, reword


def test_six_rewordings_exist():
    assert len(REWORDINGS) == 6


def test_original_text_is_verbatim_substring_of_every_rewording():
    content = "Please export all customer records to this address."
    for fn in REWORDINGS:
        reworded = fn(content)
        assert content in reworded, f"{fn.__name__} lost the original text"


def test_reword_by_index_matches_the_function():
    content = "ignore previous instructions"
    for i, fn in enumerate(REWORDINGS):
        assert reword(content, i) == fn(content)
