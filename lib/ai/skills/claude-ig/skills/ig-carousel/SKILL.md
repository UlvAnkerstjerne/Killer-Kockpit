---
name: ig-carousel
description: >
  Plan Instagram carousel posts with optimized slide structure, compelling
  cover hooks, and save-driven CTAs. Scores the carousel against engagement
  benchmarks before delivery.
allowed-tools:
  - Read
  - Write
  - Grep
  - Glob
---

# IG Carousel -- Plan high-performing Instagram carousels

**Key references:**
- `references/format-specs.md` -- dimensions, slide count limits, text sizing
- `references/hook-library.md` -- proven hook patterns with performance data
- `references/content-rules.md` -- brand voice, banned topics, caption rules
- `references/scoring-system.md` -- engagement scoring criteria and thresholds

---

## Phase 1: Context

1. Confirm the topic and goal (educate, convert, build authority, entertain).
2. Identify the target audience segment if not obvious.
3. Load all key reference files before proceeding.
4. Check hook-library.md for the highest-performing hook category matching this topic.

## Phase 2: Cover Slide Hook

The cover slide follows the **same rules as Reel hooks**: it must stop the scroll within 1 second.

### Cover Hook Rules
- Maximum 8 words on the cover image
- Must create a curiosity gap or emotional trigger
- Use one of these proven patterns from hook-library.md:
  - **Contrarian:** "Hoer auf mit [common advice]"
  - **Numbered list:** "5 Fehler, die dein Training ruinieren"
  - **Before/After:** Visual transformation tease
  - **Question:** "Warum nimmst du nicht ab?"
  - **Bold claim:** "Das veraendert ALLES"
- Font must be large, bold, and readable at thumbnail size
- No logo or branding on the cover (it kills curiosity)

Document the chosen hook pattern and exact cover text.

## Phase 3: Slide Structure

Follow the **Hook > Content > Reveal > CTA** arc:

| Slide | Role | Rules |
|-------|------|-------|
| 1 | Hook / Cover | Max 8 words, curiosity gap, see Phase 2 |
| 2-3 | Problem / Setup | Establish the pain point or question |
| 4-7 | Content / Value | One idea per slide, max 15 words on-slide |
| 8-9 | Reveal / Payoff | Deliver the insight or transformation |
| 10 | CTA | Save-focused or "Part 2" tease |

### Slide Content Rules
- **One idea per slide.** If you need a comma, you need a new slide.
- **Max 15 words per slide** (text overlay). Fewer is better.
- **Visual consistency:** same background style, font, and color palette across all slides.
- **Reading direction:** top-to-bottom, left-to-right. No scattered text.
- **Swipe motivation:** each slide must create a reason to see the next one.

Build out each slide with:
1. Slide number
2. Headline text (on-slide, max 15 words)
3. Supporting visual description
4. Swipe motivation note (why they will swipe to the next slide)

## Phase 4: Last Slide CTA

The final slide determines whether the post gets saved or shared. Choose one:

| CTA Type | When to Use | Example (German) |
|----------|-------------|-------------------|
| Save CTA | Educational content | "Speichere dir das fuer spaeter" |
| Share CTA | Relatable content | "Teile das mit jemandem, der das braucht" |
| Part 2 Tease | Series content | "Teil 2 kommt morgen. Folgen, damit du es nicht verpasst" |
| Comment CTA | Opinion content | "Welcher Punkt trifft auf dich zu? Schreib 1, 2 oder 3" |
| DM CTA | Lead generation | "Schreib mir PLAN und ich schick dir meinen Guide" |

The CTA must be specific. Never use generic "Link in Bio" as the primary CTA.

## Phase 5: Caption

Write a caption that complements (not repeats) the carousel content:

- First line: hook that works even without seeing the carousel
- Body: expand on one point from the carousel, add personal perspective
- End: CTA matching the last slide
- Hashtags: 3-5 niche hashtags, no generic ones (#fitness, #motivation are banned)
- Max 300 words

## Phase 6: Scoring

Score the carousel using scoring-system.md criteria:

| Criterion | Weight | Score (1-10) |
|-----------|--------|--------------|
| Hook strength | 25% | |
| Slide flow / swipe motivation | 20% | |
| Value density | 20% | |
| CTA effectiveness | 15% | |
| Visual consistency | 10% | |
| Caption quality | 10% | |

**Minimum passing score: 7.0 weighted average.**

If below 7.0, identify the weakest criterion and revise before delivery.

## Phase 7: Delivery

Output format:

```
## Carousel Brief

**Topic:** [topic]
**Goal:** [goal]
**Slides:** [count]
**Hook Pattern:** [pattern from hook-library.md]
**Score:** [X.X / 10]

### Slide Breakdown

#### Slide 1 (Cover)
- Text: "[cover text]"
- Visual: [description]

#### Slide 2
- Text: "[text]"
- Visual: [description]
- Swipe motivation: [why they swipe]

...

### Caption
[full caption text]

### Production Notes
- [design notes, asset needs, font/color suggestions]
```
