-- Preserve known creation dates before terminal operations expire. Imports and
-- games without a successful creation record keep an unknown date (JSON null).
UPDATE games
SET data = json_set(data, '$.addedAt', (
  SELECT MIN(COALESCE(json_extract(operations.data, '$.completedAt'), json_extract(operations.data, '$.startedAt')))
  FROM operations
  WHERE json_extract(operations.data, '$.gameId') = games.id
    AND json_extract(operations.data, '$.kind') = 'create'
    AND json_extract(operations.data, '$.status') = 'completed'
))
WHERE json_type(data, '$.addedAt') IS NULL;
