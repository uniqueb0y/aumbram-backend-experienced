# Aumbram Evaluation Rubric (all tracks, all levels)

This rubric is **shared with candidates**. Each assignment lists its own criteria and
weights, and they all score on the same 1–4 scale below, so results are comparable
across reviewers and tracks.

## 1. The scale

| Score | Label | Meaning |
|---|---|---|
| **4** | Exceeds | Better than we'd expect at this level. We would learn something from it. |
| **3** | Meets | Solid and correct. We'd merge it with minor comments. |
| **2** | Partially meets | Works on the happy path, but has gaps that would cause real bugs or rework. |
| **1** | Does not meet | Missing, broken, or would need a rewrite. |

Scores are **level-relative**. An intern's "3" and a senior's "3" are different bars. See §3.

## 2. Standard criteria

Every assignment picks from these criteria and assigns weights that sum to 100%.

| # | Criterion | What we look at |
|---|---|---|
| C1 | **Functionality** | Must-haves work end to end. Should-haves attempted. Runs from the README. |
| C2 | **Correctness & edge cases** | Empty, error, loading and slow-network states. Bad input. Races, duplicates, retries. Money maths. |
| C3 | **Code quality & structure** | Readable, cohesive modules. Sensible naming. No dead code. Consistent style. Types where useful. |
| C4 | **Architecture & design** | Separation of concerns, data flow, extensibility, and appropriate (not excessive) abstraction. |
| C5 | **Performance** | Fit for mid-range Android and patchy networks: rendering, bundle size, queries, caching. |
| C6 | **Testing** | Meaningful tests at the right layer that cover the risky parts, not just coverage numbers. |
| C7 | **Security & data integrity** | Input validation, authz, secrets handling, idempotency, no oversell or double charge. |
| C8 | **UX, accessibility & polish** | Matches intent, responsive, keyboard/screen-reader basics, clear feedback. (UI tracks) |
| C9 | **Operability** | Logging, config, health checks, reproducible builds, observability. (Mainly Backend, DevOps, and experienced-level assignments) |
| C10 | **Communication** | README clarity, trade-offs stated honestly, assumptions documented, AI usage disclosed. |

## 3. What changes by level

| | Beginner (Intern / Junior, 0–1.5 yrs) | Intermediate (Mid, 2–4 yrs) | Experienced (Senior / Lead, 5+ yrs) |
|---|---|---|---|
| **Time box** | 4–6 h, 3-day window | 6–8 h, 5-day window | 8–10 h, 7-day window |
| **Scope** | One focused feature | A feature slice with integration | A system with explicit trade-offs plus a design doc |
| **We expect** | Fundamentals, clean components/functions, handles basic states, honest README | Handles real-world failure modes, sensible state/data design, tests on critical paths | Designs for scale and failure, defends trade-offs, production-grade testing and operability, raises the bar for others |
| **We forgive** | Missing tests beyond a few, simple styling, not optimised | Not every stretch goal, limited observability | Nothing essential. Scope cuts are fine **if explained**. |
| **"3" looks like** | Works, readable, handles loading/empty/error | Works under failure, well-structured, key tests | Robust, measured, documented decisions, reviewers learn something |

## 4. Scoring procedure

1. **Gate checks (pass/fail, before scoring):**
   - G1: Runs from the README within 10 minutes on a clean machine (reviewers may fix one trivial typo).
   - G2: At least **80% of Must-have requirements** are implemented.
   - G3: Work is the candidate's own. AI use is disclosed, and there's no copied solution from another candidate or the public internet without attribution.
   - Failing any gate means **no-proceed** unless the reviewer documents a strong reason.
2. **Two reviewers** score independently, using the assignment's weights.
3. **Weighted score** = Σ(score × weight). The range is 1.00–4.00.
4. If reviewers differ by **more than 0.5**, they discuss and reconcile before deciding.
5. **Decision bands:**

| Weighted score | Decision |
|---|---|
| **≥ 3.20** | Strong: proceed to review call |
| **2.70 – 3.19** | Proceed, with specific areas to probe in the call |
| **2.30 – 2.69** | Borderline: proceed only if other signals (resume, other rounds) are strong |
| **< 2.30** | No-proceed; send written feedback |

**Any single criterion scored 1** on C1, C2 or C7 caps the decision at "Borderline".

## 5. Universal red flags

- Money stored or calculated as floating point.
- Secrets committed to the repo.
- A README that claims features that don't exist.
- Swallowed errors (`catch {}`), or `any` everywhere in TypeScript.
- Tests that assert nothing meaningful, or snapshot everything.
- A giant single file, or deep abstraction layers for a tiny problem.
- The candidate can't explain their own code in the review call. **This overrides the written score.**

## 6. Universal green flags

- The README honestly lists what's missing and why.
- Thoughtful handling of the India constraints: slow networks, low-end devices, ₹ formatting, Hindi text length.
- Small, well-described commits that tell the story of the work.
- Evidence of measurement (Lighthouse/profiler screenshots, EXPLAIN plans, load test output) rather than claims.

## 7. Review call structure (45–60 min)

| Minutes | Activity |
|---|---|
| 0–5 | Intros, reset expectations |
| 5–20 | Candidate walks through the solution and one decision they're proud of |
| 20–40 | Reviewer probes: "what if" questions from the track's reviewer guide |
| 40–55 | Live extension: a small change to their own code (see reviewer guide) |
| 55–60 | Candidate questions |

## 8. Feedback template (sent to every candidate)

```
Hi <name>,

Thank you for completing the <assignment>. Summary of our review:

What worked well:
- …
- …

Where we'd have liked to see more:
- …
- …

Outcome: <proceeding to review call on <date> | not proceeding at this time>

— Aumbram Tech Team
```
