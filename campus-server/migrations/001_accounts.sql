CREATE TABLE paperplane_campus.players (
    id uuid PRIMARY KEY,
    nickname text NOT NULL CHECK (char_length(nickname) BETWEEN 1 AND 24),
    revision bigint NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740991),
    progress jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(progress) = 'object' AND octet_length(progress::text) <= 65536),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE paperplane_campus.sessions (
    token_sha256 bytea PRIMARY KEY CHECK (octet_length(token_sha256) = 32),
    player_id uuid NOT NULL REFERENCES paperplane_campus.players (id),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    CHECK (expires_at > created_at)
);

CREATE INDEX sessions_player_id_idx ON paperplane_campus.sessions (player_id);
