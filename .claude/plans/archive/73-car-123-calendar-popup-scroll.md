# CAR-123: Week-view event popup scrolls with page

## Problem

Calendar week-view detail bubble uses `position: fixed` with click-time viewport coords, so it stays put when the page scrolls.

## Fix

Anchor the bubble with `position: absolute` inside a non-clipping `relative` week shell; compute top/left relative to that shell at click time so it stays beside the event while scrolling.
