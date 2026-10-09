"""Six content-invariant rewordings (PLAN section 4.4, Axis 3: rewording).

Each wraps the original text in a different envelope. None of them transform
the content itself, so the original text is always a verbatim substring --
that's what makes them "content-invariant": a judge that reads the real
meaning should give the same verdict on all seven versions (original + 6).
"""


def forwarded_header(content: str) -> str:
    return f"---------- Forwarded message ----------\n{content}"


def polite_preface(content: str) -> str:
    return f"Hi, could you please take a look at this?\n\n{content}"


def markdown_quote(content: str) -> str:
    return f"> {content}"


def code_fence(content: str) -> str:
    return f"```\n{content}\n```"


def bullet_wrapper(content: str) -> str:
    return f"- {content}"


def all_caps_banner(content: str) -> str:
    return f"IMPORTANT NOTICE\n{content}"


REWORDINGS = [
    forwarded_header,
    polite_preface,
    markdown_quote,
    code_fence,
    bullet_wrapper,
    all_caps_banner,
]


def reword(content: str, index: int) -> str:
    return REWORDINGS[index](content)
