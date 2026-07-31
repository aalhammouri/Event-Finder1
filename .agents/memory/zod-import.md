---
name: Zod import convention
description: Which zod import path to use in which package type
---
In `artifacts/api-server` routes: `import { z } from "zod"` (not zod/v4).
In `lib/*` packages: `import { z } from "zod/v4"`.
**Why:** api-server has its own zod dep resolution; lib packages use workspace catalog which pins zod/v4.
**How to apply:** Always check which package type you're editing before writing the import.
