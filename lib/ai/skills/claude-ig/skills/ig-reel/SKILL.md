---
name: ig-reel
description: >
  Complete Instagram Reel production. Generates hook variants with scoring,
  timed script (0-30s structure), caption (500+ chars with save CTA), thumbnail
  concept, and full 5-category Content Quality Score. Optimized for 2026
  algorithm signals (watch time, DM-sends, saves). Covers simple tips (7-15s),
  technique explanations (15-30s), and mini-tutorials (30-60s).
  Use when user says "Reel", "Reel schreiben", "Reel skript", "neues Reel",
  "Reel erstellen", "video script", "reel topic".
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Grep
  - Glob
  - WebFetch
  - WebSearch
---

# IG Reel Producer -- Complete Reel Package

Creates publish-ready Instagram Reel packages: hook variants, timed script,
German caption, thumbnail concept, and quality score. Every Reel is optimized
for the 2026 algorithm where watch time beats all other signals.

**Key references:**
- `references/format-specs.md` -- Technical Reel specs (9:16, 1080x1920, safe zones)
- `references/hook-library.md` -- 50+ hook templates in 5 categories with selection logic
- `references/content-rules.md` -- Caption structure, CTA hierarchy, hashtag strategy
- `references/scoring-system.md` -- 100-point rubric (5 categories, weighted)

## Account Context

Load account context from `references/account-baseline.md`. If not configured, ask the user about their niche, audience, and voice.

## Duration Targets

| Content Type | Duration | When to Use |
|-------------|----------|-------------|
| Simple tip | 7-15s | Single fact, myth bust, quick habit change |
| Technique explanation | 15-30s | Exercise form, meal prep method, IF timing |
| Mini-tutorial | 30-60s | Step-by-step process, recipe, workout sequence |

Default to 15-30s unless the topic clearly requires shorter or longer format.

## Algorithm Priority (2026)

Every decision in this skill follows this ranking:

| Priority | Signal | Why |
|----------|--------|-----|
| 1 | Watch Time | First 3 seconds decide distribution. Full-watch ratio is king. |
| 2 | DM-Sends | 3-5x the weight of likes. "Send this to your friend who..." triggers. |
| 3 | Saves | Signal for lasting value. Drives Explore placement. |
| 4 | Likes | Weakest signal. Never optimize for likes at the cost of saves or DMs. |

## Workflow

### Phase 1: Topic Understanding

1. **Clarify the topic** -- If the user provides a topic, confirm:
   - What specific angle or claim does the Reel make?
   - Who within the audience benefits most? (e.g., IF beginners, women 50+, busy moms)
2. **Detect content type** -- Categorize the topic:

   | Type | Characteristics | Duration |
   |------|----------------|----------|
   | Myth Bust | Corrects a common misconception | 7-15s |
   | Quick Tip | Single actionable takeaway | 7-15s |
   | Technique | Shows how to do something properly | 15-30s |
   | Explanation | Breaks down a concept (e.g., IF windows, metabolism) | 15-30s |
   | Mini-Tutorial | Multi-step process with clear sequence | 30-60s |
   | Story/Transformation | Personal anecdote or client result | 15-30s |
   | Controversial Take | Challenges mainstream fitness advice with evidence | 15-30s |

3. **Set duration target** based on content type (see table above)
4. **If topic is vague**, ask the user ONE clarifying question. Do not ask multiple questions.

### Phase 2: Hook Selection

1. **Load** `references/hook-library.md`
2. **Select the best hook category** for the topic:

   | Category | Best For | Example Pattern |
   |----------|----------|----------------|
   | Curiosity Gap | Facts that surprise, myth busts | "Das passiert wirklich, wenn du..." |
   | Pattern Interrupt | Contrarian takes, unexpected advice | "Vergiss alles, was du ueber X gehoert hast" |
   | Identity Trigger | Audience self-recognition | "Wenn du ueber 40 bist und..." |
   | Pain Point | Problem the audience feels daily | "Du isst wenig und nimmst trotzdem zu?" |
   | Authority | Science-backed claims, credentials | "Studien zeigen: X ist falsch" |

3. **Generate 3 hook variants**, each from a different category or angle
4. **Score each hook** on 4 criteria (1-5 scale each, max 20):

   | Criterion | What it measures |
   |-----------|-----------------|
   | Curiosity Gap | Does it create an open loop the viewer MUST close? |
   | Pattern Interrupt | Does it break the scroll pattern in the first frame? |
   | Identity Trigger | Does the target audience instantly feel "this is for me"? |
   | First-3s Clarity | Can the viewer understand the hook within 3 seconds? |

5. **Select the highest-scoring hook** as primary, note alternatives
6. **Hook output format**:
   ```
   Hook A (Score: X/20) [SELECTED]
   Category: [category]
   Text: "[hook text in German]"
   Visual: [what the viewer sees in the first frame]

   Hook B (Score: X/20)
   ...

   Hook C (Score: X/20)
   ...
   ```

### Phase 3: Script Writing

Structure the Reel body with precise timing segments:

| Segment | Timing | Purpose | Guideline |
|---------|--------|---------|-----------|
| Hook | 0-3s | Stop the scroll | Selected hook from Phase 2. Maximum 10 words on screen. |
| Problem | 3-8s | Create tension | Name the pain or misconception the audience recognizes. |
| Solution | 8-20s | Deliver value | The core content. Be specific, not generic. Use numbers, timings, or steps. |
| Insight/Payoff | 20-30s | Reward + CTA | Surprising takeaway, reframe, or call to action. Leave viewer thinking. |

**Timing adjustments by duration target:**
- **7-15s Reels**: Compress to Hook (0-2s) + Problem/Solution combined (2-10s) + Payoff (10-15s)
- **15-30s Reels**: Use the standard 4-segment structure above
- **30-60s Reels**: Expand Solution to 8-40s with multiple steps or examples, Payoff at 40-60s

**Script rules:**
- Write in the creator's voice as defined in account-baseline.md (default: warm, direct, empowering)
- Use "du" (never "Sie", never "ihr" in Reels since she talks directly to camera)
- Short sentences for spoken delivery. Max 15 words per sentence.
- Include parenthetical delivery notes: (Pause), (betont), (laechelt), (Blickwechsel)
- Mark on-screen text separately from spoken text
- Every sentence must earn its seconds. Cut anything that does not add value.
- No filler phrases: "In diesem Video zeige ich dir" or "Heute geht es um" are banned openers
- Science references: cite briefly ("Eine Studie aus 2024 zeigt..."), never lecture-style

**Script output format:**
```
[0-3s] HOOK
Spoken: "[text]"
On-screen: "[text overlay]"
Visual: [camera angle, gesture, prop]

[3-8s] PROBLEM
Spoken: "[text]"
On-screen: "[text overlay if any]"
Visual: [description]

[8-20s] SOLUTION
Spoken: "[text]"
On-screen: "[key points as text overlays]"
Visual: [description]

[20-30s] INSIGHT/PAYOFF
Spoken: "[text]"
On-screen: "[text overlay]"
Visual: [description]
CTA visual: [save icon animation / "Sende das deiner Freundin" text]
```

### Phase 4: Caption Writing

Write a German caption following these rules:

1. **Length**: 500+ characters (Instagram rewards longer captions in 2026)
2. **Opener**: Use a hook variation, NOT a repeat of the Reel hook. Different angle on the same topic.
3. **Body structure**:
   - Line 1: Hook variation (stops the scroller who reads captions)
   - Line 2-3: Expand on the Reel's core message with additional context
   - Line 4-5: Personal touch or "why I care about this" (the creator's voice, per account-baseline.md)
   - Line 6: Save CTA ("Speicher dir das fuer spaeter") or DM CTA ("Schick das deiner Freundin")
4. **CTA hierarchy** (pick the strongest fit):

   | CTA Type | When to Use | Example |
   |----------|-------------|---------|
   | Save | Evergreen tips, reference content | "Speicher dir das, damit du es nicht vergisst." |
   | DM-Send | Relatable content, "tag your friend" moments | "Schick das deiner Freundin, die das auch kennt." |
   | Comment | Questions, polls, "tell me your experience" | "Schreib mir in die Kommentare, wie es bei dir ist." |
   | Link | Product launch, blog reference (rare for Reels) | "Link in Bio fuer mehr." |

5. **Hashtags**: 3-5 niche-specific hashtags at the end. NEVER use generic tags.

   **Good**: #intermittentfastingfrauen #stoffwechselbooster #fitab40
   **Bad**: #fitness #motivation #healthy #instagood

6. **Formatting**: Use line breaks for readability. No wall of text.
7. **No em dashes**. Use commas, periods, or colons instead.

### Phase 5: Thumbnail Concept

Describe a thumbnail that maximizes tap-through from the Reels grid:

1. **Text overlay**: 3-5 words max, large bold font, readable at grid size
2. **Visual**: What the creator is doing/wearing, background, props
3. **Emotion**: What facial expression or body language conveys
4. **Color contrast**: Ensure text is readable against the background
5. **Safe zones**: Text within the center 80% (top/bottom 10% are cropped in grid view, per `references/format-specs.md`)

**Thumbnail output format:**
```
Thumbnail Concept:
- Text: "[3-5 word overlay]"
- Visual: [description of the frame]
- Emotion: [expression/energy]
- Layout: [where text sits, contrast notes]
```

### Phase 6: Quality Scoring

Apply the full 5-category Content Quality Score from `references/scoring-system.md`.

| Category | Weight | Sub-Criteria |
|----------|--------|-------------|
| Hook Strength | 25 pts | Curiosity gap (8), pattern interrupt (6), identity trigger (6), first-3s clarity (5) |
| Content Quality | 25 pts | Value density (8), structure/flow (6), problem-solution clarity (6), creator voice authenticity (5) |
| Caption & CTA | 20 pts | Length 500+ chars (5), save/DM CTA present (5), hook variation opener (5), hashtag quality (5) |
| Format Compliance | 15 pts | Correct specs 9:16 (4), safe zones respected (4), thumbnail concept (4), duration target met (3) |
| Algorithm Signals | 15 pts | Save/DM optimization (5), originality (4), non-controversial (3), watch time design (3) |

**Scoring process:**
1. Score each sub-criterion individually
2. Sum per category
3. Sum all categories for the total (0-100)
4. Assign rating band:

   | Score | Rating | Action |
   |-------|--------|--------|
   | 90-100 | Publish | Ready to post, flagship content |
   | 80-89 | Strong | Minor polish, ready for publication |
   | 60-79 | OK | Targeted improvements needed (list specific fixes) |
   | < 60 | Revise | Significant rework required (auto-revise before delivery) |

5. If score < 60, revise the weakest category and re-score before delivering
6. Always include 2-3 specific improvement suggestions, even for high scores

**Score output format:**
```
Content Quality Score: XX/100 [RATING]

| Category | Score | Notes |
|----------|-------|-------|
| Hook Strength | XX/25 | [brief note] |
| Content Quality | XX/25 | [brief note] |
| Caption & CTA | XX/20 | [brief note] |
| Format Compliance | XX/15 | [brief note] |
| Algorithm Signals | XX/15 | [brief note] |

Improvement suggestions:
1. [specific, actionable fix]
2. [specific, actionable fix]
3. [specific, actionable fix]
```

### Phase 7: Delivery

Output the complete Reel package in this format:

```
## Reel Package: [Topic Title]

### Content Type & Duration
- Type: [Myth Bust / Quick Tip / Technique / Explanation / Mini-Tutorial / Story / Controversial Take]
- Target duration: [Xs]

### Hook (3 Variants)
[Hook A, B, C with scores from Phase 2]

### Script
[Full timed script from Phase 3]

### Caption
[Complete German caption from Phase 4]

### Thumbnail
[Thumbnail concept from Phase 5]

### Content Quality Score
[Full scored rubric from Phase 6]

### Production Notes
- Filming setup: [camera angle, lighting, location suggestions]
- Props needed: [any items visible in the script]
- Audio: [trending audio suggestion or original voiceover]
- Editing: [cut rhythm, text animation style, transition notes]

### Next Steps
- Review hook selection (alternatives available)
- Film with the timed script as teleprompter guide
- Post caption as-is or adjust personal anecdotes
- Use thumbnail concept for cover image selection
```

## Quality Gates

These are hard blockers. Content that violates any gate is NOT delivered:

| # | Gate | Rule |
|---|------|------|
| G1 | Score before delivery | NEVER deliver without a Content Quality Score |
| G2 | Em dashes | NEVER use em dashes in any output (captions, hooks, scripts, notes) |
| G3 | Safe zones | NEVER place text in format-specific unsafe zones (check format-specs.md) |
| G4 | Generic hashtags | NEVER use #fitness, #motivation, #healthy, #instagood, or similar |
| G5 | Filler openers | NEVER start a Reel with "In diesem Video" or "Heute geht es um" |
| G6 | Duration mismatch | NEVER write a 60s script for a topic that needs 15s (match type to duration) |
| G7 | Caption length | NEVER deliver a caption under 500 characters |

## Anti-Patterns (Never Do These)

| Anti-Pattern | Why |
|-------------|-----|
| Copy hook templates verbatim | 2026 Originality Score penalizes recycled formats |
| Optimize for likes over saves | Likes are the weakest algorithm signal |
| Write "Sie" instead of "du" | Most creators use "du" in Reels for direct audience connection |
| Use medical claims without hedging | Legal risk; always say "kann helfen" not "hilft" |
| Skip the problem segment | Without tension, the solution has no weight |
| Wall-of-text captions | Line breaks are mandatory for readability |
| Recommend controversial opinion Reels | High comments, zero saves = algorithm ignores them |
