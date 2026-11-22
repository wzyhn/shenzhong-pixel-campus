CREATE TABLE paperplane_campus.admin_catalogs (
    id uuid PRIMARY KEY,
    entries jsonb NOT NULL CHECK (jsonb_typeof(entries) = 'array' AND octet_length(entries::text) <= 524288),
    revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    reviewed_revision integer CHECK (reviewed_revision = revision),
    published_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE paperplane_campus.admin_settings (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    maintenance boolean NOT NULL DEFAULT false,
    active_catalog uuid REFERENCES paperplane_campus.admin_catalogs (id),
    revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0)
);
INSERT INTO paperplane_campus.admin_settings DEFAULT VALUES;

CREATE TABLE paperplane_campus.admin_bans (
    id uuid PRIMARY KEY,
    player_id uuid NOT NULL REFERENCES paperplane_campus.players (id) ON DELETE CASCADE,
    reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 200),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    ends_at timestamptz NOT NULL,
    lifted_at timestamptz,
    CHECK (ends_at > created_at)
);
CREATE INDEX admin_bans_player_idx ON paperplane_campus.admin_bans (player_id, ends_at) WHERE lifted_at IS NULL;

CREATE TABLE paperplane_campus.admin_hidden_chat (
    message_id uuid PRIMARY KEY REFERENCES paperplane_campus.chat_messages (id) ON DELETE CASCADE,
    hidden_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE paperplane_campus.admin_operations (
    id uuid PRIMARY KEY,
    actor text NOT NULL,
    request_key uuid NOT NULL,
    fingerprint bytea NOT NULL CHECK (octet_length(fingerprint) = 32),
    action text NOT NULL,
    target text,
    result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (actor, request_key)
);

CREATE TABLE paperplane_campus.admin_plans (
    id uuid PRIMARY KEY REFERENCES paperplane_campus.admin_operations (id),
    scope text NOT NULL CHECK (scope IN ('online', 'sessions', 'progress', 'players')),
    expires_at timestamptz NOT NULL,
    executed_at timestamptz
);
