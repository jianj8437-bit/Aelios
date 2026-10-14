-- October Xu Heng source rows were first written with the source's own offset ("...+08:00"). Upstream compares
-- messages.created_at with UTC day ranges as text, so store the same instant in UTC. The source ledger keeps
-- the exact event_time and is not touched.
UPDATE messages
SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)
WHERE namespace = 'xu-heng'
  AND source = 'shiyue-authoritative-chat'
  AND created_at NOT LIKE '%Z';

UPDATE conversations
SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)
WHERE namespace = 'xu-heng'
  AND id LIKE 'xh:%'
  AND created_at NOT LIKE '%Z';
