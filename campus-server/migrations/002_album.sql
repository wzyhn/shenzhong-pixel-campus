CREATE TABLE paperplane_campus.albums (
    player_id uuid PRIMARY KEY REFERENCES paperplane_campus.players (id),
    revision bigint NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740991)
);

CREATE TABLE paperplane_campus.photos (
    player_id uuid NOT NULL REFERENCES paperplane_campus.albums (player_id),
    id uuid NOT NULL,
    version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
    metadata jsonb NOT NULL
        CHECK (jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 4096),
    png bytea NOT NULL CHECK (octet_length(png) BETWEEN 45 AND 2097152),
    PRIMARY KEY (player_id, id)
);
