-- Restore trusted provenance lost by the old Web event adapter. Do not infer
-- events from message text and do not alter model transcripts or human replies.
UPDATE web_operations AS o
SET source='webhook', payload_json=json_set(payload_json,'$.source','webhook','$.eventTriggered',json('true'))
WHERE op_type='user_message' AND EXISTS (
  SELECT 1 FROM webhook_assignments a WHERE a.origin_kind='webhook'
    AND a.conversation_uuid=o.conversation_uuid AND o.op_id='msg:'||a.assignment_id
);
UPDATE web_operations AS o
SET payload_json=json_set(payload_json,'$.source','webhook')
WHERE op_type='run' AND EXISTS (
  SELECT 1 FROM webhook_assignments a WHERE a.origin_kind='webhook'
    AND a.conversation_uuid=o.conversation_uuid AND a.root_turn_uuid=o.turn_uuid
);
UPDATE web_operations AS o
SET payload_json=json_set(payload_json,'$.eventTriggered',json('true'))
WHERE op_type='assistant_message' AND EXISTS (
  SELECT 1 FROM webhook_assignments a WHERE a.origin_kind='webhook'
    AND a.conversation_uuid=o.conversation_uuid
    AND a.root_turn_uuid=COALESCE(NULLIF(o.run_root_turn_uuid,''),o.turn_uuid)
);
-- Reproject just affected conversations lazily under the existing tree gate.
UPDATE web_conversations SET last_interaction_at_ms=NULL
WHERE conversation_uuid IN (SELECT conversation_uuid FROM webhook_assignments WHERE origin_kind='webhook');
