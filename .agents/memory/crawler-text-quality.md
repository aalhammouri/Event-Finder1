---
name: Crawler text extraction quality
description: How fetchPage extracts clean text for AI extraction
---
- Removes: script, style, nav, header, footer, head, aside, iframe, noscript, role=navigation/banner/complementary, common CSS class noise (.cookie-banner, .nav, .navbar, etc.)
- Prefers: main, article, [role=main], .main-content, #main-content, .post-content, .entry-content, .content-area, #content
- Falls back to body if no main content area found.
- Text truncated to 8000 chars before sending to gpt-4o-mini.
**Why:** Without stripping nav/header/footer, the 8000-char window fills with irrelevant navigation text, pushing actual event content out.
