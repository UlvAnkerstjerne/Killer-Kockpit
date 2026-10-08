---
name: ig-analyze
description: >
  API-driven Instagram post and account performance analysis. Pulls live data
  via Instagram MCP tools, calculates engagement metrics, detects performance
  patterns, and benchmarks against account baselines.
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

# IG Analyze -- API-driven Instagram performance analysis

**Key references:**
- `references/account-baseline.md` -- current benchmarks, follower count, historical averages
- `references/scoring-system.md` -- metric definitions, scoring thresholds, weighted formulas

**CRITICAL RULE:** This skill MUST use live API data. Never guess, estimate, or fabricate metrics. If an API call fails, report the failure. Do not fill in placeholder numbers.

---

## Phase 1: Data Collection

Pull data using Instagram MCP tools in this order:

1. **Account overview:**
   ```
   mcp__claude_ai_Instagram_MCP__get_user_info
   ```
   Capture: follower count, following count, media count, bio, profile pic.

2. **Recent media:**
   ```
   mcp__claude_ai_Instagram_MCP__get_user_media
   ```
   Fetch the most recent 25 posts. For each, capture: id, type (carousel/reel/image), timestamp, caption, like count, comment count.

3. **Post-level insights** (for each post):
   ```
   mcp__claude_ai_Instagram_MCP__get_post_insights
   ```
   Capture: reach, impressions, saves, shares, video views (if reel), profile visits.

4. **Account-level insights:**
   ```
   mcp__claude_ai_Instagram_MCP__get_user_insights
   ```
   Capture: reach, impressions, follower growth, profile visits over the requested period.

Bundle independent API calls in parallel where possible. Do not make serial calls when parallel is available.

## Phase 2: Metric Calculation

Calculate the following metrics from the collected data:

### Per-Post Metrics
| Metric | Formula |
|--------|---------|
| Engagement Rate | (likes + comments + saves + shares) / reach * 100 |
| Save Rate | saves / reach * 100 |
| DM-Send Rate | shares / reach * 100 |
| Completion Rate (Reels) | average watch time / duration * 100 |
| Reach-to-Follower Ratio | reach / follower_count * 100 |

### Account-Level Metrics
| Metric | Formula |
|--------|---------|
| Average Engagement Rate | mean of per-post engagement rates |
| Save Rate Trend | save rate comparison: last 7 posts vs prior 7 |
| Reach Growth | (current period reach - prior period reach) / prior * 100 |
| Content Mix | % reels vs % carousels vs % single images |

Round all percentages to 2 decimal places.

## Phase 3: Pattern Detection

Analyze the calculated metrics to identify patterns:

1. **Best performers:** Top 3 posts by engagement rate. Note format, hook category, posting day/time.
2. **Worst performers:** Bottom 3 posts. Note format, hook category, posting day/time.
3. **Format comparison:** Average engagement rate per format (reel, carousel, image).
4. **Hook category analysis:** If hook-library.md categories are identifiable in captions, group performance by category.
5. **Posting time analysis:** Group by day of week and hour. Identify best and worst windows.
6. **Save rate leaders:** Top 3 posts by save rate (these indicate high-value content).

## Phase 4: Benchmark Comparison

Load `references/account-baseline.md` and compare current metrics:

| Metric | Baseline | Current | Delta | Status |
|--------|----------|---------|-------|--------|
| Engagement Rate | X% | Y% | +/-Z% | Above/Below |
| Save Rate | X% | Y% | +/-Z% | Above/Below |
| Reach-to-Follower | X% | Y% | +/-Z% | Above/Below |
| Reel Completion | X% | Y% | +/-Z% | Above/Below |

Flag any metric that is more than 20% below baseline as a warning.

## Phase 5: Quality Check

Before delivering the report, verify:

- [ ] All metrics are based on actual API data (no estimates)
- [ ] Per-post and account-level metrics are both included
- [ ] At least one actionable insight per pattern detected
- [ ] Benchmark comparison uses current account-baseline.md values
- [ ] Numbers are internally consistent (engagement rate matches component metrics)

## Phase 6: Report Output

Deliver as a structured Markdown report:

```
## Instagram Performance Report

**Period:** [date range]
**Posts analyzed:** [count]
**Follower count:** [current]

### Key Metrics (Account Average)
| Metric | Value | vs Baseline |
|--------|-------|-------------|
| Engagement Rate | X% | +/-Y% |
| Save Rate | X% | +/-Y% |
| Reach-to-Follower | X% | +/-Y% |

### Top Performers
1. [Post description] -- [engagement rate] -- [why it worked]
2. ...
3. ...

### Format Breakdown
| Format | Avg Engagement | Avg Save Rate | Count |
|--------|---------------|---------------|-------|

### Patterns Detected
- [pattern 1 with actionable recommendation]
- [pattern 2 with actionable recommendation]

### Warnings
- [any metric >20% below baseline]

### Recommendations
1. [specific, actionable recommendation]
2. [specific, actionable recommendation]
3. [specific, actionable recommendation]
```

If the user requests a specific post analysis (single post), skip account-level metrics and deliver only per-post analysis with benchmark comparison.
