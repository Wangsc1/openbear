"""Agent domain policies on the shared runtime.

No independent execution registry, scheduler or model loop belongs here.
Profiles, Plan, task state, permissions and retained-context rules are domain
contracts; legacy rath_* SQLite/HTTP identifiers remain storage/API compatibility.
"""
