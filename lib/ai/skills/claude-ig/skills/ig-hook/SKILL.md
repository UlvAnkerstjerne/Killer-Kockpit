---
name: ig-hook
description: >
  Generate and score Instagram hooks. Produces 3 hook variants across 5 categories
  (Correction, Identity Trigger, Bold Claim, Curiosity Gap, Relatable Pain),
  scores each on a 25-point rubric, and outputs the top 2 as A/B variants with
  text overlay, spoken text, and visual action. Supports compound hooks for
  higher scores. Use when user says "hook", "hook schreiben", "hooks generieren",
  "reel hook", "ig hook", "hook ideen", "hook varianten".
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Grep
  - Glob
---

# IG Hook Generator -- First 3 Seconds That Stop the Scroll

Generates, scores, and presents Instagram hook variants optimized for the
target audience defined in `references/account-baseline.md`. Every hook is
designed to maximize watch time by winning the first 3 seconds.

Load account context (niche, audience, voice) from `references/account-baseline.md`.
If not configured, ask the user about their niche, audience, and voice.

**Key references:**
- `references/hook-library.md` -- 50+ templates, 5 categories, compound hook rules
- `references/scoring-system.md` -- Hook Strength sub-criteria (25pts)
- `references/format-specs.md` -- First 3 seconds requirements per format

## Workflow

### Phase 1: Context Gathering

Collect the following from the user (ask once if missing):

1. **Topic** -- What is the Reel/Carousel/Story about?
   - Example: "Intervallfasten Fehler", "Proteinbedarf ab 40", "Bauchfett loswerden"
2. **Format type** -- Reel, Carousel, or Story?
   - Default: Reel (if not specified)
3. **Content angle** -- What is the core insight, myth, or transformation?
   - Example: "Die meisten essen ZU WENIG Protein", "Bauchfett hat nichts mit Sit-Ups zu tun"

If the user provides all three in one message, skip asking and proceed directly.

### Phase 2: Category Selection

Select hook categories from the 5 available types. Load `references/hook-library.md`
for templates and examples within each category.

| # | Category | Mechanism | When to use |
|---|----------|-----------|-------------|
| 1 | **Correction** | "Du machst X falsch" / "Das stimmt nicht" | Myth-busting, common mistakes, misconceptions |
| 2 | **Identity Trigger** | "Frauen ab 40, die..." / "Wenn du zu denen gehorst, die..." | Audience self-selection, personal relevance |
| 3 | **Bold Claim** | "X ist der grosste Fehler" / "Vergiss alles, was du uber Y weisst" | Strong takes backed by science, pattern interrupts |
| 4 | **Curiosity Gap** | "Was passiert, wenn du X machst..." / "Das hat niemand auf dem Schirm" | Unexpected facts, counterintuitive insights |
| 5 | **Relatable Pain** | "Kennst du das..." / "Wenn du abends vor dem Kuhlschrank stehst..." | Shared struggles, emotional connection, daily situations |

**Selection rules:**
- The 3 generated hooks MUST use at least 2 different categories
- Compound hooks (combining 2+ categories) are encouraged and score higher
- Check `references/hook-library.md` for proven templates in each category
- Match the category to the content angle (myth = Correction, personal = Identity Trigger, etc.)

### Phase 3: Hook Generation

Generate exactly 3 hook variants. Each hook MUST include all three elements:

| Element | What it is | Example |
|---------|-----------|---------|
| **Text Overlay** | Bold text shown on screen in the first 3 seconds | "DAS zerstort deinen Stoffwechsel" |
| **Spoken Text** | What the creator says out loud in the first 3 seconds | "Wenn du das morgens als Erstes machst, sabotierst du deinen gesamten Fettstoffwechsel." |
| **Visual Action** | What the viewer sees the creator doing | Creator schaut direkt in die Kamera, schuttelt den Kopf, halt eine Kaffeetasse hoch |

**Generation rules:**
- Write all hook text in German
- At least 1 hook should be a compound hook (combining 2+ categories)
- Text overlay: max 6-8 words, must be readable in under 2 seconds
- Spoken text: max 2 sentences, must be completable in 3 seconds
- Visual action: must create movement or contrast that stops the scroll
- Every hook must work independently (no context from the rest of the Reel needed)
- Tag each hook with its category (or categories for compound hooks)

**Output format per hook:**

```
### Hook [A/B/C]: [Category] (+ [Category] if compound)

**Text Overlay:** [bold on-screen text]
**Spoken Text:** "[what the creator says]"
**Visual Action:** [what the viewer sees]
```

### Phase 4: Hook Scoring

Score each of the 3 hooks using the Hook Strength rubric (25 points max).
Load `references/scoring-system.md` for detailed sub-criteria.

| Sub-criterion | Max | What it measures |
|---------------|-----|-----------------|
| Curiosity Gap | 5 pts | Does the hook create an open loop the viewer needs to close? |
| Pattern Interrupt | 5 pts | Does it break the scroll pattern visually or verbally? |
| Identity Trigger | 5 pts | Does the viewer think "das bin ich" or "das betrifft mich"? |
| First-3s Clarity | 5 pts | Is the hook's promise clear within 3 seconds? No ambiguity. |
| Compound Mechanics | 5 pts | Does it layer 2+ hook categories for stronger pull? Single-category hooks cap at 3. |

**Scoring rules:**
- Score each sub-criterion with a whole number (0-5)
- Single-category hooks can score max 3/5 on Compound Mechanics
- Compound hooks that cleanly integrate 2+ categories score 4-5 on Compound Mechanics
- Forced or awkward category combinations score lower than clean single-category hooks
- Reference `references/scoring-system.md` for per-point thresholds within each sub-criterion

**Score each hook in a table:**

```
| Sub-criterion | Hook A | Hook B | Hook C |
|---------------|--------|--------|--------|
| Curiosity Gap | X/5 | X/5 | X/5 |
| Pattern Interrupt | X/5 | X/5 | X/5 |
| Identity Trigger | X/5 | X/5 | X/5 |
| First-3s Clarity | X/5 | X/5 | X/5 |
| Compound Mechanics | X/5 | X/5 | X/5 |
| **Total** | **X/25** | **X/25** | **X/25** |
```

### Phase 5: A/B Variant Output

Present the top 2 scoring hooks as the final A/B variants.

**For each of the 2 selected hooks, output:**

1. The full hook (text overlay, spoken text, visual action) from Phase 3
2. The score breakdown from Phase 4
3. A 2-3 sentence explanation of WHY this hook works, referencing the specific
   mechanisms that drive its score (e.g., "The identity trigger 'Frauen ab 40'
   immediately filters for the target audience, while the correction 'das stimmt
   nicht' creates a curiosity gap the viewer needs to resolve.")

**Output format:**

```
## A/B Hook Variants for: [Topic]

### Variant A: [Category] -- [Score]/25
**Text Overlay:** [text]
**Spoken Text:** "[text]"
**Visual Action:** [description]

**Why this works:** [2-3 sentences explaining the mechanisms]

---

### Variant B: [Category] -- [Score]/25
**Text Overlay:** [text]
**Spoken Text:** "[text]"
**Visual Action:** [description]

**Why this works:** [2-3 sentences explaining the mechanisms]

---

### Recommendation
[1-2 sentences on which variant to test first and why, or when to use each]
```

**Tie-breaking:** If two hooks have the same total score, prefer the one with
the higher Curiosity Gap score. If still tied, prefer the compound hook.

## Quality Gates

These gates are inherited from the parent `ig` skill. A hook that violates any
gate MUST NOT be delivered.

| # | Gate | Rule |
|---|------|------|
| G1 | Score before delivery | NEVER deliver hooks without scoring all 3 variants |
| G2 | Em dashes | NEVER use em dashes in hook text, spoken text, or any output |
| G4 | Controversial opinions | NEVER generate hooks built on controversial opinions (high comments, zero saves). This includes: diet shaming, attacking other fitness approaches, medical claims without scientific backing, divisive social commentary. |
| G7 | Safe zones | NEVER place text overlay in format-specific unsafe zones (check `references/format-specs.md`) |

## Anti-Patterns

| Anti-Pattern | Why |
|-------------|-----|
| All 3 hooks from the same category | Reduces variety, misses stronger alternatives |
| Text overlay longer than 8 words | Unreadable in 2 seconds, kills the hook |
| Spoken text longer than 3 seconds | Exceeds the hook window, loses viewers |
| Vague hooks ("Wusstest du das?") | No specificity, no curiosity gap, no identity trigger |
| Clickbait without payoff | Destroys trust with the creator's audience |
| Copy competitor hooks verbatim | Originality Score (2026 algorithm) penalizes recycled formats |
| Controversial opinion as hook | Generates comments but zero saves, algorithm ignores (G4) |
| Missing visual action | A hook is not just words; the visual must contribute to the stop |
