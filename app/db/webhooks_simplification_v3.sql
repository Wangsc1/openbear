-- Budget enforcement has been removed. Remove only its obsolete model blocker;
-- preserve manual pauses, other blockers, event evidence and revision history.
UPDATE webhook_endpoints
SET model_blockers_json = json_remove(model_blockers_json, '$.budget'),
    control_version = control_version + 1
WHERE json_type(model_blockers_json, '$.budget') IS NOT NULL;
