CREATE TABLE paperplane_campus.chat_messages (
    id uuid PRIMARY KEY,
    player_id uuid NOT NULL REFERENCES paperplane_campus.players (id),
    request_id uuid NOT NULL,
    nickname text NOT NULL CHECK (char_length(nickname) BETWEEN 1 AND 24),
    text_sha256 bytea NOT NULL CHECK (octet_length(text_sha256) = 32),
    body text CHECK (char_length(body) BETWEEN 1 AND 40),
    published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    revoked_at timestamptz,
    UNIQUE (player_id, request_id),
    CHECK ((revoked_at IS NULL) = (body IS NOT NULL))
);

CREATE INDEX chat_recent_visible_idx ON paperplane_campus.chat_messages (published_at DESC, id DESC)
    WHERE revoked_at IS NULL;
CREATE INDEX chat_published_idx ON paperplane_campus.chat_messages (published_at);
CREATE INDEX chat_player_published_idx ON paperplane_campus.chat_messages (player_id, published_at);
