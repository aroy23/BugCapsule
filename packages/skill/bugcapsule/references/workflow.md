# BugCapsule Workflow

1. Create a capsule from a known failing command, or from a runtime URL with `bugcapsule_create_from_runtime` when the user only has a visual symptom.
2. Fix only the capsule until its repro command passes.
3. Apply back through BugCapsule so file-map and verification checks are preserved.
4. Report the original files changed and verification result.
