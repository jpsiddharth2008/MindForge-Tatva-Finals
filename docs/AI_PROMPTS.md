# Prompts for AI coding sessions

Open your AI tool inside your own clone of the repo:
- Paste your prompt below after your AI tool has loaded `RULES.md`.
- **Another AI tool:** paste the contents of `RULES.md` first, then your prompt.

Give the AI `docs/PLAN.md` and `docs/issues.json`. The Word file and the issue-loader script are for humans.

## Start of a session: copy yours

### Dev A: measurement
```
I'm Dev A (measurement) on our 4-person hackathon team. We submit at 11:00 tomorrow (IST).
Read RULES.md. Then read sections 1, 3.3, 4.3–4.8 and 6.2 of docs/PLAN.md, and my issues (owner "A") in docs/issues.json.
Start with A1.
Before writing code, give me your plan in 5 lines and any questions.
Work only in the files the issue lists.
When the acceptance criteria pass:
- show me the test output
- give me the git commands to commit (I'll run them)
- tell me which issue is next and what it waits on.
```

### Dev B: attack surface
```
I'm Dev B (attack surface) on our 4-person hackathon team. We submit at 11:00 tomorrow (IST).
Read RULES.md. Then read sections 1, 3, 4.3–4.6 and 6.2 of docs/PLAN.md, and my issues (owner "B") in docs/issues.json.
Start with B1, the hand-written attack corpus:
- Help me with the YAML format, the categories and a validator, and review my items.
- I write the item text myself.
- Every item needs a one-line rationale.
Before writing code, give me your plan in 5 lines and any questions.
Work only in the files the issue lists.
When the acceptance criteria pass:
- show me the test output
- give me the git commands to commit (I'll run them)
- tell me which issue is next and what it waits on.
```

### Dev C: guard and demo
```
I'm Dev C (guard and demo) on our 4-person hackathon team. We submit at 11:00 tomorrow (IST).
Read RULES.md. Then read sections 1, 3.3, 4.3–4.7, 5 and 6.2 of docs/PLAN.md, and my issues (owner "C") in docs/issues.json.
Start with C1:
- Help me find and adapt the monitor prompt from a published defence (start with arXiv:2509.14285), and cite it in the prompt file's header.
- Don't invent the prompt.
- Use a fake client until Dev A's llm/client.py lands.
Before writing code, give me your plan in 5 lines and any questions.
Work only in the files the issue lists.
When the acceptance criteria pass:
- show me the test output
- give me the git commands to commit (I'll run them)
- tell me which issue is next and what it waits on.
```

### Member D: pitch, docs and QA (no code)
```
I'm Member D on our 4-person hackathon team. I own the docs, citations, the pitch deck and testing, not code. We submit at 11:00 tomorrow (IST).
Read RULES.md. Then read sections 1, 5, 6 and 7.9 of docs/PLAN.md, and my issues (owner "D") in docs/issues.json.
The repo already exists (https://github.com/jpsiddharth2008/MindForge-Tatva-Finals). Start with what's left of D1, then D2.
For citations:
- Mark a paper "found" only after its link actually opens.
- Never invent or "fix" a citation.
- Quote numbers only from text you have read in the paper.
Give me commands to run instead of running git yourself.
```

## During the session

**Next issue**
```
Next: issue [B2]. Same rules. Plan first.
```

**Before committing**
```
Check my changes against the issue:
- Is every acceptance criterion met?
- Did I touch any file outside my folders?
- Is there any hard-coded result number, API key, or real API call in the tests?
```

**Behind schedule**
```
We're behind. Using docs/PLAN.md sections 6.4 and 6.5, what should I cut, and what's the fastest path to this issue's acceptance criteria?
```

**Blocked by a teammate**
```
My issue needs [X] from issue [C2]. Draft a short comment I can post on that issue.
```

**Explaining to judges**
```
Explain what we built in [A4] in 5 bullets I can say to a judge without notes, including its limits.
```
