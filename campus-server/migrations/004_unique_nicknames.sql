ALTER TABLE paperplane_campus.players
    ADD COLUMN nickname_key text COLLATE "C" GENERATED ALWAYS AS
        (lower(btrim(normalize(nickname, NFKC)) COLLATE "und-x-icu")) STORED,
    ADD COLUMN nickname_conflict boolean NOT NULL DEFAULT false;

WITH ranked AS (
    SELECT id, row_number() OVER (PARTITION BY nickname_key ORDER BY created_at, id) AS claim_order
    FROM paperplane_campus.players
)
UPDATE paperplane_campus.players AS player
SET nickname_conflict = true
FROM ranked
WHERE player.id = ranked.id AND ranked.claim_order > 1;

CREATE UNIQUE INDEX players_active_nickname_idx
    ON paperplane_campus.players (nickname_key)
    WHERE NOT nickname_conflict;
