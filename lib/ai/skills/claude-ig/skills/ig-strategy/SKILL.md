---
name: ig-strategy
description: >
  Content strategy and positioning analysis for Instagram. Pulls live API data,
  maps audience segments, reviews content pillar distribution, identifies gaps,
  and delivers a 30/60/90-day growth strategy.
allowed-tools:
  - Read
  - Write
  - Grep
  - Glob
  - Bash
  - mcp__claude_ai_Instagram_MCP__get_user_info
  - mcp__claude_ai_Instagram_MCP__get_user_media
  - mcp__claude_ai_Instagram_MCP__get_post_insights
  - mcp__claude_ai_Instagram_MCP__get_user_insights
---

# IG Strategy -- Content strategy and positioning analysis

**Key references:**
- `references/account-baseline.md` -- current metrics, content mix, audience data
- `references/competitor-framework.md` -- competitor landscape, positioning map
- `references/content-rules.md` -- brand voice, content pillars, banned topics

---

## Phase 1: Account Analysis

Pull live data to establish the current state:

1. **Account info:** `get_user_info` for follower count, bio, media count.
2. **Recent media:** `get_user_media` for last 30-50 posts.
3. **Post insights:** `get_post_insights` for reach, saves, shares per post.
4. **Account insights:** `get_user_insights` for follower demographics, reach trends, activity times.

Calculate from the data:
- Average engagement rate (overall and by format)
- Save rate trend (increasing, stable, declining)
- Reach-to-follower ratio trend
- Content type distribution (actual vs baseline targets)
- Posting frequency and consistency score

Load `references/account-baseline.md` for comparison with historical data.

**RULE:** All strategic recommendations must be grounded in actual data. Never make recommendations based on assumptions about performance.

## Phase 2: Audience Mapping

Build an audience profile from available data and niche knowledge:

### Demographics (from API insights if available)
- Age distribution
- Gender split
- Top locations (cities/countries)
- Active hours and days

### Psychographics (from content performance patterns)
- What topics get the highest save rate? (indicates what the audience values)
- What topics get the highest share rate? (indicates what they identify with)
- What gets the most comments? (indicates what they have opinions on)
- What gets ignored? (indicates misalignment)

### Audience Segments
Define 2-4 audience segments based on the data:

| Segment | Description | Content Preference | Engagement Style |
|---------|-------------|-------------------|-----------------|
| [Name] | [who they are] | [what they want] | [how they interact] |

For each segment, note:
- Which current content serves them well
- What content is missing for them
- Their likely position in the customer journey (awareness, consideration, decision)

## Phase 3: Content Pillar Review

Compare current content distribution against ideal targets:

### Current Distribution (from Phase 1 data)
Count posts per pillar from the last 30 posts and calculate percentages.

### Ideal Distribution
| Pillar | Target % | Current % | Delta | Action |
|--------|----------|-----------|-------|--------|
| Educational | 40% | ?% | ?% | Increase/Decrease/Maintain |
| Personal | 25% | ?% | ?% | Increase/Decrease/Maintain |
| Community | 20% | ?% | ?% | Increase/Decrease/Maintain |
| Promotional | 15% | ?% | ?% | Increase/Decrease/Maintain |

### Pillar Depth Analysis
For each pillar, assess:
- Topic variety within the pillar (are we repeating the same 3 topics?)
- Format variety within the pillar (is educational always carousels?)
- Performance consistency (is one pillar reliably strong or volatile?)

## Phase 4: Gap Identification

Identify underrepresented areas across three dimensions:

### Topic Gaps
- Topics relevant to the niche that have never been covered
- Topics covered once but never revisited despite good performance
- Trending topics in the fitness/nutrition space not yet addressed

### Format Gaps
- Formats not being used (e.g., no carousels, no collaborative posts)
- Formats underperforming due to execution, not audience disinterest
- New Instagram features not yet adopted (e.g., Threads cross-posting, Remix)

### Hook Category Gaps
- Hook patterns from hook-library.md not yet tested
- Over-reliance on one hook category
- Emerging hook trends not yet adopted

### Positioning Gap
- What does the account stand for? Is it clear from the last 30 posts?
- Could a new follower understand the value proposition within 9 grid posts?
- Is there a unique angle that differentiates from competitors?

## Phase 5: Growth Strategy

Build a phased 30/60/90-day growth strategy:

### Days 1-30: Foundation
Focus on quick wins and fixing critical gaps.
- 3-5 specific actions with expected metric impact
- Each action must address a finding from Phases 2-4
- Include: content mix adjustments, hook experiments, posting schedule optimization
- Measurable targets for each action

### Days 31-60: Expansion
Build on foundation wins and test new approaches.
- 3-5 strategic initiatives (e.g., series content, collaborations, new pillar)
- Each initiative tied to an audience segment from Phase 2
- Include: format experiments, audience growth tactics, engagement boosters
- Measurable targets for each initiative

### Days 61-90: Optimization
Refine based on 60 days of data and scale what works.
- 2-3 scaling decisions (double down on winners, cut losers)
- Long-term positioning adjustments
- Community building and loyalty strategies
- Revenue/conversion optimization (if applicable)

## Phase 6: Quality Check

Validate the strategy:

- [ ] Every recommendation traces back to a specific data point
- [ ] Audience segments are based on actual engagement patterns
- [ ] Content pillar targets are realistic given current resources
- [ ] Growth targets are ambitious but achievable (not 10x in 30 days)
- [ ] Strategy accounts for the account's niche and audience language
- [ ] No generic advice (every point is specific to this account)
- [ ] Competitor context is included where relevant

## Phase 7: Delivery

Output as a structured strategy document:

```
## Instagram Content Strategy

**Account:** [handle]
**Current Followers:** [count]
**Analysis Period:** [date range]
**Posts Analyzed:** [count]

### Current State Summary
- Engagement Rate: X% (baseline: Y%)
- Best Format: [format] at X% engagement
- Strongest Pillar: [pillar] at X% engagement
- Posting Frequency: X/week

### Audience Profile
[Segment table from Phase 2]

### Content Pillar Rebalancing
[Distribution table from Phase 3]

### Key Gaps Identified
1. [gap with impact assessment]
2. [gap with impact assessment]
3. [gap with impact assessment]

### 30-Day Plan
| Action | Expected Impact | Metric Target | Priority |
|--------|----------------|---------------|----------|

### 60-Day Plan
| Initiative | Expected Impact | Metric Target | Priority |
|------------|----------------|---------------|----------|

### 90-Day Plan
| Strategy | Expected Impact | Metric Target | Priority |
|----------|----------------|---------------|----------|

### Key Metrics to Track
| Metric | Current | 30-Day Target | 90-Day Target |
|--------|---------|---------------|---------------|
```
