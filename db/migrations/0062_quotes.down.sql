-- Down migration for 0062: drop the versioned quote tables.

DROP TABLE IF EXISTS quote_versions;
DROP TABLE IF EXISTS quotes;