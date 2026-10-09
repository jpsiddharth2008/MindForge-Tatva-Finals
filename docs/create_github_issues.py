#!/usr/bin/env python3
"""Load the "Who Guards the Guard?" backlog (issues.json) into a GitHub repo with the gh CLI.

Nothing is created unless you pass --execute. Without it, the script only prints what it would do.

  Preview:        python create_github_issues.py --repo OWNER/REPO
  Create:         python create_github_issues.py --repo OWNER/REPO --execute
  Assign owners:  python create_github_issues.py --repo OWNER/REPO --execute --assign A=alice B=bob C=carol D=dave

Needs: GitHub CLI (https://cli.github.com) logged in with `gh auth login`, and Python 3.9+.
Safe to run twice: labels are updated, existing milestones and issues (matched by title) are skipped.
"""
import argparse
import json
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
try:  # never crash on consoles that can't print some characters (e.g. Windows cp1252)
    sys.stdout.reconfigure(errors="replace")
except Exception:
    pass


def show(cmd):
    print("  $ " + " ".join(shlex.quote(c) for c in cmd))


def gh(cmd, execute):
    """Run a gh command (or just print it in preview mode). Returns stdout."""
    show(cmd)
    if not execute:
        return ""
    res = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    if res.returncode != 0:
        print("    ! failed:", (res.stderr or res.stdout).strip())
        raise SystemExit(1)
    return res.stdout.strip()


def topo_order(issues):
    """Every dependency is created before the issues that depend on it; otherwise follow the
    timeline (milestone, then owner, then issue number) so GitHub numbers read in build order."""
    by_id = {i["id"]: i for i in issues}
    key = lambda i: (i["milestone"], i["owner"], int(i["id"][1:]))
    waiting = {i["id"]: set(i["depends"]) for i in issues}
    order = []
    while waiting:
        ready = sorted((by_id[x] for x, deps in waiting.items() if not deps), key=key)
        if not ready:
            raise SystemExit("Dependency cycle among: " + ", ".join(sorted(waiting)))
        nxt = ready[0]
        order.append(nxt)
        del waiting[nxt["id"]]
        for deps in waiting.values():
            deps.discard(nxt["id"])
    return order


def issue_title(i):
    return f"[{i['id']}] {i['title']}"


def issue_body(i, owners, numbers, milestone_title):
    deps = ", ".join(f"#{numbers[d]}" if d in numbers else d for d in i["depends"]) or "nothing"
    def fmt(f):  # path in code font; an annotation in brackets, or a non-path entry, stays plain
        head, sep, tail = f.partition(" (")
        return (head if " " in head else f"`{head}`") + (sep + tail if sep else "")
    files = ", ".join(fmt(f) for f in i["files"])
    lines = [
        f"**Owner:** {owners[i['owner']]} | **Priority:** {i['priority']} | **Estimate:** {i['estimate']} h "
        f"| **Milestone:** {milestone_title}",
        f"**Depends on:** {deps}",
        "",
        f"**Files you own in this issue:** {files}",
        "",
        "### Why",
        i["why"],
        "",
        "### Tasks",
        *[f"- [ ] {t}" for t in i["tasks"]],
        "",
        "### Acceptance criteria",
        *[f"- [ ] {a}" for a in i["acceptance"]],
    ]
    if i.get("out_of_scope"):
        lines += ["", "### Out of scope (owned elsewhere)", i["out_of_scope"]]
    lines += ["", "---",
              "Definition of Done: merged through a PR with one review, a test or demo command proves it, "
              "numbers are in an evidence file, and the owner can explain it in 60 seconds."]
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", required=True, help="OWNER/REPO, e.g. alice/who-guards-the-guard")
    ap.add_argument("--execute", action="store_true", help="actually create things (default: preview only)")
    ap.add_argument("--assign", nargs="*", default=[], metavar="X=user",
                    help="GitHub usernames per owner letter, e.g. A=alice B=bob C=carol D=dave")
    ap.add_argument("--data", default=str(HERE / "issues.json"), help="path to issues.json")
    args = ap.parse_args()

    data = json.loads(Path(args.data).read_text(encoding="utf-8"))
    assignees = dict(a.split("=", 1) for a in args.assign)
    repo, execute = args.repo, args.execute
    milestones = {m["key"]: m for m in data["milestones"]}

    print("MODE:", "EXECUTE (creating for real)" if execute else "PREVIEW (nothing is created; add --execute)")
    if execute:
        gh(["gh", "auth", "status"], execute)

    print("\n1) Labels")
    for lab in data["labels"]:
        gh(["gh", "label", "create", lab["name"], "--repo", repo, "--color", lab["color"],
            "--description", lab["description"], "--force"], execute)

    print("\n2) Milestones")
    existing_ms = set()
    if execute:
        out = gh(["gh", "api", f"repos/{repo}/milestones?state=all&per_page=100"], execute)
        existing_ms = {m["title"] for m in json.loads(out or "[]")}
    for m in data["milestones"]:
        if m["title"] in existing_ms:
            print(f"  = exists: {m['title']}")
            continue
        gh(["gh", "api", f"repos/{repo}/milestones", "-f", f"title={m['title']}",
            "-f", f"due_on={m['due_on']}", "-f", f"description={m['description']}"], execute)

    print("\n3) Issues (in dependency order)")
    numbers = {}
    if execute:
        out = gh(["gh", "issue", "list", "--repo", repo, "--state", "all", "--limit", "1000",
                  "--json", "number,title"], execute)
        by_title = {x["title"]: x["number"] for x in json.loads(out or "[]")}
    else:
        by_title = {}

    created = skipped = 0
    for i in topo_order(data["issues"]):
        title = issue_title(i)
        if title in by_title:
            numbers[i["id"]] = by_title[title]
            print(f"  = exists: #{by_title[title]} {title}")
            skipped += 1
            continue
        ms_title = milestones[i["milestone"]]["title"]
        body = issue_body(i, data["owners"], numbers, ms_title)
        with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False, encoding="utf-8") as fh:
            fh.write(body)
            body_path = fh.name
        cmd = ["gh", "issue", "create", "--repo", repo, "--title", title, "--body-file", body_path,
               "--milestone", ms_title]
        for lab in [i["priority"], *i["labels"]]:
            cmd += ["--label", lab]
        if assignees.get(i["owner"]):
            cmd += ["--assignee", assignees[i["owner"]]]
        try:
            url = gh(cmd, execute)
        finally:
            Path(body_path).unlink(missing_ok=True)
        if execute:
            numbers[i["id"]] = int(url.rstrip("/").split("/")[-1])
            print(f"    -> #{numbers[i['id']]}")
        created += 1

    print(f"\nDone. {'Created' if execute else 'Would create'} {created} issues; skipped {skipped} existing.")
    if not execute:
        print("Nothing was changed. Re-run with --execute to create them.")


if __name__ == "__main__":
    main()
