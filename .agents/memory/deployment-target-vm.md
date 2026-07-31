---
name: Switching deployment target (autoscale <-> Reserved VM)
description: Why a task agent cannot switch deploymentTarget, and who can.
---

Changing `deploymentTarget` (e.g. autoscale -> "vm" / Reserved VM) cannot be done from a task agent.

**Why:** Direct edits to `.replit` are rejected ("Direct edits to .replit ... are not allowed"), and the `deployConfig()` callback the deployment skill references is NOT registered in the code_execution sandbox (ReferenceError). skillSearch finds no matching tool either.

**How to apply:** Treat the deployment-target switch as a user action in the Publishing UI (Advanced settings) done from the main project, not something a task agent can automate. Note it as drift and tell the user to select it when publishing.
